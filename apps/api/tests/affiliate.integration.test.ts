/* 联盟资金验收：真实完整HTTP、随机PostgreSQL、Redis和生产收款入口。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/affiliate.integration.test.ts。
 * 所有支付/打款凭据仅为隔离数据库事实，不访问外部支付或提现服务。
 */
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import { hash, argon2id } from 'argon2';

test(
  '联盟推荐归因与佣金资金来源完整且不可重复兑现',
  { timeout: 120000 },
  async (context) => {
    const source = process.env.DATABASE_URL!;
    assert.ok(source);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source).hostname),
    );
    const name = `yunzou_affiliate_${randomUUID().replaceAll('-', '')}`,
      master = new pg.Client({ connectionString: source }),
      address = new URL(source);
    address.pathname = `/${name}`;
    const audit = randomBytes(32).toString('hex'),
      ip = `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
      password = 'affiliate-test-password-2026';
    let application: typeof import('../src/features/store.js') | undefined,
      server: ChildProcess | undefined,
      created = false,
      output = '';
    const users: string[] = [],
      emails: string[] = [],
      tokens: string[] = [],
      digest = (value: string) =>
        createHash('sha256').update(value).digest('hex');
    try {
      await master.connect();
      await master.query(`CREATE DATABASE ${name}`);
      created = true;
      process.env.DATABASE_URL = address.href;
      process.env.AUDIT_KEY = audit;
      application = await import('../src/features/store.js');
      const { pool, redis, transaction } = application;
      await redis.connect();
      await pool.query(
        'CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL)',
      );
      const directory = new URL(
        '../../../database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(directory))
        .filter(
          (file) =>
            file.endsWith('.sql') ||
            /^0(22|23|24|25|26|27|28|29|32|33|34)_.*\.draft$/.test(file),
        )
        .sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await transaction(async (c) => {
          await c.query(sql);
          await c.query('INSERT INTO migrations(name,hash) VALUES($1,$2)', [
            file,
            digest(sql),
          ]);
        });
      }
      const listener = createServer();
      await new Promise<void>((resolve) =>
        listener.listen(0, '127.0.0.1', resolve),
      );
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`,
        base = `${origin}/api/v1`;
      server = spawn(
        process.execPath,
        ['--import', 'tsx', 'apps/api/src/main.ts'],
        {
          cwd: new URL('../../../', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: address.href,
            AUDIT_KEY: audit,
            TOTP_KEY: randomBytes(32).toString('hex'),
            PUBLIC_ORIGIN: origin,
            PORT: String(port),
            HOST: '127.0.0.1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      server.stdout?.on('data', (value) => {
        output += String(value);
      });
      server.stderr?.on('data', (value) => {
        output += String(value);
      });
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          ready = (await fetch(`${base}/health`)).ok;
        } catch {}
        if (ready) break;
        if (server.exitCode !== null) throw new Error(output.slice(-2500));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, output.slice(-2500));
      async function call(
        path: string,
        options: {
          method?: string;
          body?: unknown;
          cookie?: string;
          key?: string;
        } = {},
      ) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          origin,
          'x-forwarded-for': ip,
        };
        if (options.cookie) headers.cookie = options.cookie;
        if (options.key) headers['idempotency-key'] = options.key;
        const response = await fetch(base + path, {
          method: options.method ?? 'GET',
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        });
        return {
          status: response.status,
          body: await response.json(),
          cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
        };
      }
      const saved = await hash(password, { type: argon2id });
      async function fixture(role = 'customer') {
        const id = randomUUID(),
          email = `${randomUUID()}@affiliate.invalid`;
        users.push(id);
        emails.push(email);
        await pool.query(
          'INSERT INTO users(id,email,name,password,role) VALUES($1,$2,$3,$4,$5)',
          [id, email, '联盟资金验收', saved, role],
        );
        const login = await call('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        assert.equal(login.status, 201, JSON.stringify(login.body));
        tokens.push(login.cookie.split('=')[1]!);
        return { id, email, cookie: login.cookie };
      }
      const admin = await fixture('admin'),
        affiliate = await fixture();
      const configuration = {
        enabled: true,
        initialRule: { kind: 'percent', value: '1000' },
        renewalRule: { kind: 'percent', value: '500' },
        reorderRule: { kind: 'fixed', value: '250' },
        holdDays: 0,
        minimumWithdrawCents: '100',
        password,
      };
      assert.equal(
        (
          await call('/admin/affiliates/settings', {
            method: 'PUT',
            cookie: admin.cookie,
            body: configuration,
          })
        ).status,
        200,
      );
      const activated = await call('/affiliates/activate', {
        method: 'POST',
        cookie: affiliate.cookie,
      });
      assert.equal(activated.status, 201, JSON.stringify(activated.body));
      const code = activated.body.code;
      const buyerEmail = `${randomUUID()}@affiliate.invalid`;
      emails.push(buyerEmail);
      const registered = await call('/auth/register', {
        method: 'POST',
        body: {
          name: '被推荐客户',
          email: buyerEmail,
          password,
          referralCode: code,
        },
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      const buyer = {
        id: registered.body.id,
        email: buyerEmail,
        cookie: registered.cookie,
      };
      users.push(buyer.id);
      tokens.push(buyer.cookie.split('=')[1]!);
      const { settle } = await import('../src/features/settlement.js');
      const product = (
        await pool.query(
          "INSERT INTO products(name,price_cents,provider) VALUES('联盟真实收款商品',10000,'manual') RETURNING id",
        )
      ).rows[0].id;
      async function invoice(
        user = buyer.id,
        amount = '10000',
        kind = 'new',
        attempted = true,
        currency = 'CNY',
        selectedProduct = product,
      ) {
        const order = randomUUID(),
          id = randomUUID();
        await transaction(async (c) => {
          await c.query(
            'INSERT INTO orders(id,user_id,product_id,idempotency_key,request_hash,amount_cents,kind,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              order,
              user,
              selectedProduct,
              randomUUID(),
              'affiliate-test',
              amount,
              kind,
              currency,
            ],
          );
          await c.query(
            'INSERT INTO invoices(id,user_id,order_id,amount_cents,currency) VALUES($1,$2,$3,$4,$5)',
            [id, user, order, amount, currency],
          );
          if (kind === 'new')
            await c.query(
              "INSERT INTO services(user_id,product_id,order_id,name,billing_currency) VALUES($1,$2,$3,'联盟测试资源',$4)",
              [user, selectedProduct, order, currency],
            );
          if (attempted)
            await c.query(
              "INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'affiliate-test')",
              [id],
            );
        });
        return { id, order, amount, currency };
      }
      async function pay(bill: {
        id: string;
        amount: string;
        currency?: string;
      }) {
        return settle('affiliate-test', {
          invoiceId: bill.id,
          transactionId: `affiliate-${bill.id}`,
          amountCents: bill.amount,
          currency: bill.currency ?? 'CNY',
          paid: true,
        });
      }
      async function refund(invoiceId: string, amount: string) {
        return transaction(async (c) => {
          const receipt = (
              await c.query(
                'SELECT p.*,i.user_id FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id WHERE p.invoice_id=$1 FOR UPDATE OF p',
                [invoiceId],
              )
            ).rows[0],
            id = randomUUID();
          await c.query(
            "INSERT INTO refunds(id,receipt_id,user_id,amount_cents,currency,reason,idempotency_key,request_hash,status) VALUES($1::uuid,$2,$3,$4,$6,'隔离退款事实',($1::uuid)::text,$5,'processing')",
            [
              id,
              receipt.id,
              receipt.user_id,
              amount,
              'a'.repeat(64),
              receipt.currency,
            ],
          );
          const ledger = (
            await c.query(
              'INSERT INTO ledger_transactions(refund_id,currency) VALUES($1,$2) RETURNING id',
              [id, receipt.currency],
            )
          ).rows[0];
          await c.query(
            'INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',
            [
              ledger.id,
              'cash:affiliate-test',
              (-BigInt(amount)).toString(),
              `income:${receipt.user_id}`,
              amount,
            ],
          );
          await c.query(
            "UPDATE refunds SET status='succeeded',completed_at=now() WHERE id=$1",
            [id],
          );
          return id;
        });
      }
      let first: { id: string; order: string; amount: string };
      await context.test(
        '注册原子归因、防自荐与循环归因，推荐资料不泄漏密码',
        async () => {
          const row = (
            await pool.query(
              'SELECT * FROM affiliate_referrals WHERE user_id=$1',
              [buyer.id],
            )
          ).rows[0];
          assert.equal(row.affiliate_id, affiliate.id);
          await assert.rejects(
            pool.query(
              'INSERT INTO affiliate_referrals(user_id,affiliate_id) VALUES($1,$1)',
              [affiliate.id],
            ),
            /自我|check/,
          );
          await pool.query(
            'INSERT INTO affiliates(user_id,code) VALUES($1,$2)',
            [buyer.id, randomBytes(16).toString('base64url')],
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO affiliate_referrals(user_id,affiliate_id) VALUES($1,$2)',
              [affiliate.id, buyer.id],
            ),
            /循环/,
          );
          const invalid = await call('/auth/register', {
            method: 'POST',
            body: {
              name: '错误推荐',
              email: `${randomUUID()}@affiliate.invalid`,
              password,
              referralCode: 'a'.repeat(22),
            },
          });
          assert.equal(invalid.status, 400);
        },
      );
      await context.test(
        '真实付款冻结一笔佣金，十次回调和并发释放只记一次',
        async () => {
          first = await invoice();
          await Promise.all(Array.from({ length: 10 }, () => pay(first)));
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_commissions',
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (await pool.query('SELECT status FROM affiliate_commissions'))
              .rows[0].status,
            'pending',
          );
          const results = await Promise.all(
            Array.from({ length: 5 }, () =>
              call('/affiliates/settle', {
                method: 'POST',
                cookie: affiliate.cookie,
              }),
            ),
          );
          assert.ok(
            results.every((item) => item.status === 201),
            JSON.stringify(results) + output.slice(-1800),
          );
          const funds = await call('/affiliates', { cookie: affiliate.cookie });
          assert.equal(funds.body.balanceCents, '1000');
          await assert.rejects(
            pool.query(
              "INSERT INTO affiliate_transfers(user_id,amount_cents,idempotency_key,request_hash) VALUES($1,1,$2,'orphan-source')",
              [affiliate.id, randomUUID()],
            ),
            /双分录/,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM ledger_transactions WHERE affiliate_commission_id IS NOT NULL',
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await context.test(
        '并发转余额不超支，同键重试不重复生成钱包余额',
        async () => {
          const key = randomUUID(),
            body = { amountCents: '600', password };
          const results = await Promise.all([
            call('/affiliates/transfers', {
              method: 'POST',
              cookie: affiliate.cookie,
              key,
              body,
            }),
            call('/affiliates/transfers', {
              method: 'POST',
              cookie: affiliate.cookie,
              key,
              body,
            }),
          ]);
          assert.ok(
            results.every((item) => item.status === 201),
            JSON.stringify(results) + output.slice(-1800),
          );
          assert.equal(results[0].body.id, results[1].body.id);
          const wallet = await call('/wallet', { cookie: affiliate.cookie });
          assert.equal(wallet.body.balanceCents, '600');
          assert.equal(
            (
              await call('/affiliates/transfers', {
                method: 'POST',
                cookie: affiliate.cookie,
                key,
                body: { amountCents: '601', password },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call('/affiliates/transfers', {
                method: 'POST',
                cookie: affiliate.cookie,
                key: randomUUID(),
                body: { amountCents: '401', password },
              })
            ).status,
            409,
          );
        },
      );
      let withdrawal = '';
      await context.test(
        '提现并发预留可用额，不能伪造已支付，驳回释放预留',
        async () => {
          const body = {
            amountCents: '300',
            payee: {
              method: 'bank',
              name: '隔离收款人',
              account: 'TEST-ONLY-NO-REAL-ACCOUNT',
            },
            password,
          };
          const results = await Promise.all([
            call('/affiliates/withdrawals', {
              method: 'POST',
              cookie: affiliate.cookie,
              key: randomUUID(),
              body,
            }),
            call('/affiliates/withdrawals', {
              method: 'POST',
              cookie: affiliate.cookie,
              key: randomUUID(),
              body,
            }),
          ]);
          assert.equal(
            results.filter((item) => item.status === 201).length,
            1,
            JSON.stringify(results),
          );
          withdrawal = results.find((item) => item.status === 201)!.body.id;
          const funds = await call('/affiliates', { cookie: affiliate.cookie });
          assert.equal(funds.body.reservedCents, '300');
          assert.equal(funds.body.availableCents, '100');
          await assert.rejects(
            pool.query(
              "UPDATE affiliate_withdrawals SET status='paid' WHERE id=$1",
              [withdrawal],
            ),
            /真实打款/,
          );
          const rejected = await call(
            `/admin/affiliate-withdrawals/${withdrawal}/process`,
            {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                action: 'reject',
                reason: '测试驳回，不发起任何真实打款',
                password,
              },
            },
          );
          assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
          assert.equal(
            (await call('/affiliates', { cookie: affiliate.cookie })).body
              .availableCents,
            '400',
          );
        },
      );
      await context.test(
        '登记真实凭据才生成现金分录，重复确认幂等且不能复用流水',
        async () => {
          const created = await call('/affiliates/withdrawals', {
            method: 'POST',
            cookie: affiliate.cookie,
            key: randomUUID(),
            body: {
              amountCents: '200',
              payee: {
                method: 'bank',
                name: '隔离收款人',
                account: 'TEST-ONLY-NO-REAL-ACCOUNT',
              },
              password,
            },
          });
          assert.equal(created.status, 201);
          const body = {
            action: 'pay',
            reference: `isolated-payout-${randomUUID()}`,
            paidAt: new Date().toISOString(),
            password,
          };
          assert.equal(
            (
              await call(
                `/admin/affiliate-withdrawals/${created.body.id}/process`,
                {
                  method: 'POST',
                  cookie: admin.cookie,
                  body: { action: 'pay', password },
                },
              )
            ).status,
            400,
          );
          const paid = await call(
            `/admin/affiliate-withdrawals/${created.body.id}/process`,
            { method: 'POST', cookie: admin.cookie, body },
          );
          assert.equal(paid.status, 201, JSON.stringify(paid.body));
          assert.equal(
            (
              await call(
                `/admin/affiliate-withdrawals/${created.body.id}/process`,
                { method: 'POST', cookie: admin.cookie, body },
              )
            ).status,
            201,
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int n FROM affiliate_payouts'))
              .rows[0].n,
            1,
          );
          assert.equal(
            (await call('/affiliates', { cookie: affiliate.cookie })).body
              .balanceCents,
            '200',
          );
        },
      );
      await context.test(
        '释放后退款按净额反向记佣；已支出部分记待追偿且不扣钱包',
        async () => {
          await refund(first.id, '5000');
          const funds = await call('/affiliates', { cookie: affiliate.cookie });
          assert.equal(funds.status, 200, JSON.stringify(funds.body));
          assert.equal(funds.body.balanceCents, '-300');
          assert.equal(funds.body.availableCents, '0');
          assert.equal(
            (await call('/wallet', { cookie: affiliate.cookie })).body
              .balanceCents,
            '600',
          );
          await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_reversals',
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await context.test(
        '等待期前已退款按净额释放，不重复冲回已识别退款',
        async () => {
          const second = await invoice(buyer.id, '10000');
          await pay(second);
          const refunded = await refund(second.id, '9900');
          const settled = await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(settled.status, 201, JSON.stringify(settled.body));
          const fact = (
            await pool.query(
              'SELECT * FROM affiliate_commissions WHERE invoice_id=$1',
              [second.id],
            )
          ).rows[0];
          assert.equal(fact.net_basis_cents, '100');
          assert.equal(fact.released_cents, '100');
          assert.deepEqual(fact.recognized_refund_ids, [refunded]);
          await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_reversals WHERE refund_id=$1',
                [refunded],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await context.test(
        '等待期不提前释放，固定复购佣金按净收入封顶',
        async () => {
          const updated = await call('/admin/affiliates/settings', {
            method: 'PUT',
            cookie: admin.cookie,
            body: { ...configuration, holdDays: 1 },
          });
          assert.equal(updated.status, 200);
          const repeat = await invoice(buyer.id, '100');
          await pay(repeat);
          const rows = (
            await pool.query(
              'SELECT * FROM affiliate_commissions WHERE invoice_id=$1',
              [repeat.id],
            )
          ).rows;
          assert.equal(rows[0].category, 'reorder');
          assert.equal(rows[0].quoted_cents, '100');
          await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM affiliate_commissions WHERE invoice_id=$1',
                [repeat.id],
              )
            ).rows[0].status,
            'pending',
          );
        },
      );
      await context.test(
        '孤立转余额或缺来源账本不能提交，资金和审计都不可覆盖',
        async () => {
          await assert.rejects(
            pool.query(
              "INSERT INTO affiliate_transfers(user_id,amount_cents,idempotency_key,request_hash) VALUES($1,1,$2,'test')",
              [affiliate.id, randomUUID()],
            ),
            /佣金不足|双分录/,
          );
          await assert.rejects(
            pool.query(
              'UPDATE ledger_entries SET amount_cents=1 WHERE transaction_id=(SELECT id FROM ledger_transactions WHERE affiliate_transfer_id IS NOT NULL LIMIT 1)',
            ),
            /只能追加|不可|不能/,
          );
        },
      );
      await context.test(
        '信用未收款不计佣，真实足额还款才开始等待期，充值不计佣',
        async () => {
          const grant = await call(`/admin/credit/${buyer.id}`, {
            method: 'PUT',
            cookie: admin.cookie,
            body: {
              enabled: true,
              limitCents: '50000',
              billingDay: 1,
              repaymentDays: 15,
              note: '隔离信用计佣验收',
              password,
            },
          });
          assert.equal(grant.status, 200, JSON.stringify(grant.body));
          const credit = await invoice();
          const paid = await call(`/invoices/${credit.id}/pay-credit`, {
            method: 'POST',
            cookie: buyer.cookie,
            body: { password },
          });
          assert.equal(
            paid.status,
            201,
            JSON.stringify(paid.body) + output.slice(-1600),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_commissions WHERE invoice_id=$1',
                [credit.id],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT affiliate_invoice_payment_at($1) AS paid',
                [credit.id],
              )
            ).rows[0].paid,
            null,
          );
          const repayment = await call('/credit/repayments', {
            method: 'POST',
            cookie: buyer.cookie,
            key: randomUUID(),
            body: {},
          });
          assert.equal(repayment.status, 201, JSON.stringify(repayment.body));
          await pool.query(
            "INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'affiliate-test')",
            [repayment.body.invoiceId],
          );
          await pay({
            id: repayment.body.invoiceId,
            amount: repayment.body.amountCents,
          });
          const commission = (
            await pool.query(
              "SELECT *,release_at=affiliate_invoice_payment_at(invoice_id)+interval '1 day' AS exact_wait FROM affiliate_commissions WHERE invoice_id=$1",
              [credit.id],
            )
          ).rows[0];
          assert.ok(commission, '实际还款触发原业务佣金');
          assert.equal(commission.status, 'pending');
          assert.equal(commission.exact_wait, true);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_commissions WHERE invoice_id=$1',
                [repayment.body.invoiceId],
              )
            ).rows[0].n,
            0,
          );
          const recharge = await invoice(buyer.id, '1000', 'recharge');
          await pay(recharge);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM affiliate_commissions WHERE invoice_id=$1',
                [recharge.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await context.test(
        '合并并发同键只建一单，子单不能另付或取消，父取消释放原单',
        async () => {
          const a = await invoice(buyer.id, '101', 'new', false),
            b = await invoice(buyer.id, '202', 'new', false),
            key = randomUUID(),
            body = { invoiceIds: [a.id, b.id] };
          const results = await Promise.all([
            call('/combined-invoices', {
              method: 'POST',
              cookie: buyer.cookie,
              key,
              body,
            }),
            call('/combined-invoices', {
              method: 'POST',
              cookie: buyer.cookie,
              key,
              body,
            }),
          ]);
          assert.ok(
            results.every((item) => item.status === 201),
            JSON.stringify(results) + output.slice(-1600),
          );
          assert.equal(results[0].body.invoiceId, results[1].body.invoiceId);
          const parent = results[0].body.invoiceId;
          assert.equal(
            (
              await call('/combined-invoices', {
                method: 'POST',
                cookie: buyer.cookie,
                key: randomUUID(),
                body,
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(`/invoices/${a.id}/pay-wallet`, {
                method: 'POST',
                cookie: buyer.cookie,
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(`/invoices/${a.id}/pay-credit`, {
                method: 'POST',
                cookie: buyer.cookie,
                body: { password },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(`/orders/${a.order}/cancel`, {
                method: 'POST',
                cookie: buyer.cookie,
              })
            ).status,
            409,
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'affiliate-test')",
              [a.id],
            ),
            /子账单已合并/,
          );
          const cancelled = await call(`/combined-invoices/${parent}/cancel`, {
            method: 'POST',
            cookie: buyer.cookie,
          });
          assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM combined_invoice_items WHERE parent_invoice_id=$1 AND locked',
                [parent],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query('SELECT status FROM invoices WHERE id=$1', [
                a.id,
              ])
            ).rows[0].status,
            'unpaid',
          );
          await pool.query(
            "INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'affiliate-test')",
            [a.id],
          );
          assert.equal(
            (
              await call('/combined-invoices', {
                method: 'POST',
                cookie: buyer.cookie,
                key: randomUUID(),
                body,
              })
            ).status,
            409,
          );
        },
      );
      await context.test(
        '合并父实际收款只记一次收入，子单交付，父退款冲回多个子佣金',
        async () => {
          assert.equal(
            (
              await call('/admin/affiliates/settings', {
                method: 'PUT',
                cookie: admin.cookie,
                body: configuration,
              })
            ).status,
            200,
          );
          const a = await invoice(buyer.id, '101', 'new', false),
            b = await invoice(buyer.id, '202', 'new', false),
            created = await call('/combined-invoices', {
              method: 'POST',
              cookie: buyer.cookie,
              key: randomUUID(),
              body: { invoiceIds: [a.id, b.id] },
            });
          assert.equal(
            created.status,
            201,
            JSON.stringify(created.body) + output.slice(-1600),
          );
          const parent = created.body.invoiceId;
          assert.equal(created.body.amountCents, '303');
          await pool.query(
            "INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'affiliate-test')",
            [parent],
          );
          assert.equal(
            (
              await call(`/combined-invoices/${parent}/cancel`, {
                method: 'POST',
                cookie: buyer.cookie,
              })
            ).status,
            409,
          );
          await Promise.all(
            Array.from({ length: 5 }, () => pay({ id: parent, amount: '303' })),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM payment_receipts WHERE invoice_id=ANY($1::uuid[])',
                [[a.id, b.id, parent]],
              )
            ).rows[0].n,
            1,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT status FROM invoices WHERE id=ANY($1::uuid[])',
                [[a.id, b.id, parent]],
              )
            ).rows.map((item) => item.status),
            ['paid', 'paid', 'paid'],
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM jobs WHERE service_id IN(SELECT id FROM services WHERE order_id=ANY($1::uuid[]))',
                [[a.order, b.order]],
              )
            ).rows[0].n,
            2,
          );
          const tax = await call('/tax-eligible-invoices', {
            cookie: buyer.cookie,
          });
          assert.equal(tax.status, 200, JSON.stringify(tax.body));
          assert.ok(tax.body.some((item: any) => item.id === parent));
          assert.ok(
            !tax.body.some((item: any) => [a.id, b.id].includes(item.id)),
          );
          const released = await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(
            released.status,
            201,
            JSON.stringify(released.body) + output.slice(-1600),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT sum(released_cents)::text n FROM affiliate_commissions WHERE invoice_id=ANY($1::uuid[])',
                [[a.id, b.id]],
              )
            ).rows[0].n,
            '303',
          );
          const firstRefund = await refund(parent, '150'),
            reversed = await call('/affiliates/settle', {
              method: 'POST',
              cookie: affiliate.cookie,
            });
          assert.equal(
            reversed.status,
            201,
            JSON.stringify(reversed.body) + output.slice(-1600),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT sum(amount_cents)::text n FROM affiliate_reversals WHERE refund_id=$1',
                [firstRefund],
              )
            ).rows[0].n,
            '150',
          );
          await refund(parent, '153');
          const final = await call('/affiliates/settle', {
            method: 'POST',
            cookie: affiliate.cookie,
          });
          assert.equal(
            final.status,
            201,
            JSON.stringify(final.body) + output.slice(-1600),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT sum(r.amount_cents)::text n FROM affiliate_reversals r JOIN affiliate_commissions c ON c.id=r.commission_id WHERE c.invoice_id=ANY($1::uuid[])',
                [[a.id, b.id]],
              )
            ).rows[0].n,
            '303',
          );
        },
      );
      await context.test(
        '合并父余额支付只扣一次，子单保持真实父资金来源',
        async () => {
          const a = await invoice(buyer.id, '300', 'new', false),
            b = await invoice(buyer.id, '400', 'new', false),
            created = await call('/combined-invoices', {
              method: 'POST',
              cookie: buyer.cookie,
              key: randomUUID(),
              body: { invoiceIds: [a.id, b.id] },
            });
          assert.equal(created.status, 201, JSON.stringify(created.body));
          const parent = created.body.invoiceId;
          const paid = await call(`/invoices/${parent}/pay-wallet`, {
            method: 'POST',
            cookie: buyer.cookie,
          });
          assert.equal(
            paid.status,
            201,
            JSON.stringify(paid.body) + output.slice(-1600),
          );
          assert.equal(
            (
              await call(`/invoices/${parent}/pay-wallet`, {
                method: 'POST',
                cookie: buyer.cookie,
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM wallet_payments WHERE invoice_id=ANY($1::uuid[])',
                [[a.id, b.id, parent]],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (await call('/wallet', { cookie: buyer.cookie })).body.balanceCents,
            '300',
          );
        },
      );
      await context.test(
        '经营报表按真实分录区分充值、收入与还款，客户商品排名不重复父子金额',
        async () => {
          const year = new Date().getUTCFullYear(),
            query = `from=${year}-01-01&to=${year}-12-31&bucket=month`;
          assert.equal(
            (await call('/admin/reports?' + query, { cookie: buyer.cookie }))
              .status,
            403,
          );
          const report = await call('/admin/reports?' + query, {
            cookie: admin.cookie,
          });
          assert.equal(
            report.status,
            200,
            JSON.stringify(report.body) + output.slice(-2000),
          );
          assert.equal(
            report.body.summary.find((row: any) => row.currency === 'CNY')
              .incomeNetCents,
            '15900',
          );
          assert.equal(
            report.body.customers.find(
              (row: any) => row.id === buyer.id && row.currency === 'CNY',
            ).netCents,
            '15900',
          );
          assert.equal(
            report.body.products.find(
              (row: any) => row.id === product && row.currency === 'CNY',
            ).netCents,
            '15900',
          );
          assert.ok(report.body.newCustomers.length > 0);
          const operations = await call('/admin/reports/operations?' + query, {
            cookie: admin.cookie,
          });
          assert.equal(
            operations.status,
            200,
            JSON.stringify(operations.body) + output.slice(-1600),
          );
          assert.ok(operations.body.states.length > 0);
          assert.ok(operations.body.trend.length > 0);
        },
      );
      await context.test(
        '销售员工归属和阶梯独立计提，退款净额、并发预留与真实兑现闭合',
        async () => {
          const employee = await fixture('support'),
            group = await call('/admin/sales/groups', {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                name: '隔离员工销售组',
                productIds: [product],
                newBps: 1000,
                renewBps: 500,
                upgradeBps: 700,
                holdDays: 0,
                active: true,
                password,
              },
            });
          assert.equal(group.status, 201, JSON.stringify(group.body));
          assert.equal(
            (
              await call(`/admin/sales/people/${employee.id}`, {
                method: 'PUT',
                cookie: admin.cookie,
                body: { groupId: group.body.id, enabled: true, password },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call('/admin/sales/assignments', {
                method: 'POST',
                cookie: admin.cookie,
                body: { customerId: buyer.id, staffId: employee.id, password },
              })
            ).status,
            201,
          );
          const tier = await call('/admin/sales/tiers', {
            method: 'POST',
            cookie: admin.cookie,
            body: {
              groupId: group.body.id,
              currency: 'CNY',
              category: 'new',
              thresholdCents: '1500',
              rateBps: 2000,
              active: true,
              password,
            },
          });
          assert.equal(tier.status, 201, JSON.stringify(tier.body));
          const { captureSales } = await import('../src/features/sales.js');
          const firstSale = await invoice(buyer.id, '1000');
          await pay(firstSale);
          await transaction((c) => captureSales(c, firstSale.id));
          const secondSale = await invoice(buyer.id, '1000');
          await pay(secondSale);
          await transaction((c) => captureSales(c, secondSale.id));
          const rules = (
            await pool.query(
              'SELECT rate_bps FROM sales_commissions WHERE staff_id=$1 ORDER BY created_at,id',
              [employee.id],
            )
          ).rows;
          assert.deepEqual(
            rules.map((r) => r.rate_bps),
            [1000, 2000],
          );
          let personal = await call('/sales', { cookie: employee.cookie });
          assert.equal(
            personal.status,
            200,
            JSON.stringify(personal.body) + output.slice(-1600),
          );
          assert.equal(personal.body.balances[0].balanceCents, '300');
          assert.equal(
            (await call('/sales/customers', { cookie: employee.cookie }))
              .body[0].id,
            buyer.id,
          );
          assert.equal(
            (await call('/sales/customers', { cookie: admin.cookie })).body
              .length,
            0,
          );
          await refund(firstSale.id, '500');
          personal = await call('/sales', { cookie: employee.cookie });
          assert.equal(
            personal.status,
            200,
            JSON.stringify(personal.body) + output.slice(-1600),
          );
          assert.equal(personal.body.balances[0].availableCents, '250');
          const body = {
              currency: 'CNY',
              amountCents: '250',
              payee: {
                method: 'bank',
                name: '隔离员工',
                account: 'SYNTHETIC-STAFF-ONLY',
              },
              password,
            },
            requests = await Promise.all([
              call('/sales/withdrawals', {
                method: 'POST',
                cookie: employee.cookie,
                key: randomUUID(),
                body,
              }),
              call('/sales/withdrawals', {
                method: 'POST',
                cookie: employee.cookie,
                key: randomUUID(),
                body,
              }),
            ]);
          assert.equal(
            requests.filter((r) => r.status === 201).length,
            1,
            JSON.stringify(requests),
          );
          const withdrawal = requests.find((r) => r.status === 201)!.body.id;
          const paid = await call(
            `/admin/sales/withdrawals/${withdrawal}/process`,
            {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                action: 'pay',
                reference: 'synthetic-sales-' + randomUUID(),
                paidAt: new Date().toISOString(),
                password,
              },
            },
          );
          assert.equal(
            paid.status,
            201,
            JSON.stringify(paid.body) + output.slice(-1800),
          );
          await refund(firstSale.id, '500');
          personal = await call('/sales', { cookie: employee.cookie });
          assert.equal(
            personal.status,
            200,
            JSON.stringify(personal.body) + output.slice(-1600),
          );
          assert.equal(personal.body.balances[0].balanceCents, '-50');
          assert.equal(personal.body.balances[0].availableCents, '0');
          await assert.rejects(
            pool.query(
              'UPDATE sales_commissions SET rate_bps=9999 WHERE staff_id=$1',
              [employee.id],
            ),
            /不能覆盖|不能/,
          );
          const reassigned = await call('/admin/sales/assignments', {
            method: 'POST',
            cookie: admin.cookie,
            body: { customerId: buyer.id, staffId: null, password },
          });
          assert.equal(reassigned.status, 201);
          assert.equal(
            (await call('/sales/customers', { cookie: employee.cookie })).body
              .length,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int n FROM sales_commissions WHERE staff_id=$1',
                [employee.id],
              )
            ).rows[0].n,
            2,
          );
        },
      );

      await context.test(
        'USD与零位JPY销售、退款和实际兑现分别分桶，报表不跨币种合计',
        async () => {
          for (const [code, decimals, numerator, denominator] of [
            ['USD', 2, '7', '1'],
            ['JPY', 0, '1', '20'],
          ] as const) {
            const result = await call('/admin/currencies', {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                code,
                name: code,
                symbol: code === 'USD' ? '$' : '¥',
                decimals,
                rateNumerator: numerator,
                rateDenominator: denominator,
                active: true,
                isDefault: false,
              },
            });
            assert.equal(result.status, 201, JSON.stringify(result.body));
          }
          const usdProduct = (
              await pool.query(
                "INSERT INTO products(name,price_cents,currency,provider) VALUES('美元销售测试',1000,'USD','manual') RETURNING id",
              )
            ).rows[0].id,
            jpyProduct = (
              await pool.query(
                "INSERT INTO products(name,price_cents,currency,provider) VALUES('日元销售测试',100,'JPY','manual') RETURNING id",
              )
            ).rows[0].id;
          const employee = await fixture('support'),
            group = await call('/admin/sales/groups', {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                name: '外币隔离销售组',
                productIds: [usdProduct, jpyProduct],
                newBps: 1000,
                renewBps: 500,
                upgradeBps: 500,
                holdDays: 0,
                active: true,
                password,
              },
            });
          assert.equal(group.status, 201, JSON.stringify(group.body));
          assert.equal(
            (
              await call(`/admin/sales/people/${employee.id}`, {
                method: 'PUT',
                cookie: admin.cookie,
                body: { groupId: group.body.id, enabled: true, password },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await call('/admin/sales/assignments', {
                method: 'POST',
                cookie: admin.cookie,
                body: { customerId: buyer.id, staffId: employee.id, password },
              })
            ).status,
            201,
          );
          for (const [currency, thresholdCents, rateBps] of [
            ['USD', '1500', 2000],
            ['JPY', '150', 3000],
          ] as const) {
            const tier = await call('/admin/sales/tiers', {
              method: 'POST',
              cookie: admin.cookie,
              body: {
                groupId: group.body.id,
                currency,
                category: 'new',
                thresholdCents,
                rateBps,
                active: true,
                password,
              },
            });
            assert.equal(tier.status, 201, JSON.stringify(tier.body));
          }
          const usd1 = await invoice(
              buyer.id,
              '1000',
              'new',
              true,
              'USD',
              usdProduct,
            ),
            jpy1 = await invoice(
              buyer.id,
              '100',
              'new',
              true,
              'JPY',
              jpyProduct,
            ),
            usd2 = await invoice(
              buyer.id,
              '1000',
              'new',
              true,
              'USD',
              usdProduct,
            ),
            jpy2 = await invoice(
              buyer.id,
              '100',
              'new',
              true,
              'JPY',
              jpyProduct,
            );
          for (const bill of [usd1, jpy1, usd2, jpy2]) await pay(bill);
          const activity = await call('/activity?action=invoice.settle', {
            cookie: buyer.cookie,
          });
          assert.equal(activity.status, 200, JSON.stringify(activity.body));
          assert.ok(
            activity.body.items.some(
              (item: any) =>
                item.target === usd1.id && item.label === '付款入账',
            ),
          );
          assert.ok(
            activity.body.items.every(
              (item: any) =>
                !('details' in item) &&
                !('actor' in item) &&
                !('canonical_body' in item),
            ),
          );
          const stranger = await call('/activity?action=invoice.settle', {
            cookie: affiliate.cookie,
          });
          assert.equal(stranger.status, 200);
          assert.ok(
            !stranger.body.items.some((item: any) =>
              [usd1.id, jpy1.id, usd2.id, jpy2.id].includes(item.target),
            ),
          );

          assert.equal(
            (await call('/sales', { cookie: employee.cookie })).status,
            200,
          );
          const records = (
            await pool.query(
              'SELECT invoice_id,currency,rate_bps,released_cents::text AS amount_cents FROM sales_commissions WHERE staff_id=$1',
              [employee.id],
            )
          ).rows;
          for (const [bill, rate, amount] of [
            [usd1, 1000, '100'],
            [jpy1, 1000, '10'],
            [usd2, 2000, '200'],
            [jpy2, 3000, '30'],
          ] as const) {
            const row = records.find((item) => item.invoice_id === bill.id);
            assert.equal(row.rate_bps, rate);
            assert.equal(row.currency, bill.currency);
            assert.equal(row.amount_cents, amount);
          }
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) FROM affiliate_commissions WHERE invoice_id=ANY($1::uuid[])',
                [[usd1.id, jpy1.id, usd2.id, jpy2.id]],
              )
            ).rows[0].count,
            '0',
          );
          const balances = async () => {
            const reply = await call('/sales', { cookie: employee.cookie });
            assert.equal(reply.status, 200, JSON.stringify(reply.body));
            return Object.fromEntries(
              reply.body.balances.map((item: any) => [item.currency, item]),
            );
          };
          let funds = await balances();
          assert.equal(funds.USD.balanceCents, '300');
          assert.equal(funds.JPY.balanceCents, '40');
          await refund(usd1.id, '500');
          await refund(jpy1.id, '100');
          funds = await balances();
          assert.equal(funds.USD.availableCents, '250');
          assert.equal(funds.JPY.availableCents, '30');
          for (const [currency, amountCents] of [
            ['USD', '250'],
            ['JPY', '30'],
          ] as const) {
            const withdrawal = await call('/sales/withdrawals', {
              method: 'POST',
              cookie: employee.cookie,
              key: randomUUID(),
              body: {
                currency,
                amountCents,
                payee: {
                  method: 'bank',
                  name: '外币员工',
                  account: 'SYNTHETIC-FX-ONLY',
                },
                password,
              },
            });
            assert.equal(
              withdrawal.status,
              201,
              JSON.stringify(withdrawal.body),
            );
            const paid = await call(
              `/admin/sales/withdrawals/${withdrawal.body.id}/process`,
              {
                method: 'POST',
                cookie: admin.cookie,
                body: {
                  action: 'pay',
                  reference: `synthetic-sales-${currency}-${randomUUID()}`,
                  paidAt: new Date().toISOString(),
                  password,
                },
              },
            );
            assert.equal(paid.status, 201, JSON.stringify(paid.body));
          }
          funds = await balances();
          assert.equal(funds.USD.balanceCents, '0');
          assert.equal(funds.JPY.balanceCents, '0');
          const query = new URLSearchParams({
            from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
            to: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            bucket: 'day',
          });
          const report = await call('/admin/reports?' + query, {
            cookie: admin.cookie,
          });
          assert.equal(report.status, 200, JSON.stringify(report.body));
          const rows = Object.fromEntries(
            report.body.summary.map((item: any) => [item.currency, item]),
          );
          assert.equal(rows.USD.incomeNetCents, '1500');
          assert.equal(rows.USD.cashInCents, '2000');
          assert.equal(rows.USD.cashOutCents, '750');
          assert.equal(rows.JPY.incomeNetCents, '100');
          assert.equal(rows.JPY.cashInCents, '200');
          assert.equal(rows.JPY.cashOutCents, '130');
          for (const currency of ['USD', 'JPY']) {
            query.set('currency', currency);
            const filtered = await call('/admin/reports?' + query, {
              cookie: admin.cookie,
            });
            assert.equal(filtered.status, 200);
            for (const key of ['summary', 'timeline', 'customers', 'products'])
              assert.ok(
                filtered.body[key].every(
                  (item: any) => item.currency === currency,
                ),
              );
          }
          await assert.rejects(
            pool.query(
              "UPDATE sales_payouts SET currency='CNY' WHERE staff_id=$1",
              [employee.id],
            ),
          );
        },
      );
    } finally {
      if (server && server.exitCode === null) {
        const ended = new Promise<void>((resolve) =>
          server!.once('exit', () => resolve()),
        );
        server.kill('SIGTERM');
        await Promise.race([
          ended,
          new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      if (application) {
        const { redis, pool } = application;
        if (redis.isOpen) {
          await redis.del([
            ...users.flatMap((id) => [
              `account-proof:user:${id}`,
              `account-factor:${id}`,
            ]),
            ...emails.map((email) => `login:${digest(email)}`),
            `login:${digest(ip)}`,
            `account-proof:ip:${digest(ip)}`,
            ...tokens.map((token) => `session:${digest(token)}`),
          ]);
          await redis.quit();
        }
        await pool.end();
      }
      if (created) await master.query(`DROP DATABASE ${name} WITH(FORCE)`);
      await master.end();
    }
  },
);
