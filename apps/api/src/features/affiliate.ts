/* 联盟推荐：注册归因、真实已付账单计佣、等待期释放、退款冲回、转余额和现金提现。
 * 调用：/affiliates；POST /affiliates/activate；POST /affiliates/settle；POST /affiliates/transfers 或 withdrawals。
 * 对外打款只由管理员密码/MFA登记实际凭据；本主体不调用任何外部付款接口。
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Headers,
  Query,
  Req,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Roles, interactive, type SessionRequest } from '../utils/access.js';
import { read, uuid, money, price } from '../utils/input.js';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { identityProof, identityProofFields, adminActor } from './role.js';

const referralCode = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const rule = z
  .object({ kind: z.enum(['percent', 'fixed']), value: price })
  .strict()
  .refine(
    (value) => value.kind !== 'percent' || BigInt(value.value) <= 10000n,
    '百分比以万分比填写，不能超过10000',
  );
const settingsInput = z
  .object({
    enabled: z.boolean(),
    initialRule: rule,
    renewalRule: rule,
    reorderRule: rule,
    holdDays: z.number().int().min(0).max(365),
    minimumWithdrawCents: money,
    ...identityProofFields,
  })
  .strict();
const pageInput = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
const keyInput = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const withdrawalColumns =
  'w.id,w.user_id AS "userId",w.amount_cents::text AS "amountCents",w.currency,w.payee,w.status,w.decision_reason AS "decisionReason",w.created_at AS "createdAt",w.handled_at AS "handledAt",p.channel,p.reference,p.evidence_url AS "evidenceUrl",p.paid_at AS "paidAt"';

/** 注册事务内绑定首次归因；已有用户不能事后挂靠推荐人。 */
export async function attachReferral(
  connection: PoolClient,
  userId: string,
  code?: string,
) {
  if (!code) return;
  const affiliate = (
    await connection.query(
      'SELECT a.user_id FROM affiliates a JOIN users u ON u.id=a.user_id CROSS JOIN affiliate_settings s WHERE a.code=$1 AND a.enabled AND NOT u.disabled AND s.enabled',
      [read(referralCode, code)],
    )
  ).rows[0];
  if (!affiliate)
    throw new BadRequestException('推荐链接当前不可用，请核对后再注册');
  if (affiliate.user_id === userId)
    throw new ForbiddenException('不能推荐自己');
  await connection.query(
    'INSERT INTO affiliate_referrals(user_id,affiliate_id) VALUES($1,$2)',
    [userId, affiliate.user_id],
  );
}

/** 付款事务内保留当次佣金规则；只有真实业务账单入账后才能形成待释放佣金。 */
export async function captureCommission(
  connection: PoolClient,
  invoiceId: string,
) {
  const buyer = (
    await connection.query('SELECT user_id FROM invoices WHERE id=$1', [
      invoiceId,
    ])
  ).rows[0];
  if (!buyer) return;
  await connection.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`affiliate-sale:${buyer.user_id}`],
  ); // 并发首购只有一笔使用首购规则
  const found = await connection.query(
    `SELECT i.*,affiliate_invoice_payment_at(i.id) AS cash_paid_at,o.kind,r.affiliate_id,s.initial_rule,s.renewal_rule,s.reorder_rule,s.hold_days,
    EXISTS(SELECT 1 FROM affiliate_commissions previous WHERE previous.user_id=i.user_id AND previous.category IN('initial','reorder')) AS repeat_purchase
    FROM invoices i JOIN orders o ON o.id=i.order_id JOIN affiliate_referrals r ON r.user_id=i.user_id JOIN affiliates a ON a.user_id=r.affiliate_id JOIN users u ON u.id=a.user_id CROSS JOIN affiliate_settings s
    WHERE i.id=$1 AND i.currency='CNY' AND i.status='paid' AND i.amount_cents>0 AND i.paid_at>=r.created_at AND o.kind IN('new','renew','upgrade') AND a.enabled AND NOT u.disabled AND s.enabled
    AND affiliate_invoice_payment_at(i.id) IS NOT NULL`,
    [invoiceId],
  );
  if (!found.rowCount) return;
  const invoice = found.rows[0],
    category =
      invoice.kind === 'renew'
        ? 'renewal'
        : invoice.repeat_purchase
          ? 'reorder'
          : 'initial';
  const selected = invoice[`${category}_rule`];
  await connection.query(
    `INSERT INTO affiliate_commissions(affiliate_id,user_id,invoice_id,category,rule,quoted_cents,release_at) VALUES($1,$2,$3,$4,$5,affiliate_entitlement($5,$6::bigint),affiliate_invoice_payment_at($3)+make_interval(days=>$7)) ON CONFLICT(invoice_id) DO NOTHING`,
    [
      invoice.affiliate_id,
      invoice.user_id,
      invoice.id,
      category,
      selected,
      invoice.amount_cents,
      invoice.hold_days,
    ],
  );
}

