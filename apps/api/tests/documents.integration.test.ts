/* 合同、开票和服务生命周期：随机数据库内运行真实API，核对归属、并发额度和原子扣款。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/documents.integration.test.ts。
 * 本轮只删除随机测试库与本轮会话，不操作开发业务记录；PDF还用独立pdftotext核验中文文本。
 */
import "reflect-metadata"; // 直接调度主体与真实HTTP共享装饰器元数据
import test from "node:test"; // 一组场景共享明确的测试业务事实
import assert from "node:assert/strict"; // 同时断言HTTP和数据库
import { createHash, randomBytes, randomUUID } from "node:crypto"; // 账号、密钥、会话都只属于本次
import { readdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises"; // 临时PDF及迁移按实际文件读取
import { join } from "node:path"; // 不拼接shell命令
import { tmpdir } from "node:os"; // 文档测试放独立临时目录
import { spawn, execFile, type ChildProcess } from "node:child_process"; // 主业务进程与PDF验证都执行真实产物
import { promisify } from "node:util"; // 命令失败直接使断言失败
import { createServer } from "node:net"; // 操作系统分配空闲端口
import pg from "pg"; // 真实PostgreSQL约束与行锁
import { createClient } from "redis"; // 会话走生产认证边界
import { hash, argon2id } from "argon2"; // 密码证明不替换算法
import { verifyAudit } from "../../../scripts/verify-audit.js"; // 验证跨主体审计链

test(
  "合同、开票、周期续费、取消与转移保持实际资金和归属",
  { timeout: 180000 },
  async (context) => {
    const source = process.env.DATABASE_URL!;
    const testIp = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`; // 每轮独立来源，保留真实限流而不共享其它验收预算
    assert.ok(source);
    const name = "yunzou_documents_" + randomBytes(8).toString("hex"); // 随机名称只含安全字符
    const address = new URL(source);
    address.pathname = "/" + name;
    const master = new pg.Client({ connectionString: source }),
      db = new pg.Pool({ connectionString: address.href }),
      cache = createClient({ url: process.env.REDIS_URL }); // 新库不混入用户记录
    const secret = randomBytes(32).toString("hex"),
      password = "Documents-" + randomBytes(16).toString("hex"),
      tokens: string[] = [],
      users: string[] = []; // 不把凭据放入断言日志
    let child: ChildProcess | undefined,
      created = false,
      logs = "",
      temporary = ""; // 清理只覆盖本轮创建的资源
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
        .filter((value) => value.endsWith(".sql") || value.endsWith(".draft"))
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
      const origin = `http://127.0.0.1:${port}`,
        base = origin + "/api/v1";
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
            RUN_BATCHES: "false",
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
        const data = binary
          ? Buffer.from(await response.arrayBuffer())
          : await response.json(); // PDF不能假装JSON
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
          response.status >= 400
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
          "INSERT INTO users(id,email,name,password,role,email_verified_at) VALUES($1,$2,$3,$4,$5,now())",
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
      const resource = async (
        person = alice,
        period = "quarter",
        price = "1234",
      ) => {
        const p = expect(
          await call("POST", "/admin/products", admin, {
            name: "文档生命周期验收",
            description: "隔离库资源",
            priceCents: price,
            currency: "CNY",
            provider: "manual",
            stock: 100,
            active: true,
          }),
        ); // 建真正可订购商品
        expect(
          await call("PUT", `/admin/catalogue/products/${p.id}`, admin, {
            periods: [{ period, priceCents: price }],
            options: [],
          }),
        ); // 合同周期由后台配置
        const order = expect(
          await call(
            "POST",
            "/orders",
            person,
            { productId: p.id, period },
            randomUUID(),
          ),
        );
        if (order.status !== "paid")
          expect(
            await call(
              "POST",
              `/invoices/${order.invoiceId}/pay-wallet`,
              person,
            ),
          ); // 真正双分录付款
        const job = (
          await db.query(
            "SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",
            [order.serviceId],
          )
        ).rows[0];
        expect(
          await call("POST", `/admin/jobs/${job.id}/complete`, admin, {
            externalId: "isolated-" + randomUUID(),
          }),
        );
        return { ...order, productId: p.id }; // 人工资源必须明确交付事实
      };
      let first: any,
        templateId = "",
        contractId = "",
        taxId = "";
      await context.test("季度合同到期、配置快照与实际续费增量", async () => {
        first = await resource();
        const old = (
          await db.query("SELECT due_at::text FROM services WHERE id=$1", [
            first.serviceId,
          ])
        ).rows[0].due_at;
        expect(
          await call(
            "POST",
            `/services/${first.serviceId}/renew`,
            alice,
            { period: "month" },
            randomUUID(),
          ),
          409,
        ); // 不能用月付按钮改季度合同
        const bill = expect(
          await call(
            "POST",
            `/services/${first.serviceId}/renew`,
            alice,
            { period: "quarter" },
            randomUUID(),
          ),
        );
        assert.equal(bill.amountCents, "1234");
        expect(
          await call("POST", `/invoices/${bill.invoiceId}/pay-wallet`, alice),
        ); // 扣费金额与原合同一致
        const correct = (
          await db.query(
            "SELECT due_at=$2::timestamptz+interval '3 months' AS ok FROM services WHERE id=$1",
            [first.serviceId, old],
          )
        ).rows[0];
        assert.equal(correct.ok, true); // 日历月交给PostgreSQL计算
        const one = await resource(alice, "onetime", "0");
        assert.equal(
          (
            await db.query("SELECT due_at FROM services WHERE id=$1", [
              one.serviceId,
            ])
          ).rows[0].due_at,
          null,
        );
        expect(
          await call(
            "POST",
            `/services/${one.serviceId}/renew`,
            alice,
            { period: "onetime" },
            randomUUID(),
          ),
          409,
        ); // 一次性资源不能续费
      });
      await context.test(
        "合同快照、幂等、错误指纹、本人证明与中文PDF",
        async () => {
          templateId = expect(
            await call("POST", "/admin/contract-templates", admin, {
              title: "狐岚云服务合同",
              content:
                "签约人{{name}}，产品{{product}}，服务{{service}}。\n确认约定条款后签署。",
            }),
          ).id;
          const input = {
              templateId,
              serviceId: first.serviceId,
              party: {
                name: "张三",
                company: "",
                address: "上海市测试路1号",
                phone: "13800138000",
                email: alice.email,
              },
            },
            key = randomUUID();
          contractId = expect(
            await call("POST", "/contracts", alice, input, key),
          ).id;
          assert.equal(
            expect(await call("POST", "/contracts", alice, input, key)).id,
            contractId,
          );
          expect(
            await call("POST", "/contracts", alice, input, randomUUID()),
            409,
          ); // 同一服务模板只有一份有效合同
          const snapshot = expect(
            await call("GET", "/contracts/" + contractId, alice),
            200,
          );
          assert.match(snapshot.snapshot.content, /张三/);
          expect(
            await call(
              "PUT",
              "/admin/contract-templates/" + templateId,
              admin,
              { title: "修改后的模板", content: "后来修改的条款" },
            ),
          );
          assert.equal(
            expect(await call("GET", "/contracts/" + contractId, alice), 200)
              .snapshotHash,
            snapshot.snapshotHash,
          ); // 模板变更不能重写原文
          expect(
            await call("POST", `/contracts/${contractId}/sign`, alice, {
              signer: "张三",
              accept: true,
              snapshotHash: "0".repeat(64),
              password,
            }),
            409,
          );
          expect(await call("GET", "/contracts/" + contractId, bob), 404); // 不能替换文本或看旁人合同
          const signature = {
            signer: "张三",
            accept: true,
            snapshotHash: snapshot.snapshotHash,
            password,
          };
          expect(
            await call(
              "POST",
              `/contracts/${contractId}/sign`,
              alice,
              signature,
            ),
          );
          expect(
            await call(
              "POST",
              `/contracts/${contractId}/sign`,
              alice,
              signature,
            ),
          ); // 成功重试不重写签署时间
          await assert.rejects(
            db.query("UPDATE contracts SET snapshot='{}' WHERE id=$1", [
              contractId,
            ]),
            /快照/,
          );
          const document = await call(
            "GET",
            `/contracts/${contractId}/document`,
            alice,
          );
          expect(document, 200);
          assert.equal(document.data.subarray(0, 5).toString(), "%PDF-");
          temporary = await mkdtemp(join(tmpdir(), "yunzou-documents-"));
          const filename = join(temporary, "contract.pdf");
          await writeFile(filename, document.data);
          const text = (await promisify(execFile)("pdftotext", [filename, "-"]))
            .stdout;
          assert.match(text, /张三/);
          assert.match(text, /狐岚云服务合同/); // 中文文本可以独立提取
        },
      );
      await context.test("抬头边界、净额开票、并发独占与实际票号", async () => {
        expect(
          await call("POST", "/tax-profiles", alice, {
            title: "不完整企业",
            type: "company",
            invoiceType: "special",
            email: alice.email,
          }),
          400,
        );
        const profile = expect(
          await call("POST", "/tax-profiles", alice, {
            title: "张三",
            type: "person",
            invoiceType: "ordinary",
            email: alice.email,
          }),
        ); // 专票不能缺少企业信息
        const available = expect(
          await call("GET", "/tax-eligible-invoices", alice),
          200,
        );
        assert.ok(available.some((value: any) => value.id === first.invoiceId));
        const body = { profileId: profile.id, invoiceIds: [first.invoiceId] };
        const results = await Promise.all([
          call("POST", "/tax-requests", alice, body, randomUUID()),
          call("POST", "/tax-requests", alice, body, randomUUID()),
        ]);
        assert.deepEqual(
          results.map((value) => value.status).sort(),
          [201, 409],
        );
        taxId = results.find((value) => value.status === 201)!.data.id; // 不同幂等键也不能同一账单重复开票
        expect(
          await call("POST", `/admin/tax-requests/${taxId}/process`, admin, {
            action: "issue",
            password,
          }),
          409,
        );
        expect(
          await call("POST", `/admin/tax-requests/${taxId}/process`, admin, {
            action: "approve",
            password,
          }),
        );
        expect(
          await call("POST", `/admin/tax-requests/${taxId}/process`, admin, {
            action: "issue",
            invoiceNumber: "TEST-INVOICE-2026",
            documentUrl: "https://invoice.example.invalid/actual.pdf",
            password,
          }),
        ); // 实际开具事实必须由管理员输入
        const row = (
          await db.query(
            "SELECT status,invoice_number FROM tax_requests WHERE id=$1",
            [taxId],
          )
        ).rows[0];
        assert.equal(row.status, "issued");
        assert.equal(row.invoice_number, "TEST-INVOICE-2026");
        expect(await call("GET", `/tax-requests/${taxId}/document`, bob), 404);
        await assert.rejects(
          db.query("UPDATE tax_requests SET status='pending' WHERE id=$1", [
            taxId,
          ]),
          /快照|终态/,
        ); // 已开具事实不可重置
      });
      await context.test(
        "服务转移需双方本人证明，保留旧账单并清除授权",
        async () => {
          const owned = await resource();
          const group = expect(
            await call("POST", "/service-groups", alice, {
              name: "原客户分组",
            }),
          );
          expect(
            await call("PATCH", "/services/" + owned.serviceId, alice, {
              remark: "原账号私有备注",
              groupId: group.id,
            }),
          );
          expect(
            await call(
              "POST",
              `/services/${owned.serviceId}/auto-renew`,
              alice,
              { enabled: true, password },
            ),
          );
          await db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1',[bob.id]);expect(await call('POST',`/services/${owned.serviceId}/transfer`,alice,{email:bob.email,password}),409);await db.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[bob.id]); // 未验证邮箱只是登录名，不能作为转入资产的地址
      const transfer = expect(
            await call("POST", `/services/${owned.serviceId}/transfer`, alice, {
              email: bob.email,
              password,
            }),
          );
          expect(
            await call(
              "POST",
              `/service-transfers/${transfer.id}/accept`,
              alice,
              { password },
            ),
            404,
          );
          expect(
            await call(
              "POST",
              `/service-transfers/${transfer.id}/accept`,
              bob,
              { password },
            ),
          ); // 接收方必须独立同意
          expect(await call("GET", "/services/" + owned.serviceId, alice), 404);
          const current = expect(
            await call("GET", "/services/" + owned.serviceId, bob),
            200,
          );
          assert.equal(current.autoRenew, false);
          assert.equal(current.remark, "");
          assert.equal(current.groupId, null);
          assert.equal(current.invoiceId, null);
          expect(await call("GET", "/invoices/" + owned.invoiceId, bob), 404);
          expect(await call("GET", "/invoices/" + owned.invoiceId, alice), 200); // 旧发票与余额没有跟着资源泄露
          const source = (
            await db.query(
              "SELECT user_id,current_owner_id FROM services WHERE id=$1",
              [owned.serviceId],
            )
          ).rows[0];
          assert.equal(source.user_id, alice.id);
          assert.equal(source.current_owner_id, bob.id); // 不修改成交归属
          const renewal = expect(
            await call(
              "POST",
              `/services/${owned.serviceId}/renew`,
              bob,
              { period: "quarter" },
              randomUUID(),
            ),
          );
          expect(
            await call(
              "POST",
              `/invoices/${renewal.invoiceId}/pay-wallet`,
              bob,
            ),
          ); // 接收后由新账号产生新账单
          const blocked = await resource();
          expect(
            await call(
              "POST",
              `/services/${blocked.serviceId}/renew`,
              alice,
              { period: "quarter" },
              randomUUID(),
            ),
          );
          expect(
            await call(
              "POST",
              `/services/${blocked.serviceId}/transfer`,
              alice,
              { email: bob.email, password },
            ),
            409,
          ); // 未付旧续费先处理
          const phone = "+8613900000001",
            mobileOwned = await resource();
          await db.query(
            "UPDATE users SET phone=$2,phone_verified_at=NULL WHERE id=$1",
            [bob.id, phone],
          );
          expect(
            await call(
              "POST",
              `/services/${mobileOwned.serviceId}/transfer`,
              alice,
              { phone, password },
            ),
            409,
          ); // 未验证资料不能抢接服务
          await db.query("UPDATE users SET phone_verified_at=now() WHERE id=$1", [
            bob.id,
          ]);
          const mobileTransfer = expect(
            await call(
              "POST",
              `/services/${mobileOwned.serviceId}/transfer`,
              alice,
              { phone, password },
            ),
          );
          expect(
            await call(
              "POST",
              `/service-transfers/${mobileTransfer.id}/accept`,
              bob,
              { password },
            ),
          );
          expect(
            await call("GET", "/services/" + mobileOwned.serviceId, bob),
            200,
          ); // 验证过的手机号可以作为接收标识
        },
      );
      await context.test(
        "取消批准前不终止，到期申请可撤回，真实完成才结束",
        async () => {
          const owned = await resource();
          const cancellation = expect(
            await call(
              "POST",
              `/services/${owned.serviceId}/cancellations`,
              alice,
              { mode: "end_of_period", reason: "到期后停止使用" },
            ),
          );
          assert.equal(
            (
              await db.query(
                "SELECT termination_requested_at FROM services WHERE id=$1",
                [owned.serviceId],
              )
            ).rows[0].termination_requested_at,
            null,
          ); // 申请不会擅自阻断服务
          expect(
            await call(
              "POST",
              `/admin/service-cancellations/${cancellation.id}/decide`,
              admin,
              { action: "approve", reason: "核对资源交付后批准", password },
            ),
          );
          assert.equal(
            (
              await db.query(
                "SELECT status FROM service_cancellations WHERE id=$1",
                [cancellation.id],
              )
            ).rows[0].status,
            "approved",
          );
          expect(
            await call(
              "POST",
              `/services/${owned.serviceId}/renew`,
              alice,
              { period: "quarter" },
              randomUUID(),
            ),
            409,
          );
          expect(
            await call(
              "POST",
              `/service-cancellations/${cancellation.id}/withdraw`,
              alice,
            ),
          );
          assert.equal(
            (
              await db.query(
                "SELECT termination_requested_at FROM services WHERE id=$1",
                [owned.serviceId],
              )
            ).rows[0].termination_requested_at,
            null,
          ); // 未排实际任务时可以解除取消
          const immediate = expect(
            await call(
              "POST",
              `/services/${owned.serviceId}/cancellations`,
              alice,
              { mode: "immediate", reason: "确认不再使用" },
            ),
          );
          const approved = expect(
            await call(
              "POST",
              `/admin/service-cancellations/${immediate.id}/decide`,
              admin,
              { action: "approve", reason: "同意并记录实际交付", password },
            ),
          );
          assert.equal(approved.status, "executing");
          assert.equal(
            (
              await db.query("SELECT status FROM services WHERE id=$1", [
                owned.serviceId,
              ])
            ).rows[0].status,
            "active",
          );
          expect(
            await call(
              "POST",
              `/service-cancellations/${immediate.id}/withdraw`,
              alice,
            ),
            409,
          );
          expect(
            await call(
              "POST",
              `/admin/jobs/${approved.jobId}/complete`,
              admin,
              { note: "测试资源已由管理员明确终止" },
            ),
          );
          assert.equal(
            (
              await db.query(
                "SELECT status FROM service_cancellations WHERE id=$1",
                [immediate.id],
              )
            ).rows[0].status,
            "executed",
          );
          assert.equal(
            (
              await db.query("SELECT status FROM services WHERE id=$1", [
                owned.serviceId,
              ])
            ).rows[0].status,
            "cancelled",
          ); // 排队与真实成功严格区分
        },
      );
      await context.test(
        "自动续费跨节点只扣一次，余额不足保留账单并通知一次",
        async (autoContext) => {
          const previous = {
            database: process.env.DATABASE_URL,
            audit: process.env.AUDIT_KEY,
          };
          process.env.DATABASE_URL = address.href;
          process.env.AUDIT_KEY = secret; // 仅测试进程中的调度器连接本轮库
          const store = await import("../src/features/store.js");
          await store.connect();
          try {
            const { default: Autorenew } = await import(
              "../src/features/autorenew.js"
            );
            const worker = new Autorenew();
            const owned = await resource();
            await db.query(
              "UPDATE services SET due_at=now()+interval '12 hours' WHERE id=$1",
              [owned.serviceId],
            );
            expect(
              await call(
                "POST",
                `/services/${owned.serviceId}/auto-renew`,
                alice,
                { enabled: true, password },
              ),
            );
            const before = expect(
              await call("GET", "/wallet", alice),
              200,
            ).balanceCents;
            await Promise.all([worker.run(), new Autorenew().run()]);
            const after = expect(
              await call("GET", "/wallet", alice),
              200,
            ).balanceCents;
            assert.equal(BigInt(before) - BigInt(after), 1234n);
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM auto_renew_attempts WHERE service_id=$1",
                  [owned.serviceId],
                )
              ).rows[0].n,
              1,
            ); // 多节点用同一张原子钱包账单
            const poor = await actor();
            await opening(poor, "500");
            const limited = await resource(poor, "month", "500");
            await db.query(
              "UPDATE services SET due_at=now()+interval '12 hours' WHERE id=$1",
              [limited.serviceId],
            );
            expect(
              await call(
                "POST",
                `/services/${limited.serviceId}/auto-renew`,
                poor,
                { enabled: true, password },
              ),
            );
            await Promise.all([worker.run(), new Autorenew().run()]);
            await worker.run();
            const attempted = (
              await db.query(
                "SELECT invoice_id,last_error FROM auto_renew_attempts WHERE service_id=$1",
                [limited.serviceId],
              )
            ).rows[0];
            assert.match(attempted.last_error, /余额不足/);
            assert.equal(
              (
                await db.query("SELECT status FROM invoices WHERE id=$1", [
                  attempted.invoice_id,
                ])
              ).rows[0].status,
              "unpaid",
            );
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND title='自动续费需要处理'",
                  [poor.id],
                )
              ).rows[0].n,
              1,
            ); // 失败不扣部分资金、不反复提醒
            await opening(poor, "1000");
            await worker.run();
            assert.equal(
              (
                await db.query("SELECT status FROM invoices WHERE id=$1", [
                  attempted.invoice_id,
                ])
              ).rows[0].status,
              "paid",
            );
            assert.equal(
              (
                await db.query(
                  "SELECT count(*)::int n FROM auto_renew_attempts WHERE service_id=$1",
                  [limited.serviceId],
                )
              ).rows[0].n,
              1,
            ); // 补足钱包后结清原账单
            await autoContext.test(
              "批量续费持久幂等，租约恢复不重复延长且撤销授权停止执行",
              async () => {
                const { default: Batch } = await import(
                    "../src/features/batch.js"
                  ),
                  { default: Service } = await import(
                    "../src/features/service.js"
                  );
                const free = await resource(alice, "month", "0"),
                  paid = await resource(alice, "quarter", "333");
                const items = [
                    { serviceId: free.serviceId, period: "month" },
                    { serviceId: paid.serviceId, period: "quarter" },
                  ],
                  key = randomUUID();
                const batch = expect(
                  await call("POST", "/renewal-batches", alice, { items }, key),
                );
                assert.equal(
                  expect(
                    await call(
                      "POST",
                      "/renewal-batches",
                      alice,
                      { items: [...items].reverse() },
                      key,
                    ),
                  ).id,
                  batch.id,
                );
                expect(
                  await call(
                    "POST",
                    "/renewal-batches",
                    alice,
                    { items: [items[0]] },
                    key,
                  ),
                  409,
                ); // 排序不同不改变提交，换选择则拒绝重用
                const before = (
                  await db.query(
                    "SELECT due_at::text FROM services WHERE id=$1",
                    [free.serviceId],
                  )
                ).rows[0].due_at;
                const results = await Promise.all([
                  new Batch().run(),
                  new Batch().run(),
                  new Batch().run(),
                ]);
                assert.equal(
                  results.filter((value) => value === batch.id).length,
                  1,
                );
                const completed = expect(
                  await call("GET", "/renewal-batches/" + batch.id, alice),
                  200,
                );
                assert.equal(completed.status, "completed");
                assert.equal(completed.results.length, 2);
                assert.equal(
                  completed.results.find(
                    (value: any) => value.serviceId === free.serviceId,
                  ).status,
                  "paid",
                );
                assert.equal(
                  completed.results.find(
                    (value: any) => value.serviceId === paid.serviceId,
                  ).status,
                  "unpaid",
                );
                assert.equal(
                  (
                    await db.query(
                      "SELECT due_at=$2::timestamptz+interval '1 month' AS ok FROM services WHERE id=$1",
                      [free.serviceId, before],
                    )
                  ).rows[0].ok,
                  true,
                ); // 各资源按各自合同成交
                const repeat = expect(
                  await call("POST", "/renewal-batches", alice, { items }, key),
                );
                assert.equal(repeat.id, batch.id);
                assert.equal(await new Batch().run(), null); // 已完成批次不能再次领走
                const recovery = expect(
                    await call(
                      "POST",
                      "/renewal-batches",
                      alice,
                      { items: [items[0]] },
                      randomUUID(),
                    ),
                  ),
                  oldLease = randomUUID(),
                  version = (
                    await db.query(
                      "SELECT session_version FROM users WHERE id=$1",
                      [alice.id],
                    )
                  ).rows[0].session_version;
                await db.query(
                  "UPDATE renewal_batches SET status='running',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",
                  [recovery.id, oldLease],
                );
                const childKey =
                  "batch_" +
                  createHash("sha256")
                    .update(`${recovery.id}:${free.serviceId}`)
                    .digest("hex");
                await new Service().renew(
                  free.serviceId,
                  childKey,
                  { period: "month" },
                  {
                    user: {
                      id: alice.id,
                      email: alice.email,
                      name: "本地批量验收",
                      role: "customer",
                    },
                    actorId: alice.id,
                  } as any,
                  undefined,
                  version,
                );
                const progressed = (
                  await db.query(
                    "SELECT due_at::text FROM services WHERE id=$1",
                    [free.serviceId],
                  )
                ).rows[0].due_at;
                assert.equal(await new Batch().run(), recovery.id);
                assert.equal(
                  (
                    await db.query(
                      "SELECT due_at::text FROM services WHERE id=$1",
                      [free.serviceId],
                    )
                  ).rows[0].due_at,
                  progressed,
                );
                assert.equal(
                  (
                    await db.query(
                      "UPDATE renewal_batches SET results='[]' WHERE id=$1 AND lease_token=$2",
                      [recovery.id, oldLease],
                    )
                  ).rowCount,
                  0,
                ); // 成交后进程退出，旧租约也不能改新结果
                const cancelled = expect(
                  await call(
                    "POST",
                    "/renewal-batches",
                    alice,
                    { items: [items[0]] },
                    randomUUID(),
                  ),
                );
                await db.query("UPDATE users SET disabled=true WHERE id=$1", [
                  alice.id,
                ]);
                assert.equal(await new Batch().run(), cancelled.id);
                assert.equal(
                  (
                    await db.query(
                      "SELECT status FROM renewal_batches WHERE id=$1",
                      [cancelled.id],
                    )
                  ).rows[0].status,
                  "cancelled",
                );
                assert.equal(
                  (
                    await db.query(
                      "SELECT due_at::text FROM services WHERE id=$1",
                      [free.serviceId],
                    )
                  ).rows[0].due_at,
                  progressed,
                );
                await db.query("UPDATE users SET disabled=false WHERE id=$1", [
                  alice.id,
                ]); // 停用不再修改已保存服务
              },
            );
          } finally {
            await store.close();
            process.env.DATABASE_URL = previous.database;
            process.env.AUDIT_KEY = previous.audit;
          } // 不污染后续测试环境
        },
      );
      assert.ok((await verifyAudit(db, secret)).count > 40); // 所有跨主体变更仍是一条完整签名链
    } finally {
      if (child && child.exitCode === null) {
        const ended = new Promise((resolve) => child!.once("exit", resolve));
        child.kill("SIGTERM");
        await ended;
      } // 关闭API及其自动续费时钟
      if (cache.isOpen) {
        await cache.del("login:" + createHash("sha256").update(testIp).digest("hex")); // 只清理本轮来源预算
        for (const token of tokens)
          await cache.del(
            "session:" + createHash("sha256").update(token).digest("hex"),
          );
        for (const id of users) await cache.del(`security:password:${id}`);
        await cache.quit();
      } // 只清理本轮已知键
      await db.end();
      if (created) await master.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await master.end();
      if (temporary) await rm(temporary, { recursive: true, force: true }); // 失败同样不留业务夹具
    }
  },
);
