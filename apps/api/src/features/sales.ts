/* 员工销售：客户归属、销售组与阶梯规则、实收净额提成、经核验的真实兑现。
 * 调用：/admin/sales管理分工与规则，/sales查看本人业绩和已核对提成。
 * 与联盟推荐分开保存；计提只依据原业务实际现金/余额入账与退款净额。
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Headers,
  Req,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { identityProof, identityProofFields, adminActor } from './role.js';
import { Roles, interactive, type SessionRequest } from '../utils/access.js';
import { read, uuid, money, price } from '../utils/input.js';

const currency = z.string().regex(/^[A-Z]{3}$/),
  bps = z.number().int().min(0).max(10000),
  key = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const groupInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    productIds: z.array(uuid).max(500).default([]),
    newBps: bps,
    renewBps: bps,
    upgradeBps: bps,
    holdDays: z.number().int().min(0).max(365),
    active: z.boolean(),
    ...identityProofFields,
  })
  .strict();
const tierInput = z
  .object({
    groupId: uuid,
    currency,
    category: z.enum(['new', 'renew', 'upgrade']),
    thresholdCents: price,
    rateBps: bps,
    active: z.boolean(),
    ...identityProofFields,
  })
  .strict();
const withdrawalColumns =
  'w.id,w.staff_id AS "staffId",w.currency,w.amount_cents::text AS "amountCents",w.payee,w.status,w.reason,w.created_at AS "createdAt",p.reference,p.evidence_url AS "evidenceUrl",p.paid_at AS "paidAt"';
async function lock(connection: PoolClient, staff: string, code: string) {
  await connection.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`sales:${staff}:${code}`],
  );
}
const award = (basis: bigint, rate: number) => (basis * BigInt(rate)) / 10000n;
async function entries(
  connection: PoolClient,
  source: 'commission' | 'reversal' | 'payout',
  id: string,
  code: string,
  debit: string,
  credit: string,
  amount: bigint,
) {
  if (!amount) return;
  const t = (
    await connection.query(
      `INSERT INTO ledger_transactions(sales_${source}_id,currency) VALUES($1,$2) RETURNING id`,
      [id, code],
    )
  ).rows[0];
  await connection.query(
    'INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',
    [t.id, debit, amount.toString(), credit, (-amount).toString()],
  );
}
/** 与实际业务付款同事务，按当时客户归属逐成交行冻结员工、商品组与本单阶梯。 */
export async function captureSales(connection: PoolClient, invoiceId: string) {
  const targets = (
    await connection.query(
      `SELECT i.id,i.currency,i.order_id,o.kind,a.id AS assignment_id,a.staff_id,p.group_id,g.product_ids,g.new_bps,g.renew_bps,g.upgrade_bps,g.hold_days,to_char(affiliate_invoice_payment_at(i.id) AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month_key FROM invoices i JOIN orders o ON o.id=i.order_id JOIN sales_assignments a ON a.customer_id=i.user_id AND a.starts_at<=affiliate_invoice_payment_at(i.id) AND (a.ends_at IS NULL OR a.ends_at>affiliate_invoice_payment_at(i.id)) JOIN sales_people p ON p.user_id=a.staff_id AND p.enabled JOIN users staff ON staff.id=p.user_id AND NOT staff.disabled JOIN sales_groups g ON g.id=p.group_id AND g.active WHERE i.id=$1 AND i.status='paid' AND o.kind IN('new','renew','upgrade') AND affiliate_invoice_payment_at(i.id) IS NOT NULL`,
      [invoiceId],
    )
  ).rows;
  for (const target of targets) {
    await lock(connection, target.staff_id, target.currency);
    const lines = (
      await connection.query(
        'SELECT item.*,COALESCE(sum(amount_cents) OVER(ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::text AS before_cents FROM order_items item WHERE order_id=$1 ORDER BY id',
        [target.order_id],
      )
    ).rows;
    for (const line of lines) {
      if (
        BigInt(line.amount_cents) <= 0n ||
        (target.product_ids.length &&
          !target.product_ids.includes(line.product_id))
      )
        continue;
      if (
        (
          await connection.query(
            'SELECT 1 FROM sales_commissions WHERE line_id=$1',
            [line.id],
          )
        ).rowCount
      )
        continue;
      const turnover = (
        await connection.query(
          'SELECT COALESCE(sum(basis_cents-sales_line_refunded(id)),0)::text AS n FROM sales_commissions WHERE staff_id=$1 AND group_id=$2 AND currency=$3 AND month_key=$4',
          [target.staff_id, target.group_id, target.currency, target.month_key],
        )
      ).rows[0].n;
      const rate =
        (
          await connection.query(
            'SELECT rate_bps FROM sales_tiers WHERE group_id=$1 AND currency=$2 AND category=$3 AND active AND threshold_cents<=$4::bigint ORDER BY threshold_cents DESC LIMIT 1',
            [
              target.group_id,
              target.currency,
              target.kind,
              (BigInt(turnover) + BigInt(line.amount_cents)).toString(),
            ],
          )
        ).rows[0]?.rate_bps ?? target[`${target.kind}_bps`];
      await connection.query(
        `INSERT INTO sales_commissions(staff_id,assignment_id,group_id,invoice_id,line_id,product_name,currency,category,month_key,basis_cents,before_cents,rate_bps,hold_days,paid_at,release_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,affiliate_invoice_payment_at($4),affiliate_invoice_payment_at($4)+make_interval(days=>$13)) ON CONFLICT(line_id) DO NOTHING`,
        [
          target.staff_id,
          target.assignment_id,
          target.group_id,
          invoiceId,
          line.id,
          line.product_name,
          target.currency,
          target.kind,
          target.month_key,
          line.amount_cents,
          line.before_cents,
          rate,
          target.hold_days,
        ],
      );
    }
  }
}
/** 只核对一个员工的一种币种；锁序固定为员工币种→原收款→提成→审计。 */
export async function synchronizeSales(
  connection: PoolClient,
  staff: string,
  code: string,
  actor: string,
) {
  await lock(connection, staff, code);
  const rows = (
    await connection.query(
      `SELECT c.id,c.invoice_id FROM sales_commissions c WHERE c.staff_id=$1 AND c.currency=$2 AND ((c.status='pending' AND c.release_at<=now()) OR(c.status='released' AND EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.status='succeeded' AND NOT f.id=ANY(c.recognized_refund_ids) AND NOT EXISTS(SELECT 1 FROM sales_reversals r WHERE r.commission_id=c.id AND r.refund_id=f.id)))) ORDER BY c.invoice_id,c.line_id LIMIT 200`,
      [staff, code],
    )
  ).rows;
  for (const target of rows) {
    await connection.query(
      'SELECT p.id FROM payment_receipts p WHERE p.invoice_id=$1 OR p.invoice_id IN(SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=$1 AND locked) ORDER BY p.id FOR UPDATE',
      [target.invoice_id],
    );
    const c = (
        await connection.query(
          'SELECT * FROM sales_commissions WHERE id=$1 FOR UPDATE',
          [target.id],
        )
      ).rows[0],
      refunds = (
        await connection.query(
          "SELECT id,amount_cents::text,status FROM affiliate_invoice_refunds($1) WHERE status NOT IN('rejected','failed') ORDER BY ordinal NULLS LAST,id",
          [target.invoice_id],
        )
      ).rows;
    if (c.status === 'pending') {
      if (
        new Date(c.release_at).getTime() > Date.now() ||
        refunds.some((f) => f.status !== 'succeeded')
      )
        continue;
      const ids = refunds.map((f) => f.id),
        refunded = (
          await connection.query('SELECT sales_line_refunded($1,$2) AS n', [
            c.id,
            ids,
          ])
        ).rows[0].n,
        net = BigInt(c.basis_cents) - BigInt(refunded),
        amount = award(net, c.rate_bps);
      await connection.query(
        'UPDATE sales_commissions SET status=$2,net_basis_cents=$3,released_cents=$4,recognized_refund_ids=$5,released_at=now() WHERE id=$1',
        [
          c.id,
          amount ? 'released' : 'void',
          net.toString(),
          amount.toString(),
          ids,
        ],
      );
      await entries(
        connection,
        'commission',
        c.id,
        code,
        'expense:sales',
        `sales:${staff}`,
        amount,
      );
      await record(connection, actor, 'sales.release', c.id, {
        invoiceId: c.invoice_id,
        currency: code,
        amountCents: amount.toString(),
      });
      continue;
    }
    const previous = (
        await connection.query(
          'SELECT refund_id,basis_after_cents::text FROM sales_reversals WHERE commission_id=$1 ORDER BY position',
          [c.id],
        )
      ).rows,
      recognized = new Set<string>([
        ...c.recognized_refund_ids,
        ...previous.map((r) => r.refund_id),
      ]);
    let basis = BigInt(previous.at(-1)?.basis_after_cents ?? c.net_basis_cents);
    for (const refund of refunds.filter(
      (f) => f.status === 'succeeded' && !recognized.has(f.id),
    )) {
      recognized.add(refund.id);
      const refunded = (
          await connection.query('SELECT sales_line_refunded($1,$2) AS n', [
            c.id,
            [...recognized],
          ])
        ).rows[0].n,
        after = BigInt(c.basis_cents) - BigInt(refunded),
        amount = award(basis, c.rate_bps) - award(after, c.rate_bps),
        row = (
          await connection.query(
            'INSERT INTO sales_reversals(commission_id,refund_id,amount_cents,basis_before_cents,basis_after_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',
            [
              c.id,
              refund.id,
              amount.toString(),
              basis.toString(),
              after.toString(),
            ],
          )
        ).rows[0];
      await entries(
        connection,
        'reversal',
        row.id,
        code,
        `sales:${staff}`,
        'expense:sales',
        amount,
      );
      await record(connection, actor, 'sales.reverse', row.id, {
        commissionId: c.id,
        refundId: refund.id,
        currency: code,
        amountCents: amount.toString(),
      });
      basis = after;
    }
  }
}
async function balance(connection: PoolClient, staff: string, code: string) {
  const row = (
      await connection.query(
        `SELECT (-COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='sales:'||$1::text AND t.currency=$2),0))::text AS "balanceCents",COALESCE((SELECT sum(amount_cents) FROM sales_withdrawals WHERE staff_id=$1::uuid AND currency=$2 AND status='pending'),0)::text AS "reservedCents",COALESCE((SELECT sum(floor(basis_cents::numeric*rate_bps/10000)) FROM sales_commissions WHERE staff_id=$1::uuid AND currency=$2 AND status='pending'),0)::text AS "pendingCents",EXISTS(SELECT 1 FROM sales_commissions c CROSS JOIN LATERAL affiliate_invoice_refunds(c.invoice_id) f WHERE c.staff_id=$1::uuid AND c.currency=$2 AND c.status='released' AND f.status NOT IN('succeeded','rejected','failed')) AS "refundPending"`,
        [staff, code],
      )
    ).rows[0],
    available = BigInt(row.balanceCents) - BigInt(row.reservedCents);
  return {
    ...row,
    currency: code,
    availableCents: (row.refundPending || available < 0n
      ? 0n
      : available
    ).toString(),
  };
}
async function active(connection: PoolClient, request: SessionRequest) {
  interactive(request);
  if (
    !(
      await connection.query(
        'SELECT 1 FROM sales_people p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.enabled AND NOT u.disabled',
        [request.user.id],
      )
    ).rowCount
  )
    throw new ForbiddenException('当前账号未启用员工销售');
}
async function existsCurrency(connection: PoolClient, code: string) {
  if (
    !(
      await connection.query(
        'SELECT 1 FROM currencies WHERE code=$1 AND active',
        [code],
      )
    ).rowCount
  )
    throw new ConflictException('请选择启用的币种');
}