function entitlement(rule: { kind: string; value: string }, basis: bigint) {
  if (basis <= 0n) return 0n;
  const amount =
    rule.kind === 'fixed'
      ? BigInt(rule.value)
      : (basis * BigInt(rule.value)) / 10000n;
  return amount > basis ? basis : amount;
}
async function affiliateLock(connection: PoolClient, id: string) {
  await connection.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`affiliate:${id}`],
  );
}
async function entries(
  connection: PoolClient,
  source: 'commission' | 'reversal' | 'transfer' | 'payout',
  id: string,
  debit: string,
  credit: string,
  amount: bigint,
) {
  if (!amount) return;
  const ledger = await connection.query(
    `INSERT INTO ledger_transactions(affiliate_${source}_id,currency) VALUES($1,'CNY') RETURNING id`,
    [id],
  );
  await connection.query(
    'INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',
    [ledger.rows[0].id, debit, amount.toString(), credit, (-amount).toString()],
  );
}

/** 持推荐人锁后按收款→佣金顺序结算；退款只冲回佣金负债，不扣客户钱包。 */
export async function synchronizeAffiliate(
  connection: PoolClient,
  affiliateId: string,
  actor: string,
) {
  await affiliateLock(connection, affiliateId);
  const commissions = await connection.query(
    `SELECT c.id,c.invoice_id FROM affiliate_commissions c WHERE c.affiliate_id=$1 AND (
      (c.status='pending' AND c.release_at<=now()) OR (c.status='released' AND EXISTS(
        SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) r WHERE r.status='succeeded'
        AND NOT r.id=ANY(c.recognized_refund_ids) AND NOT EXISTS(SELECT 1 FROM affiliate_reversals x WHERE x.refund_id=r.id AND x.commission_id=c.id))))
      ORDER BY c.invoice_id,c.id LIMIT 200`,
    [affiliateId],
  );
  for (const target of commissions.rows) {
    await connection.query(
      'SELECT p.id FROM payment_receipts p WHERE p.invoice_id=$1 OR p.invoice_id IN(SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=$1 AND locked) ORDER BY p.id FOR UPDATE',
      [target.invoice_id],
    );
    const commission = (
      await connection.query(
        'SELECT * FROM affiliate_commissions WHERE id=$1 FOR UPDATE',
        [target.id],
      )
    ).rows[0];
    const refunds = (
      await connection.query(
        "SELECT f.id,f.amount_cents::text,f.status FROM affiliate_invoice_refunds($1) f WHERE f.status NOT IN('rejected','failed') ORDER BY f.ordinal NULLS LAST,f.id",
        [target.invoice_id],
      )
    ).rows;
    if (commission.status === 'pending') {
      if (
        Date.parse(commission.release_at) > Date.now() ||
        refunds.some((item) => item.status !== 'succeeded')
      )
        continue;
      const paid = (
        await connection.query(
          'SELECT amount_cents::text FROM invoices WHERE id=$1',
          [target.invoice_id],
        )
      ).rows[0];
      const net =
          BigInt(paid.amount_cents) -
          refunds.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n),
        amount = entitlement(commission.rule, net);
      await connection.query(
        'UPDATE affiliate_commissions SET status=$2,net_basis_cents=$3,released_cents=$4,recognized_refund_ids=$5,released_at=now() WHERE id=$1',
        [
          commission.id,
          amount ? 'released' : 'void',
          net.toString(),
          amount.toString(),
          refunds.map((item) => item.id),
        ],
      );
      await entries(
        connection,
        'commission',
        commission.id,
        'expense:affiliate',
        `affiliate:${affiliateId}`,
        amount,
      );
      await record(connection, actor, 'affiliate.release', commission.id, {
        invoiceId: commission.invoice_id,
        netBasisCents: net.toString(),
        amountCents: amount.toString(),
      });
      continue;
    }
    if (commission.status !== 'released') continue;
    const recognized = new Set<string>(commission.recognized_refund_ids),
      reversals = (
        await connection.query(
          'SELECT r.refund_id,r.basis_after_cents::text FROM affiliate_reversals r WHERE commission_id=$1 ORDER BY position',
          [commission.id],
        )
      ).rows;
    for (const prior of reversals) recognized.add(prior.refund_id);
    let basis = BigInt(
      reversals.at(-1)?.basis_after_cents ?? commission.net_basis_cents,
    );
    for (const refund of refunds.filter(
      (item) => item.status === 'succeeded' && !recognized.has(item.id),
    )) {
      const after =
          basis > BigInt(refund.amount_cents)
            ? basis - BigInt(refund.amount_cents)
            : 0n,
        amount =
          entitlement(commission.rule, basis) -
          entitlement(commission.rule, after);
      const reversal = (
        await connection.query(
          'INSERT INTO affiliate_reversals(commission_id,refund_id,amount_cents,basis_before_cents,basis_after_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [
            commission.id,
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
        reversal.id,
        `affiliate:${affiliateId}`,
        'expense:affiliate',
        amount,
      );
      await record(connection, actor, 'affiliate.reverse', reversal.id, {
        commissionId: commission.id,
        refundId: refund.id,
        amountCents: amount.toString(),
      });
      basis = after;
    }
  }
}

