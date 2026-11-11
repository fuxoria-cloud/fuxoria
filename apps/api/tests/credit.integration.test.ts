/* 充值和信用付款：随机数据库内运行真实API，核对归属、并发额度和原子扣款。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/credit.integration.test.ts。
 * 本轮只删除随机测试库与本轮会话，不操作开发业务记录；退款出站只在测试进程替换为离线响应。
 */
import "reflect-metadata"; // 直接调度主体与真实HTTP共享装饰器元数据
import test from "node:test"; // 一组场景共享明确的测试业务事实
import assert from "node:assert/strict"; // 同时断言HTTP和数据库
import { createHash, randomBytes, randomUUID } from "node:crypto"; // 账号、密钥、会话都只属于本次
import { readdir, readFile } from "node:fs/promises"; // 按实际迁移文件创建本轮测试库
import { spawn, type ChildProcess } from "node:child_process"; // 主业务进程执行实际API入口
import { createServer } from "node:net"; // 操作系统分配空闲端口
import pg from "pg"; // 真实PostgreSQL约束与行锁
import { createClient } from "redis"; // 会话走生产认证边界
import { hash, argon2id } from "argon2"; // 密码证明不替换算法
import { verifyAudit } from "../../../scripts/verify-audit.js"; // 验证跨主体审计链