@Controller()
@Roles('admin', 'support')
export default class Sales {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.run().catch((e) =>
          console.error(
            JSON.stringify({
              feature: 'sales',
              error: e instanceof Error ? e.message : '销售计提失败',
            }),
          ),
        ),
      60000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async run() {
    if (this.running) return 0;
    this.running = true;
    try {
      const staff = (
        await pool.query(
          "SELECT DISTINCT c.staff_id,c.currency FROM sales_commissions c WHERE (c.status='pending' AND c.release_at<=now()) OR(c.status='released' AND EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.status='succeeded' AND NOT f.id=ANY(c.recognized_refund_ids) AND NOT EXISTS(SELECT 1 FROM sales_reversals r WHERE r.commission_id=c.id AND r.refund_id=f.id))) ORDER BY c.staff_id,c.currency LIMIT 50",
        )
      ).rows;
      for (const row of staff)
        await transaction((c) =>
          synchronizeSales(c, row.staff_id, row.currency, 'sales:worker'),
        );
      return staff.length;
    } finally {
      this.running = false;
    }
  }
  @Get('sales') async get(@Req() request: SessionRequest) {
    return transaction(async (c) => {
      await active(c, request);
      const codes = (
          await c.query(
            'SELECT DISTINCT currency FROM sales_commissions WHERE staff_id=$1 ORDER BY currency',
            [request.user.id],
          )
        ).rows,
        balances = [];
      for (const row of codes) {
        await synchronizeSales(
          c,
          request.user.id,
          row.currency,
          request.actorId ?? request.user.id,
        );
        balances.push(await balance(c, request.user.id, row.currency));
      }
      return {
        balances,
        profile: (
          await c.query(
            'SELECT p.group_id AS "groupId",g.name AS "groupName",p.enabled FROM sales_people p JOIN sales_groups g ON g.id=p.group_id WHERE p.user_id=$1',
            [request.user.id],
          )
        ).rows[0],
      };
    });
  }
  @Get('sales/customers') async customers(@Req() request: SessionRequest) {
    interactive(request);
    return (
      await pool.query(
        'SELECT u.id,u.name,u.email,u.company,a.starts_at AS "assignedAt" FROM sales_assignments a JOIN users u ON u.id=a.customer_id WHERE a.staff_id=$1 AND a.ends_at IS NULL ORDER BY a.starts_at DESC LIMIT 200',
        [request.user.id],
      )
    ).rows;
  }
  @Get('sales/commissions') async commissions(@Req() request: SessionRequest) {
    interactive(request);
    return (
      await pool.query(
        'SELECT c.id,c.product_name AS "productName",c.invoice_id AS "invoiceId",i.number::text AS "invoiceNumber",c.currency,c.category,c.month_key AS "month",c.basis_cents::text AS "basisCents",c.rate_bps AS "rateBps",c.released_cents::text AS "releasedCents",COALESCE((SELECT sum(amount_cents) FROM sales_reversals WHERE commission_id=c.id),0)::text AS "reversedCents",c.status,c.release_at AS "releaseAt" FROM sales_commissions c JOIN invoices i ON i.id=c.invoice_id WHERE c.staff_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 200',
        [request.user.id],
      )
    ).rows;
  }
  @Get('sales/withdrawals') async withdrawals(@Req() request: SessionRequest) {
    interactive(request);
    return (
      await pool.query(
        `SELECT ${withdrawalColumns} FROM sales_withdrawals w LEFT JOIN sales_payouts p ON p.withdrawal_id=w.id WHERE w.staff_id=$1 ORDER BY w.created_at DESC LIMIT 100`,
        [request.user.id],
      )
    ).rows;
  }
  @Post('sales/withdrawals') async withdraw(
    @Body() body: unknown,
    @Headers('idempotency-key') token: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
        z
          .object({
            currency,
            amountCents: money,
            payee: z
              .object({
                method: z.enum(['bank', 'alipay', 'wechat']),
                name: z.string().trim().min(1).max(100),
                account: z.string().trim().min(1).max(200),
              })
              .strict(),
            ...identityProofFields,
          })
          .strict(),
        body,
      ),
      idempotency = read(key, token),
      fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            currency: input.currency,
            amount: input.amountCents,
            payee: input.payee,
          }),
        )
        .digest('hex');
    await identityProof(request, input, 'sales.withdraw');
    return transaction(async (c) => {
      await active(c, request);
      await lock(c, request.user.id, input.currency);
      const prior = (
        await c.query(
          'SELECT id,request_hash FROM sales_withdrawals WHERE staff_id=$1 AND idempotency_key=$2',
          [request.user.id, idempotency],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new ConflictException('提交标识已用于其他申请');
        return { id: prior.id };
      }
      await synchronizeSales(
        c,
        request.user.id,
        input.currency,
        request.user.id,
      );
      const funds = await balance(c, request.user.id, input.currency);
      if (BigInt(input.amountCents) > BigInt(funds.availableCents))
        throw new ConflictException('可用销售提成不足或相关订单正在退款');
      const row = (
        await c.query(
          'INSERT INTO sales_withdrawals(staff_id,currency,amount_cents,payee,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [
            request.user.id,
            input.currency,
            input.amountCents,
            input.payee,
            idempotency,
            fingerprint,
          ],
        )
      ).rows[0];
      await record(c, request.user.id, 'sales.withdraw.request', row.id, {
        currency: input.currency,
        amountCents: input.amountCents,
        method: input.payee.method,
      });
      return row;
    });
  }
  @Post('sales/withdrawals/:id/cancel') async cancel(
    @Param('id') id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    interactive(request);
    return transaction(async (c) => {
      const prior = (
        await c.query(
          'SELECT currency FROM sales_withdrawals WHERE id=$1 AND staff_id=$2',
          [id, request.user.id],
        )
      ).rows[0];
      if (!prior) throw new NotFoundException('申请不存在');
      await lock(c, request.user.id, prior.currency);
      if (
        !(
          await c.query(
            "UPDATE sales_withdrawals SET status='cancelled',handled_at=now() WHERE id=$1 AND staff_id=$2 AND status='pending' RETURNING id",
            [id, request.user.id],
          )
        ).rowCount
      )
        throw new ConflictException('只能撤回本人待处理申请');
      await record(c, request.user.id, 'sales.withdraw.cancel', id, {});
      return { ok: true };
    });
  }
  @Roles('admin') @Get('admin/sales') async all() {
    const [
      groups,
      tiers,
      people,
      assignments,
      withdrawals,
      clients,
      staff,
      products,
    ] = await Promise.all([
      pool.query(
        'SELECT id,name,product_ids AS "productIds",new_bps AS "newBps",renew_bps AS "renewBps",upgrade_bps AS "upgradeBps",hold_days AS "holdDays",active FROM sales_groups ORDER BY name',
      ),
      pool.query(
        'SELECT id,group_id AS "groupId",currency,category,threshold_cents::text AS "thresholdCents",rate_bps AS "rateBps",active FROM sales_tiers ORDER BY group_id,currency,category,threshold_cents',
      ),
      pool.query(
        'SELECT p.user_id AS id,u.name,u.email,p.group_id AS "groupId",p.enabled FROM sales_people p JOIN users u ON u.id=p.user_id ORDER BY u.name',
      ),
      pool.query(
        'SELECT a.id,a.customer_id AS "customerId",a.staff_id AS "staffId",u.name,u.email,a.starts_at AS "startsAt" FROM sales_assignments a JOIN users u ON u.id=a.customer_id WHERE a.ends_at IS NULL ORDER BY a.starts_at DESC LIMIT 500',
      ),
      pool.query(
        `SELECT ${withdrawalColumns},u.email FROM sales_withdrawals w JOIN users u ON u.id=w.staff_id LEFT JOIN sales_payouts p ON p.withdrawal_id=w.id ORDER BY w.created_at DESC LIMIT 100`,
      ),
      pool.query(
        "SELECT id,name,email FROM users u WHERE role='customer' AND NOT EXISTS(SELECT 1 FROM contacts WHERE child_user_id=u.id) ORDER BY name LIMIT 2000",
      ),
      pool.query(
        "SELECT id,name,email FROM users WHERE role IN('admin','support') AND NOT disabled ORDER BY name",
      ),
      pool.query('SELECT id,name FROM products ORDER BY name'),
    ]);
    return {
      groups: groups.rows,
      tiers: tiers.rows,
      people: people.rows,
      assignments: assignments.rows,
      withdrawals: withdrawals.rows,
      clients: clients.rows,
      staff: staff.rows,
      products: products.rows,
    };
  }
  @Roles('admin') @Post('admin/sales/groups') createGroup(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    return this.saveGroup(null, body, request);
  }
  @Roles('admin') @Put('admin/sales/groups/:id') updateGroup(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    return this.saveGroup(id, body, request);
  }
  private async saveGroup(
    id: string | null,
    body: unknown,
    request: SessionRequest,
  ) {
    const input = read(groupInput, body);
    await identityProof(request, input, 'sales.group');
    return transaction(async (c) => {
      const actor = await adminActor(c, request);
      if (
        input.productIds.length &&
        (
          await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[])', [
            input.productIds,
          ])
        ).rowCount !== new Set(input.productIds).size
      )
        throw new ConflictException('商品列表已变化');
      const values = [
          input.name,
          [...new Set(input.productIds)],
          input.newBps,
          input.renewBps,
          input.upgradeBps,
          input.holdDays,
          input.active,
        ],
        row = (
          id
            ? await c.query(
                'UPDATE sales_groups SET name=$1,product_ids=$2,new_bps=$3,renew_bps=$4,upgrade_bps=$5,hold_days=$6,active=$7 WHERE id=$8 RETURNING id',
                [...values, id],
              )
            : await c.query(
                'INSERT INTO sales_groups(name,product_ids,new_bps,renew_bps,upgrade_bps,hold_days,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
                values,
              )
        ).rows[0];
      if (!row) throw new NotFoundException('销售组不存在');
      await record(c, actor.id, 'sales.group.save', row.id, {
        productIds: input.productIds,
        newBps: input.newBps,
        renewBps: input.renewBps,
        upgradeBps: input.upgradeBps,
      });
      return row;
    });
  }
  @Roles('admin') @Delete('admin/sales/groups/:id') async deleteGroup(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const proof = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, proof, 'sales.group.delete');
    return transaction(async (c) => {
      const actor = await adminActor(c, request);
      if (
        (
          await c.query(
            'SELECT 1 FROM sales_people WHERE group_id=$1 UNION ALL SELECT 1 FROM sales_commissions WHERE group_id=$1',
            [id],
          )
        ).rowCount
      )
        throw new ConflictException('已有员工或提成记录，请停用此组');
      await c.query('DELETE FROM sales_tiers WHERE group_id=$1', [id]);
      if (
        !(
          await c.query('DELETE FROM sales_groups WHERE id=$1 RETURNING id', [
            id,
          ])
        ).rowCount
      )
        throw new NotFoundException('销售组不存在');
      await record(c, actor.id, 'sales.group.delete', id, {});
      return { ok: true };
    });
  }
  @Roles('admin') @Post('admin/sales/tiers') async tier(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(tierInput, body);
    await identityProof(request, input, 'sales.tier');
    return transaction(async (c) => {
      const actor = await adminActor(c, request);
      await existsCurrency(c, input.currency);
      const row = (
        await c.query(
          'INSERT INTO sales_tiers(group_id,currency,category,threshold_cents,rate_bps,active) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(group_id,currency,category,threshold_cents) DO UPDATE SET rate_bps=EXCLUDED.rate_bps,active=EXCLUDED.active RETURNING id',
          [
            input.groupId,
            input.currency,
            input.category,
            input.thresholdCents,
            input.rateBps,
            input.active,
          ],
        )
      ).rows[0];
      await record(c, actor.id, 'sales.tier.save', row.id, {
        currency: input.currency,
        thresholdCents: input.thresholdCents,
        rateBps: input.rateBps,
      });
      return row;
    });
  }
  @Roles('admin') @Delete('admin/sales/tiers/:id') async deleteTier(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const proof = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, proof, 'sales.tier.delete');
    return transaction(async (c) => {
      const actor = await adminActor(c, request);
      if (
        !(
          await c.query('DELETE FROM sales_tiers WHERE id=$1 RETURNING id', [
            id,
          ])
        ).rowCount
      )
        throw new NotFoundException('阶梯不存在');
      await record(c, actor.id, 'sales.tier.delete', id, {});
      return { ok: true };
    });
  }
  @Roles('admin') @Put('admin/sales/people/:id') async person(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({ groupId: uuid, enabled: z.boolean(), ...identityProofFields })
        .strict(),
      body,
    );
    await identityProof(request, input, 'sales.person');
    return transaction(async (c) => {
      const actor = await adminActor(c, request);
      if (
        !(
          await c.query(
            "SELECT 1 FROM users WHERE id=$1 AND role IN('admin','support') AND NOT disabled",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException('请选择启用的管理员或客服');
      if (
        !(
          await c.query('SELECT 1 FROM sales_groups WHERE id=$1', [
            input.groupId,
          ])
        ).rowCount
      )
        throw new NotFoundException('销售组不存在');
      await c.query(
        'INSERT INTO sales_people(user_id,group_id,enabled) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET group_id=EXCLUDED.group_id,enabled=EXCLUDED.enabled',
        [id, input.groupId, input.enabled],
      );
      await record(c, actor.id, 'sales.person.save', id, {
        groupId: input.groupId,
        enabled: input.enabled,
      });
      return { ok: true };
    });
  }
  @Roles('admin') @Post('admin/sales/assignments') async assign(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
      z
        .object({
          customerId: uuid,
          staffId: uuid.nullable(),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'sales.assign');
    return transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `sales-assignment:${input.customerId}`,
      ]);
      const actor = await adminActor(c, request);
      if (
        !(
          await c.query(
            "SELECT 1 FROM users u WHERE id=$1 AND role='customer' AND NOT EXISTS(SELECT 1 FROM contacts WHERE child_user_id=u.id)",
            [input.customerId],
          )
        ).rowCount
      )
        throw new NotFoundException('客户不存在');
      if (
        input.staffId &&
        !(
          await c.query(
            'SELECT 1 FROM sales_people WHERE user_id=$1 AND enabled',
            [input.staffId],
          )
        ).rowCount
      )
        throw new ConflictException('请选择启用的销售员工');
      await c.query(
        'UPDATE sales_assignments SET ends_at=now() WHERE customer_id=$1 AND ends_at IS NULL',
        [input.customerId],
      );
      if (input.staffId)
        await c.query(
          'INSERT INTO sales_assignments(customer_id,staff_id,assigned_by) VALUES($1,$2,$3)',
          [input.customerId, input.staffId, actor.id],
        );
      await record(c, actor.id, 'sales.assign', input.customerId, {
        staffId: input.staffId,
      });
      return { ok: true };
    });
  }
  @Roles('admin') @Post('admin/sales/withdrawals/:id/process') async process(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({
          action: z.enum(['pay', 'reject']),
          reason: z.string().trim().max(1000).default(''),
          reference: z.string().trim().min(1).max(200).optional(),
          paidAt: z.iso.datetime().optional(),
          evidenceUrl: z
            .url()
            .refine((v) => new URL(v).protocol === 'https:')
            .optional(),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    if (input.action === 'pay' && (!input.reference || !input.paidAt))
      throw new ConflictException('请填写实际打款凭据与时间');
    if (input.action === 'reject' && !input.reason)
      throw new ConflictException('请填写驳回原因');
    await identityProof(request, input, 'sales.payout');
    return transaction(async (c) => {
      const actor = await adminActor(c, request),
        target = (
          await c.query(
            'SELECT staff_id,currency FROM sales_withdrawals WHERE id=$1',
            [id],
          )
        ).rows[0];
      if (!target) throw new NotFoundException('申请不存在');
      await lock(c, target.staff_id, target.currency);
      await synchronizeSales(c, target.staff_id, target.currency, actor.id);
      const w = (
        await c.query(
          'SELECT * FROM sales_withdrawals WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (w.status !== 'pending') {
        if (input.action === 'reject' && w.status === 'rejected')
          return { ok: true };
        if (input.action === 'pay' && w.status === 'paid') {
          const p = (
            await c.query(
              'SELECT reference,paid_at FROM sales_payouts WHERE withdrawal_id=$1',
              [id],
            )
          ).rows[0];
          if (
            p.reference === input.reference &&
            new Date(p.paid_at).toISOString() ===
              new Date(input.paidAt!).toISOString()
          )
            return { ok: true };
        }
        throw new ConflictException('申请已处理，请核对原记录');
      }
      if (input.action === 'pay') {
        const funds = await balance(c, w.staff_id, w.currency);
        if (
          funds.refundPending ||
          BigInt(funds.balanceCents) < BigInt(funds.reservedCents)
        )
          throw new ConflictException('提成受到退款影响，请先核对');
        const p = (
          await c.query(
            'INSERT INTO sales_payouts(withdrawal_id,staff_id,amount_cents,currency,channel,reference,evidence_url,paid_at,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
            [
              id,
              w.staff_id,
              w.amount_cents,
              w.currency,
              w.payee.method,
              input.reference,
              input.evidenceUrl ?? null,
              input.paidAt,
              actor.id,
            ],
          )
        ).rows[0];
        await entries(
          c,
          'payout',
          p.id,
          w.currency,
          `sales:${w.staff_id}`,
          `cash:sales-payout:${w.payee.method}`,
          BigInt(w.amount_cents),
        );
      }
      await c.query(
        'UPDATE sales_withdrawals SET status=$2,reason=$3,handled_by=$4,handled_at=now() WHERE id=$1',
        [
          id,
          input.action === 'pay' ? 'paid' : 'rejected',
          input.reason,
          actor.id,
        ],
      );
      await record(c, actor.id, `sales.payout.${input.action}`, id, {
        currency: w.currency,
        amountCents: w.amount_cents,
        reference: input.reference,
      });
      return { ok: true };
    });
  }
}