async function balance(connection: PoolClient, id: string) {
  const found = (
    await connection.query(
      `SELECT (-COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='affiliate:'||$1::text AND t.currency='CNY'),0))::text AS "balanceCents",
    COALESCE((SELECT sum(amount_cents) FROM affiliate_withdrawals WHERE user_id=$1::uuid AND status='pending'),0)::text AS "reservedCents",
    COALESCE((SELECT sum(quoted_cents) FROM affiliate_commissions WHERE affiliate_id=$1::uuid AND status='pending'),0)::text AS "pendingCents",
    EXISTS(SELECT 1 FROM affiliate_commissions c CROSS JOIN LATERAL affiliate_invoice_refunds(c.invoice_id) r WHERE c.affiliate_id=$1::uuid AND c.status='released' AND r.status NOT IN('succeeded','rejected','failed')) AS "refundPending"`,
      [id],
    )
  ).rows[0];
  const available = BigInt(found.balanceCents) - BigInt(found.reservedCents);
  return {
    ...found,
    availableCents: (found.refundPending || available < 0n
      ? 0n
      : available
    ).toString(),
    currency: 'CNY',
  };
}
async function active(connection: PoolClient, request: SessionRequest) {
  interactive(request);
  const found = await connection.query(
    'SELECT a.user_id FROM affiliates a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND a.enabled AND NOT u.disabled',
    [request.user.id],
  );
  if (!found.rowCount)
    throw new ForbiddenException('请先启用联盟推荐，或联系管理员核对当前状态');
}
async function idempotent(
  connection: PoolClient,
  source: 'transfers' | 'withdrawals',
  id: string,
  key: string,
  fingerprint: string,
) {
  const found = (
    await connection.query(
      `SELECT id,request_hash FROM affiliate_${source} WHERE user_id=$1 AND idempotency_key=$2`,
      [id, key],
    )
  ).rows[0];
  if (found && found.request_hash !== fingerprint)
    throw new ConflictException('此提交标识已经用于另一份申请');
  return found;
}