test(
  "充值、退款预留与信用额度保持资金守恒",
  { timeout: 180000 },
  async (context) => {
    const source = process.env.DATABASE_URL!;
    const testIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`; // 每轮独立来源，保留真实限流而不共享其它验收预算
    assert.ok(source);
    const name = "yunzou_credit_" + randomBytes(8).toString("hex"); // 随机名称只含安全字符
    const address = new URL(source);
    address.pathname = "/" + name;
    const master = new pg.Client({ connectionString: source }),
      db = new pg.Pool({ connectionString: address.href }),
      cache = createClient({ url: process.env.REDIS_URL }); // 新库不混入用户记录
    const merchant = "finance-" + randomBytes(6).toString("hex"),
      gatewayKey = randomBytes(32).toString("hex"),
      secret = randomBytes(32).toString("hex"),
      password = "Documents-" + randomBytes(16).toString("hex"),
      tokens: string[] = [],
      users: string[] = []; // 不把凭据放入断言日志
    let child: ChildProcess | undefined,
      created = false,
      logs = ""; // 清理只覆盖本轮创建的资源
    try {
      await master.connect();
      await master.query(`CREATE DATABASE ${name}`);
      created = true; // 本轮可独立销毁
      await db.query(
        "CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL)",
      );
      const directory = new URL(
        "../../../database/migrations/",
        import.meta.url,
      ); // 生产入口会核对迁移摘要
      for (const file of (await readdir(directory))
        .filter(
          (value) =>
            value.endsWith(".sql") ||
            value.endsWith('.draft'),
        )
        .sort()) {
        const text = await readFile(new URL(file, directory), "utf8");
        await db.query("BEGIN");
        await db.query(text);
        await db.query("INSERT INTO migrations(name,hash) VALUES($1,$2)", [
          file,
          createHash("sha256").update(text).digest("hex"),
        ]);
        await db.query("COMMIT"); // 真实完整迁移
      }
      await cache.connect();
      const listener = createServer();
      await new Promise<void>((resolve) =>
        listener.listen(0, "127.0.0.1", resolve),
      );
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve())); // 不硬编码并行测试端口
      const origin = "https://finance.yunzou.test",
        base = `http://127.0.0.1:${port}/api/v1`;
      child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/api/src/main.ts"],
        {
          cwd: new URL("../../../", import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: address.href,
            AUDIT_KEY: secret,
            TOTP_KEY: randomBytes(32).toString("hex"),
            PUBLIC_ORIGIN: origin,
            HOST: "127.0.0.1",
            PORT: String(port),
            EPAY_VERSION: "1",
            EPAY_URL: "https://finance-pay.example.invalid/submit.php",
            EPAY_PID: merchant,
            EPAY_KEY: gatewayKey,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ); // 完整入口自动扫描业务
      child.stdout?.on("data", (value) => {
        logs = (logs + value).slice(-8000);
      });
      child.stderr?.on("data", (value) => {
        logs = (logs + value).slice(-8000);
      }); // 只在故障时回报非敏感末尾
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          ready = (await fetch(base + "/health")).ok;
        } catch {}
        if (ready) break;
        if (child.exitCode !== null) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, logs); // 等实际健康检查
      type Actor = { id: string; email: string; cookie: string };
      const savedPassword = await hash(password, { type: argon2id }); // 每个测试账号同一随机口令便于本人证明
      const call = async (
        method: string,
        path: string,
        actor?: Actor,
        body?: unknown,
        key?: string,
      ) => {
        const headers: Record<string, string> = {
          origin,
          "content-type": "application/json",
          "x-forwarded-for": testIp,
        };
        if (actor) headers.cookie = actor.cookie;
        if (key) headers["idempotency-key"] = key; // 写动作必须通过真实Origin检查
        const response = await fetch(base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        const binary = response.headers
          .get("content-type")
          ?.includes("application/pdf");
        let data: any;
        if (binary) data = Buffer.from(await response.arrayBuffer());
        else {
          const raw = await response.text();
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
        } // PDF不能假装JSON
        for (const cookie of response.headers.getSetCookie()) {
          const value = /^yunzou_session=([^;]+)/.exec(cookie)?.[1];
          if (value) tokens.push(decodeURIComponent(value));
        } // 只保留清理所需随机会话
        return {
          status: response.status,
          data,
          headers: response.headers,
          expected: method === "POST" ? 201 : 200,
        };
      };
      const expect = (
        response: { status: number; data: any; expected?: number },
        status?: number,
      ) => {
        assert.equal(
          response.status,
          status ?? response.expected ?? 201,
          response.status >= 500
            ? logs
            : response.status >= 400
              ? JSON.stringify(response.data)
              : "HTTP状态不符",
        );
        return response.data;
      }; // 不输出成功响应中的敏感证明
      const actor = async (role = "customer"): Promise<Actor> => {
        const id = randomUUID(),
          email = randomUUID() + "@documents.invalid";
        users.push(id);
        await db.query(
          "INSERT INTO users(id,email,name,password,role) VALUES($1,$2,$3,$4,$5)",
          [id, email, "文档验收客户", savedPassword, role],
        );
        const response = await call("POST", "/auth/login", undefined, {
          email,
          password,
        });
        expect(response);
        return {
          id,
          email,
          cookie: response.headers
            .getSetCookie()
            .find((value) => value.startsWith("yunzou_session="))!
            .split(";")[0],
        };
      }; // 生产登录实际签发会话
      const alice = await actor(),
        bob = await actor(),
        admin = await actor("admin"); // 两方归属及管理员决策独立
      const opening = async (person: Actor, amount = "100000") => {
        const c = await db.connect();
        try {
          await c.query("BEGIN");
          const id = randomUUID(),
            balance = randomUUID();
          await c.query(
            "INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary) VALUES($1,$2,$3,$4,$5)",
            [
              id,
              "documents-" + id,
              "0123456789ABCDEF",
              randomBytes(32).toString("hex"),
              {},
            ],
          );
          await c.query(
            "INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,'CNY',$4,now())",
            [balance, id, person.id, amount],
          );
          const ledger = (
            await c.query(
              "INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,'CNY') RETURNING id",
              [balance],
            )
          ).rows[0];
          await c.query(
            "INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,'migration:equity',$4)",
            [
              ledger.id,
              "wallet:" + person.id,
              (-BigInt(amount)).toString(),
              amount,
            ],
          );
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        } finally {
          c.release();
        } // 使用真实期初来源，不伪造现金
      };
      await opening(alice);
      await opening(bob); // 仅隔离库钱包用于支付
      const cash = async (
        person: Actor,
        bill: { invoiceId: string; amountCents: string },
        transactionId = randomUUID(),
      ) => {
        expect(
          await call("POST", `/invoices/${bill.invoiceId}/checkout`, person, {
            gateway: "epay",
          }),
        );
        const amount = BigInt(bill.amountCents);
        const fields: Record<string, string> = {
          pid: merchant,
          out_trade_no: bill.invoiceId.replaceAll("-", ""),
          trade_no: transactionId,
          money: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
          trade_status: "TRADE_SUCCESS",
        };
        fields.sign = createHash("md5")
          .update(
            Object.keys(fields)
              .sort()
              .map((key) => `${key}=${fields[key]}`)
              .join("&") + gatewayKey,
          )
          .digest("hex");
        fields.sign_type = "MD5";
        expect(
          await call(
            "GET",
            "/payments/epay/notify?" + new URLSearchParams(fields),
          ),
          200,
        );
        return "/payments/epay/notify?" + new URLSearchParams(fields); // 真正通过HTTP验签和事务入账
      };
      const previous = {
        database: process.env.DATABASE_URL,
        audit: process.env.AUDIT_KEY,
      };
      process.env.DATABASE_URL = address.href;
      process.env.AUDIT_KEY = secret; // 直接调度使用同一隔离库
      const store = await import("../src/features/store.js");
      await store.connect();
      try {
        await context.test(
          "真实充值不虚构商品/资源/收入，通知与提交重试只增加一次余额",
          async () => {
            const person = await actor(),
              key = randomUUID(),
              bill = expect(
                await call(
                  "POST",
                  "/wallet/recharges",
                  person,
                  { amountCents: "10000" },
                  key,
                ),
              );
            assert.equal(
              expect(
                await call(
                  "POST",
                  "/wallet/recharges",
                  person,
                  { amountCents: "10000" },
                  key,
                ),
              ).invoiceId,
              bill.invoiceId,
            );
            expect(
              await call(
                "POST",
                "/wallet/recharges",
                person,
                { amountCents: "20000" },
                key,
              ),
              409,
            );
            expect(
              await call(
                "POST",
                `/invoices/${bill.invoiceId}/pay-wallet`,
                person,
              ),
              409,
            ); // 自循环充值无效
            const callback = await cash(person, bill);
            expect(await call("GET", callback), 200);
            const wallet = expect(await call("GET", "/wallet", person), 200);
            assert.equal(wallet.balanceCents, "10000");
            assert.equal(wallet.availableCents, "10000");
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM services WHERE order_id=$1",
                  [bill.id],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN payment_receipts p ON p.id=t.receipt_id WHERE p.invoice_id=$1 AND e.account LIKE 'income:%'",
                  [bill.invoiceId],
                )
              ).rows[0].n,
              0,
            ); // 现金增加与客户负债增加，不重复认收入
            assert.ok(
              expect(await call("GET", "/invoices", person), 200).some(
                (item: any) => item.id === bill.invoiceId,
              ),
            );
            assert.ok(
              !expect(
                await call("GET", "/tax-eligible-invoices", person),
                200,
              ).some((item: any) => item.id === bill.invoiceId),
            ); // 充值和后续消费不能重复申请商品发票
            const reserved = expect(
              await call(
                "POST",
                `/invoices/${bill.invoiceId}/refunds`,
                person,
                { amountCents: "9000", reason: "退回未使用充值" },
                randomUUID(),
              ),
            );
            assert.equal(
              expect(await call("GET", "/wallet", person), 200).availableCents,
              "1000",
            );
            const p = expect(
              await call("POST", "/admin/products", admin, {
                name: "预留消费测试",
                description: "隔离",
                priceCents: "2000",
                stock: 10,
                provider: "manual",
                currency: "CNY",
                active: true,
              }),
            );
            const order = expect(
              await call(
                "POST",
                "/orders",
                person,
                { productId: p.id, period: "month" },
                randomUUID(),
              ),
            );
            expect(
              await call(
                "POST",
                `/invoices/${order.invoiceId}/pay-wallet`,
                person,
              ),
              409,
            );
            expect(
              await call(
                "POST",
                `/invoices/${bill.invoiceId}/refunds`,
                person,
                { amountCents: "1001", reason: "超过剩余额度" },
                randomUUID(),
              ),
              409,
            ); // 同一余额不能花掉又退款
            const payment = await import("../src/features/payment.js");
            await payment.loadPayments();
            const get = payment.payments.get.bind(payment.payments);
            payment.payments.get = (id: string) =>
              id === "epay"
                ? {
                    name: "仅本轮隔离退款传输",
                    configured: true,
                    acknowledgment: "success",
                    async create() {
                      throw new Error("不产生测试付款链接");
                    },
                    async verify() {
                      throw new Error("签名已由真实HTTP覆盖");
                    },
                    async refund() {
                      return {
                        status: "succeeded" as const,
                        reference: "isolated-refund-" + reserved.id,
                      };
                    },
                  }
                : get(id); // 只有测试进程的出站传输被离线替代
            try {
              const { default: Refund } = await import(
                "../src/features/refund.js"
              );
              const approved = await new Refund().approve(
                reserved.id,
                { password },
                {
                  user: {
                    id: admin.id,
                    email: admin.email,
                    name: "管理员",
                    role: "admin",
                  },
                  actorId: admin.id,
                  requestId: randomUUID(),
                  ip: "127.0.0.1",
                } as any,
              );
              assert.equal(approved.status, "succeeded");
            } finally {
              payment.payments.get = get;
            } // 退款和反向分录仍走真实主体
            const after = expect(await call("GET", "/wallet", person), 200);
            assert.equal(after.balanceCents, "1000");
            assert.equal(after.heldCents, "0");
            assert.equal(after.availableCents, "1000");
            const entries = (
              await db.query(
                "SELECT e.account,e.amount_cents::text FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.refund_id=$1 ORDER BY account",
                [reserved.id],
              )
            ).rows;
            assert.ok(
              entries.some(
                (row) =>
                  row.account === "wallet:" + person.id &&
                  row.amount_cents === "9000",
              ),
            ); // 退款冲客户负债，不冲商品收入
          },
        );
        await context.test(
          "同一充值的退款占额与消费竞争只能成功一种",
          async () => {
            const person = await actor(),
              bill = expect(
                await call(
                  "POST",
                  "/wallet/recharges",
                  person,
                  { amountCents: "10000" },
                  randomUUID(),
                ),
              );
            await cash(person, bill); // 一笔实际充值供并发双方争用
            const product = expect(
                await call("POST", "/admin/products", admin, {
                  name: "并发消费与退款",
                  description: "隔离",
                  priceCents: "2000",
                  stock: 10,
                  provider: "manual",
                  currency: "CNY",
                  active: true,
                }),
              ),
              order = expect(
                await call(
                  "POST",
                  "/orders",
                  person,
                  { productId: product.id, period: "month" },
                  randomUUID(),
                ),
              ); // 合计支出超过充值余额
            const results = await Promise.all([
              call(
                "POST",
                `/invoices/${bill.invoiceId}/refunds`,
                person,
                { amountCents: "9000", reason: "未使用资金退款" },
                randomUUID(),
              ),
              call("POST", `/invoices/${order.invoiceId}/pay-wallet`, person),
            ]);
            assert.deepEqual(
              results.map((value) => value.status).sort(),
              [201, 409],
              logs,
            ); // 两个入口共用钱包锁与数据库占额
            assert.ok(
              BigInt(
                expect(await call("GET", "/wallet", person), 200)
                  .availableCents,
              ) >= 0n,
            ); // 没有负可用余额或双重支出
          },
        );
        await context.test('已开票先登记实际红冲，原票据和更正均保留',async()=>{
          const person=await actor(),product=expect(await call('POST','/admin/products',admin,{name:'票据退款核对',description:'隔离',priceCents:'800',stock:5,provider:'manual',currency:'CNY',active:true})),bill=expect(await call('POST','/orders',person,{productId:product.id,period:'month'},randomUUID()));await cash(person,bill);
          const profile=expect(await call('POST','/tax-profiles',person,{title:'隔离票据客户',type:'person',invoiceType:'ordinary',email:person.email})),tax=expect(await call('POST','/tax-requests',person,{profileId:profile.id,invoiceIds:[bill.invoiceId]},randomUUID()));const {assertTaxRefundable}=await import('../src/features/voucher.js');
          await assert.rejects(store.transaction((connection:any)=>assertTaxRefundable(connection,bill.invoiceId)),/请先/);expect(await call('POST',`/admin/tax-requests/${tax.id}/process`,admin,{action:'issue',invoiceNumber:'TEST-ORIGINAL-800',password}));await assert.rejects(store.transaction((connection:any)=>assertTaxRefundable(connection,bill.invoiceId)),/红字/);
          const body={invoiceNumber:'TEST-RED-800',reason:'商户已在外部开具全额红字发票，登记核对',documentUrl:'https://invoice.example.invalid/red-800.pdf',password};expect(await call('POST',`/admin/tax-requests/${tax.id}/red-letter`,admin,body));expect(await call('POST',`/admin/tax-requests/${tax.id}/red-letter`,admin,body));await store.transaction((connection:any)=>assertTaxRefundable(connection,bill.invoiceId));const original=(await db.query('SELECT invoice_number,status FROM tax_requests WHERE id=$1',[tax.id])).rows[0];assert.equal(original.invoice_number,'TEST-ORIGINAL-800');assert.equal(original.status,'issued');await assert.rejects(db.query("DELETE FROM tax_red_documents WHERE request_id=$1",[tax.id]),/只能追加/);
          const listed=expect(await call('GET','/tax-requests',person),200);assert.equal(listed.find((row:any)=>row.id===tax.id).redDocument.invoiceNumber,'TEST-RED-800');const refund=expect(await call('POST',`/invoices/${bill.invoiceId}/refunds`,person,{amountCents:'800',reason:'已核对票据后退款'},randomUUID()));assert.equal(refund.status,'requested'); // 红冲登记本身不会伪造资金已退
        });
        await context.test(
          "授信借用并发不超限，还款不能循环借款且实际到账才恢复额度",
          async () => {
            expect(
              await call("PUT", "/admin/credit/" + alice.id, admin, {
                enabled: true,
                limitCents: "1000",
                billingDay: 1,
                repaymentDays: 15,
                note: "隔离授信验证",
                password,
              }),
            );
            const bills = [];
            for (const value of ["500", "700"]) {
              const p = expect(
                await call("POST", "/admin/products", admin, {
                  name: "信用并发测试",
                  description: "隔离",
                  priceCents: value,
                  stock: 10,
                  provider: "manual",
                  currency: "CNY",
                  active: true,
                }),
              );
              bills.push(
                expect(
                  await call(
                    "POST",
                    "/orders",
                    alice,
                    { productId: p.id, period: "month" },
                    randomUUID(),
                  ),
                ),
              );
            } // 两单合计超过额度
            const paid = await Promise.all(
              bills.map((bill) =>
                call("POST", `/invoices/${bill.invoiceId}/pay-credit`, alice, {
                  password,
                }),
              ),
            );
            assert.deepEqual(
              paid.map((value) => value.status).sort(),
              [201, 409],
              logs,
            );
            const used = expect(
              await call("GET", "/credit", alice),
              200,
            ).usedCents;
            assert.ok(["500", "700"].includes(used));
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM credit_payments WHERE user_id=$1",
                  [alice.id],
                )
              ).rows[0].n,
              1,
            ); // 并发没有第二笔应收款
            expect(
              await call("PUT", "/admin/credit/" + alice.id, admin, {
                enabled: true,
                limitCents: "1",
                billingDay: 1,
                repaymentDays: 15,
                note: "错误下调",
                password,
              }),
              409,
            );
            const recharge = expect(
              await call(
                "POST",
                "/wallet/recharges",
                alice,
                { amountCents: "100" },
                randomUUID(),
              ),
            );
            expect(
              await call(
                "POST",
                `/invoices/${recharge.invoiceId}/pay-credit`,
                alice,
                { password },
              ),
              409,
            ); // 授信不可套取现金
            const key = randomUUID(),
              repay = expect(
                await call("POST", "/credit/repayments", alice, {}, key),
              );
            assert.equal(repay.amountCents, used);
            assert.equal(
              expect(await call("POST", "/credit/repayments", alice, {}, key))
                .invoiceId,
              repay.invoiceId,
            );
            expect(
              await call(
                "POST",
                `/invoices/${repay.invoiceId}/pay-credit`,
                alice,
                { password },
              ),
              409,
            );
            assert.equal(
              expect(await call("GET", "/credit", alice), 200).usedCents,
              used,
            ); // 创建还款单不算已偿还
            await cash(alice, repay);
            assert.equal(
              expect(await call("GET", "/credit", alice), 200).usedCents,
              "0",
            );
            expect(
              await call(
                "POST",
                `/invoices/${repay.invoiceId}/refunds`,
                alice,
                { amountCents: used, reason: "不能重复提取" },
                randomUUID(),
              ),
              409,
            );
            const count = (
              await db.query(
                "SELECT count(*)::int n FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN payment_receipts p ON p.id=t.receipt_id WHERE p.invoice_id=$1 AND account LIKE 'income:%'",
                [repay.invoiceId],
              )
            ).rows[0].n;
            assert.equal(count, 0); // 还款不重复计收入
          },
        );
        await context.test(
          "月结跨实例只出一单，余额还款冲应收款而非重复收入",
          async () => {
            const p = expect(
              await call("POST", "/admin/products", admin, {
                name: "月结测试",
                description: "隔离",
                priceCents: "300",
                stock: 10,
                provider: "manual",
                currency: "CNY",
                active: true,
              }),
            );
            const bill = expect(
              await call(
                "POST",
                "/orders",
                alice,
                { productId: p.id, period: "month" },
                randomUUID(),
              ),
            );
            expect(
              await call(
                "POST",
                `/invoices/${bill.invoiceId}/pay-credit`,
                alice,
                { password },
              ),
            );
            const date = (
              await db.query(
                "SELECT bill_at FROM credit_payments WHERE invoice_id=$1",
                [bill.invoiceId],
              )
            ).rows[0].bill_at;
            const { default: Credit } = await import(
              "../src/features/credit.js"
            );
            const future = new Date(date.getTime() + 60000);
            const results = await Promise.all([
              new Credit().run(future),
              new Credit().run(future),
            ]);
            assert.equal(
              results.reduce((sum, value) => sum + value, 0),
              1,
            ); // 不修改不可变借款快照即可测试未来月结
            const repayment = (
              await db.query(
                "SELECT i.id FROM credit_repayment_items r JOIN credit_payments p ON p.id=r.payment_id JOIN invoices i ON i.order_id=r.order_id WHERE p.invoice_id=$1",
                [bill.invoiceId],
              )
            ).rows[0];
            expect(
              await call("POST", `/invoices/${repayment.id}/pay-wallet`, alice),
            );
            assert.equal(
              expect(await call("GET", "/credit", alice), 200).usedCents,
              "0",
            );
            assert.equal(await new Credit().run(future), 0); // 补偿重跑不生成第二张还款账单
          },
        );
        assert.ok((await verifyAudit(db, secret)).count > 0);
        const actions = new Set(
          (await db.query("SELECT DISTINCT action FROM audit")).rows.map(
            (row) => row.action,
          ),
        );
        for (const action of [
          "wallet.recharge_created",
          "wallet.pay",
          "credit.pay",
          "credit.repayment_created",
          "invoice.settle",
          "refund.succeed",
        ])
          assert.ok(actions.has(action), action); // 充值、借用、还款、退款都仍能连续验链
      } finally {
        await store.close();
        process.env.DATABASE_URL = previous.database;
        process.env.AUDIT_KEY = previous.audit;
      } // 避免污染其他测试进程
    } finally {
      if (child && child.exitCode === null) {
        const ended = new Promise((resolve) => child!.once("exit", resolve));
        child.kill("SIGTERM");
        await ended;
      } // 停止本轮API与账期时钟
      if (cache.isOpen) {
        await cache.del("login:" + createHash("sha256").update(testIp).digest("hex")); // 只清理本轮来源预算
        for (const token of tokens)
          await cache.del(
            "session:" + createHash("sha256").update(token).digest("hex"),
          );
        for (const id of users) await cache.del(`account-proof:user:${id}`);
        await cache.quit();
      } // 只清理本轮会话与证明键
      await db.end();
      if (created) await master.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await master.end(); // 不保留临时财务事实
    }
  },
);