@Controller()
@Roles('customer')
export default class Affiliate {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.run().catch((error) =>
          console.error(
            JSON.stringify({
              feature: 'affiliate',
              error: error instanceof Error ? error.message : '佣金核对失败',
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
  /** 每轮最多核对50位推荐人；事实仍由PostgreSQL持久化，多进程共享同一佣金锁。 */
  async run() {
    if (this.running) return 0;
    this.running = true;
    try {
      const targets = await pool.query(
        `SELECT DISTINCT c.affiliate_id FROM affiliate_commissions c WHERE (c.status='pending' AND c.release_at<=now()) OR (c.status='released' AND EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) r WHERE r.status='succeeded' AND NOT r.id=ANY(c.recognized_refund_ids) AND NOT EXISTS(SELECT 1 FROM affiliate_reversals x WHERE x.refund_id=r.id AND x.commission_id=c.id))) ORDER BY c.affiliate_id LIMIT 50`,
      );
      for (const target of targets.rows)
        await transaction((connection) =>
          synchronizeAffiliate(
            connection,
            target.affiliate_id,
            'affiliate:worker',
          ),
        );
      return targets.rowCount;
    } finally {
      this.running = false;
    }
  }
  @Get('affiliates') async get(@Req() request: SessionRequest) {
    interactive(request);
    return transaction(async (connection) => {
      const profile =
        (
          await connection.query(
            'SELECT user_id AS "userId",code,enabled,created_at AS "createdAt" FROM affiliates WHERE user_id=$1',
            [request.user.id],
          )
        ).rows[0] ?? null;
      const settings = (
        await connection.query(
          'SELECT enabled,initial_rule AS "initialRule",renewal_rule AS "renewalRule",reorder_rule AS "reorderRule",hold_days AS "holdDays",minimum_withdraw_cents::text AS "minimumWithdrawCents" FROM affiliate_settings',
        )
      ).rows[0];
      if (profile)
        await synchronizeAffiliate(
          connection,
          request.user.id,
          request.actorId ?? request.user.id,
        );
      const totals = await balance(connection, request.user.id),
        count = (
          await connection.query(
            'SELECT count(*)::int AS n FROM affiliate_referrals WHERE affiliate_id=$1',
            [request.user.id],
          )
        ).rows[0].n;
      return { profile, settings, ...totals, referralCount: count };
    });
  }
  @Post('affiliates/activate') async activate(@Req() request: SessionRequest) {
    interactive(request);
    return transaction(async (connection) => {
      if (
        !(
          await connection.query(
            'SELECT 1 FROM affiliate_settings WHERE enabled',
          )
        ).rowCount
      )
        throw new ConflictException('联盟推荐暂未开放');
      const found = await connection.query(
        'INSERT INTO affiliates(user_id,code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING RETURNING user_id AS "userId",code,enabled',
        [request.user.id, randomBytes(16).toString('base64url')],
      );
      if (found.rowCount)
        await record(
          connection,
          request.user.id,
          'affiliate.activate',
          request.user.id,
          {},
        );
      return (
        found.rows[0] ??
        (
          await connection.query(
            'SELECT user_id AS "userId",code,enabled FROM affiliates WHERE user_id=$1',
            [request.user.id],
          )
        ).rows[0]
      );
    });
  }
  @Post('affiliates/settle') async settle(@Req() request: SessionRequest) {
    interactive(request);
    return transaction(async (connection) => {
      await active(connection, request);
      await synchronizeAffiliate(connection, request.user.id, request.user.id);
      return balance(connection, request.user.id);
    });
  }
  @Get('affiliates/commissions') async commissions(
    @Query() query: unknown,
    @Req() request: SessionRequest,
  ) {
    interactive(request);
    const page = read(pageInput, query);
    return (
      await pool.query(
        'SELECT c.id,c.invoice_id AS "invoiceId",i.number::text AS "invoiceNumber",c.category,c.rule,c.quoted_cents::text AS "quotedCents",c.released_cents::text AS "releasedCents",COALESCE((SELECT sum(amount_cents) FROM affiliate_reversals WHERE commission_id=c.id),0)::text AS "reversedCents",c.status,c.release_at AS "releaseAt",c.created_at AS "createdAt" FROM affiliate_commissions c JOIN invoices i ON i.id=c.invoice_id WHERE c.affiliate_id=$1 ORDER BY c.created_at DESC,c.id LIMIT $2 OFFSET $3',
        [request.user.id, page.limit, (page.page - 1) * page.limit],
      )
    ).rows;
  }
  @Get('affiliates/withdrawals') async withdrawals(
    @Req() request: SessionRequest,
  ) {
    interactive(request);
    return (
      await pool.query(
        `SELECT ${withdrawalColumns} FROM affiliate_withdrawals w LEFT JOIN affiliate_payouts p ON p.withdrawal_id=w.id WHERE w.user_id=$1 ORDER BY w.created_at DESC LIMIT 200`,
        [request.user.id],
      )
    ).rows;
  }
  @Post('affiliates/transfers') async transfer(
    @Body() body: unknown,
    @Headers('idempotency-key') token: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
        z.object({ amountCents: money, ...identityProofFields }).strict(),
        body,
      ),
      key = read(keyInput, token),
      fingerprint = createHash('sha256')
        .update(input.amountCents)
        .digest('hex');
    await identityProof(request, input, 'affiliate.transfer');
    return transaction(async (connection) => {
      await active(connection, request);
      await affiliateLock(connection, request.user.id);
      const prior = await idempotent(
        connection,
        'transfers',
        request.user.id,
        key,
        fingerprint,
      );
      if (prior) return { id: prior.id, ok: true };
      await synchronizeAffiliate(connection, request.user.id, request.user.id);
      const funds = await balance(connection, request.user.id);
      if (BigInt(input.amountCents) > BigInt(funds.availableCents))
        throw new ConflictException('可用佣金不足，或相关订单仍在退款中');
      const result = (
        await connection.query(
          'INSERT INTO affiliate_transfers(user_id,amount_cents,idempotency_key,request_hash) VALUES($1,$2,$3,$4) RETURNING id',
          [request.user.id, input.amountCents, key, fingerprint],
        )
      ).rows[0];
      await entries(
        connection,
        'transfer',
        result.id,
        `affiliate:${request.user.id}`,
        `wallet:${request.user.id}`,
        BigInt(input.amountCents),
      );
      await record(
        connection,
        request.user.id,
        'affiliate.transfer',
        result.id,
        { amountCents: input.amountCents },
      );
      return { ...result, ok: true };
    });
  }
  @Post('affiliates/withdrawals') async withdraw(
    @Body() body: unknown,
    @Headers('idempotency-key') token: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
        z
          .object({
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
      key = read(keyInput, token),
      fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            amountCents: input.amountCents,
            payee: input.payee,
          }),
        )
        .digest('hex');
    await identityProof(request, input, 'affiliate.withdraw');
    return transaction(async (connection) => {
      await active(connection, request);
      await affiliateLock(connection, request.user.id);
      const prior = await idempotent(
        connection,
        'withdrawals',
        request.user.id,
        key,
        fingerprint,
      );
      if (prior) return { id: prior.id, ok: true };
      await synchronizeAffiliate(connection, request.user.id, request.user.id);
      const funds = await balance(connection, request.user.id),
        minimum = (
          await connection.query(
            'SELECT minimum_withdraw_cents::text AS n FROM affiliate_settings',
          )
        ).rows[0].n;
      if (BigInt(input.amountCents) < BigInt(minimum))
        throw new ConflictException('金额低于当前最低提现额度');
      if (BigInt(input.amountCents) > BigInt(funds.availableCents))
        throw new ConflictException('可用佣金不足，或相关订单仍在退款中');
      const result = (
        await connection.query(
          'INSERT INTO affiliate_withdrawals(user_id,amount_cents,payee,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [request.user.id, input.amountCents, input.payee, key, fingerprint],
        )
      ).rows[0];
      await record(
        connection,
        request.user.id,
        'affiliate.withdraw.request',
        result.id,
        { amountCents: input.amountCents, method: input.payee.method },
      );
      return { ...result, ok: true };
    });
  }
  @Post('affiliates/withdrawals/:id/cancel') async cancel(
    @Param('id') id: string,
    @Req() request: SessionRequest,
  ) {
    interactive(request);
    read(uuid, id);
    return transaction(async (connection) => {
      await affiliateLock(connection, request.user.id);
      const row = await connection.query(
        "UPDATE affiliate_withdrawals SET status='cancelled',handled_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",
        [id, request.user.id],
      );
      if (!row.rowCount)
        throw new ConflictException('只能撤回待处理的本人提现');
      await record(
        connection,
        request.user.id,
        'affiliate.withdraw.cancel',
        id,
        {},
      );
      return { ok: true };
    });
  }
  @Roles('admin') @Get('admin/affiliates/settings') async settings() {
    return (
      await pool.query(
        'SELECT enabled,initial_rule AS "initialRule",renewal_rule AS "renewalRule",reorder_rule AS "reorderRule",hold_days AS "holdDays",minimum_withdraw_cents::text AS "minimumWithdrawCents" FROM affiliate_settings',
      )
    ).rows[0];
  }
  @Roles('admin') @Put('admin/affiliates/settings') async configure(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(settingsInput, body);
    await identityProof(request, input, 'affiliate.configure');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      await connection.query(
        'UPDATE affiliate_settings SET enabled=$1,initial_rule=$2,renewal_rule=$3,reorder_rule=$4,hold_days=$5,minimum_withdraw_cents=$6,updated_at=now()',
        [
          input.enabled,
          input.initialRule,
          input.renewalRule,
          input.reorderRule,
          input.holdDays,
          input.minimumWithdrawCents,
        ],
      );
      await record(connection, actor.id, 'affiliate.configure', 'global', {
        enabled: input.enabled,
        initialRule: input.initialRule,
        renewalRule: input.renewalRule,
        reorderRule: input.reorderRule,
        holdDays: input.holdDays,
      });
      return { ok: true };
    });
  }
  @Roles('admin') @Get('admin/affiliates') async all(@Query() query: unknown) {
    const page = read(pageInput, query);
    return (
      await pool.query(
        'SELECT a.user_id AS id,a.code,a.enabled,u.name,u.email,(SELECT count(*)::int FROM affiliate_referrals WHERE affiliate_id=a.user_id) AS "referralCount",(-COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account=\'affiliate:\'||a.user_id::text AND t.currency=\'CNY\'),0))::text AS "balanceCents" FROM affiliates a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT $1 OFFSET $2',
        [page.limit, (page.page - 1) * page.limit],
      )
    ).rows;
  }
  @Roles('admin') @Put('admin/affiliates/:id') async enable(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z.object({ enabled: z.boolean(), ...identityProofFields }).strict(),
      body,
    );
    await identityProof(request, input, 'affiliate.status');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      const found = await connection.query(
        'UPDATE affiliates SET enabled=$2 WHERE user_id=$1 RETURNING user_id',
        [id, input.enabled],
      );
      if (!found.rowCount) throw new NotFoundException('推荐人不存在');
      await record(connection, actor.id, 'affiliate.status', id, {
        enabled: input.enabled,
      });
      return { ok: true };
    });
  }
  @Roles('admin') @Post('admin/affiliates/:id/settle') async settleFor(
    @Param('id') id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    return transaction(async (connection) => {
      await synchronizeAffiliate(
        connection,
        id,
        request.actorId ?? request.user.id,
      );
      return balance(connection, id);
    });
  }
  @Roles('admin') @Get('admin/affiliate-withdrawals') async allWithdrawals(
    @Query() query: unknown,
  ) {
    const page = read(pageInput, query);
    return (
      await pool.query(
        `SELECT ${withdrawalColumns},u.email FROM affiliate_withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN affiliate_payouts p ON p.withdrawal_id=w.id ORDER BY w.created_at DESC,w.id LIMIT $1 OFFSET $2`,
        [page.limit, (page.page - 1) * page.limit],
      )
    ).rows;
  }
  @Roles('admin')
  @Post('admin/affiliate-withdrawals/:id/process')
  async process(
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
          evidenceUrl: z
            .url()
            .refine((value) => new URL(value).protocol === 'https:')
            .optional(),
          paidAt: z.iso.datetime().optional(),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    if (input.action === 'pay' && (!input.reference || !input.paidAt))
      throw new BadRequestException('请填写实际打款凭据和实际打款时间');
    if (input.action === 'reject' && !input.reason)
      throw new BadRequestException('驳回需要说明原因');
    await identityProof(request, input, 'affiliate.withdraw.process');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request),
        target = (
          await connection.query(
            'SELECT user_id FROM affiliate_withdrawals WHERE id=$1',
            [id],
          )
        ).rows[0];
      if (!target) throw new NotFoundException('提现申请不存在');
      await affiliateLock(connection, target.user_id);
      await synchronizeAffiliate(connection, target.user_id, actor.id);
      const withdrawal = (
        await connection.query(
          'SELECT * FROM affiliate_withdrawals WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (withdrawal.status !== 'pending') {
        if (input.action === 'pay' && withdrawal.status === 'paid') {
          const paid = (
            await connection.query(
              'SELECT reference,paid_at FROM affiliate_payouts WHERE withdrawal_id=$1',
              [id],
            )
          ).rows[0];
          if (
            paid.reference !== input.reference ||
            new Date(paid.paid_at).toISOString() !==
              new Date(input.paidAt!).toISOString()
          )
            throw new ConflictException('提现已由另一份打款凭据确认');
          return { ok: true, status: withdrawal.status };
        }
        if (input.action === 'reject' && withdrawal.status === 'rejected')
          return { ok: true, status: withdrawal.status };
        throw new ConflictException('提现已处理，请刷新记录');
      }
      const status = input.action === 'pay' ? 'paid' : 'rejected';
      if (input.action === 'pay') {
        const funds = await balance(connection, withdrawal.user_id);
        if (
          funds.refundPending ||
          BigInt(funds.balanceCents) < BigInt(funds.reservedCents)
        )
          throw new ConflictException(
            '佣金已受退款影响，不能确认打款，请先核对申请',
          );
        const payout = (
          await connection.query(
            'INSERT INTO affiliate_payouts(withdrawal_id,user_id,amount_cents,channel,reference,evidence_url,paid_at,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
            [
              id,
              withdrawal.user_id,
              withdrawal.amount_cents,
              withdrawal.payee.method,
              input.reference,
              input.evidenceUrl ?? null,
              input.paidAt,
              actor.id,
            ],
          )
        ).rows[0];
        await entries(
          connection,
          'payout',
          payout.id,
          `affiliate:${withdrawal.user_id}`,
          `cash:affiliate-payout:${withdrawal.payee.method}`,
          BigInt(withdrawal.amount_cents),
        );
      }
      await connection.query(
        'UPDATE affiliate_withdrawals SET status=$2,decision_reason=$3,handled_by=$4,handled_at=now() WHERE id=$1',
        [id, status, input.reason, actor.id],
      );
      await record(
        connection,
        actor.id,
        `affiliate.withdraw.${input.action}`,
        id,
        {
          amountCents: withdrawal.amount_cents,
          reference: input.reference,
          status,
        },
      );
      return { ok: true, status };
    });
  }
}
