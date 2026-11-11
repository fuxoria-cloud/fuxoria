/* 多币种：真实HTTP、隔离PG与Redis验证最小单位、账户分桶、并发资金和旧合同币种。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/currency.integration.test.ts。
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
  "多币种报价与账务隔离保持旧合同和资金守恒",
  { timeout: 180000 },
  async (context) => {
    const source = process.env.DATABASE_URL!;
    const ip=`198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    assert.ok(source);
    const name = "yunzou_currency_" + randomBytes(8).toString("hex"); // 随机名称只含安全字符
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
          "x-forwarded-for":ip,
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
      const opening = async (person: Actor, amount = "100000",currency="CNY") => {
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
            "INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,$5,$4,now())",
            [balance, id, person.id, amount,currency],
          );
          const ledger = (
            await c.query(
              "INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,$2) RETURNING id",
              [balance,currency],
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

        const definition=(code:string,decimals=2,numerator='7',denominator='1')=>({code,name:code,symbol:code==='USD'?'$':code==='JPY'?'¥':'¤',decimals,rateNumerator:numerator,rateDenominator:denominator,active:true,isDefault:false});
        const product=async(currency='CNY',priceCents='1000')=>expect(await call('POST','/admin/products',admin,{name:'多币种资源',priceCents,currency,provider:'manual'}));
        const buy=async(person:Actor,p:any)=>expect(await call('POST','/orders',person,{productId:p.id,period:'month'},randomUUID()));
        await context.test('币种最小单位不可改，汇率有理数快照与真实渠道能力',async()=>{
          expect(await call('POST','/admin/currencies',alice,definition('USD')),403);
          expect(await call('POST','/admin/currencies',admin,definition('USD')));
          expect(await call('POST','/admin/currencies',admin,definition('JPY',0,'1','20')));
          expect(await call('POST','/admin/currencies',admin,definition('TST',4,'3','7')));expect(await call('POST','/admin/currencies',admin,definition('XTS',8,'1','3')));
          const metadata=expect(await call('GET','/currencies'),200);assert.equal(metadata.find((row:any)=>row.code==='TST').decimals,4);
          const {code,...body}=definition('USD',3);expect(await call('PUT','/admin/currencies/USD',admin,body),409);
          const {convertMinor}=await import('../src/features/currency.js');
          const {money:display,toCents,amount,registerCurrencies}=await import('../../web/features/money.js');registerCurrencies(metadata);
          assert.equal(toCents('123',false,'JPY'),'123');assert.throws(()=>toCents('1.1',false,'JPY'));assert.equal(toCents('0.00000001',false,'XTS'),'1');assert.equal(amount('1','XTS'),'0.00000001');assert.match(display('123','JPY'),/123 JPY/);assert.equal(display('1','XTS'),'¤0.00000001 XTS');
          assert.equal(convertMinor('1001',{rateNumerator:'1',rateDenominator:'1',decimals:2},{rateNumerator:'7',rateDenominator:'1',decimals:2}),'143');assert.equal(convertMinor('1',{rateNumerator:'1',rateDenominator:'1',decimals:2},{rateNumerator:'1',rateDenominator:'20',decimals:0}),'1');
          assert.throws(()=>convertMinor('999999999999',{rateNumerator:'1',rateDenominator:'1',decimals:8},{rateNumerator:'1',rateDenominator:'3',decimals:8}),/金额上限/);
          assert.deepEqual(expect(await call('GET','/payments?currency=USD'),200),[]);
          assert.ok(expect(await call('GET','/payments?currency=CNY'),200).every((row:any)=>row.currencies.includes('CNY')));
          await assert.rejects(db.query("INSERT INTO products(name,price_cents,currency) VALUES('不存在币种',1,'XXX')"),/currency_fk/);
        });
        await context.test('钱包分币种且并发不透支，混币购物车与金额优惠明确拒绝',async()=>{
          const usd=await product('USD','1000'),cny=await product('CNY','1000');await opening(alice,'10000','USD');
          const first=await buy(alice,usd);expect(await call('POST',`/invoices/${first.invoiceId}/checkout`,alice,{gateway:'epay'}),409);
          expect(await call('POST',`/invoices/${first.invoiceId}/pay-wallet`,alice,{}));
          const other=await buy(bob,usd);expect(await call('POST',`/invoices/${other.invoiceId}/pay-wallet`,bob,{}),409);
          const costly=await product('USD','8000'),a=await buy(alice,costly),b=await buy(alice,costly);
          const results=await Promise.all([a,b].map(bill=>call('POST',`/invoices/${bill.invoiceId}/pay-wallet`,alice,{})));assert.equal(results.filter(row=>row.status===201).length,1);assert.equal(results.filter(row=>row.status===409).length,1);
          const wallet=expect(await call('GET','/wallet',alice),200);assert.equal(wallet.balanceCents,'100000');assert.equal(wallet.totals.find((row:any)=>row.currency==='USD').balanceCents,'1000');
          expect(await call('POST','/cart',alice,{productId:usd.id,period:'month',quantity:1}));const mixed=expect(await call('POST','/cart',alice,{productId:cny.id,period:'month',quantity:1}));assert.equal(mixed.amountCents,null);assert.equal(mixed.canCheckout,false);expect(await call('POST','/cart/checkout',alice,{revision:mixed.revision},randomUUID()),409);
          expect(await call('POST','/admin/promotions',admin,{code:'CNYONLY',name:'人民币减免',kind:'fixed',value:'100'}));expect(await call('POST','/orders',alice,{productId:usd.id,period:'month',promotionCode:'CNYONLY'},randomUUID()),409);
          const overview=expect(await call('GET','/overview',alice),200);assert.equal(overview.balanceCents,'100000');assert.equal(overview.currency,'CNY');assert.equal(overview.totals.find((row:any)=>row.currency==='USD').walletCents,'1000');
        });
        await context.test('批量有理数换价保留旧服务与订单币种，规则和配置金额一起换算',async()=>{
          const p=await product('CNY','1001');expect(await call('PUT',`/admin/catalogue/products/${p.id}`,admin,{periods:[{period:'month',priceCents:'1001'},{period:'quarter',priceCents:'2701'}],options:[{key:'disk',name:'磁盘',kind:'quantity',minimum:0,maximum:10,prices:{month:'7'},setupCents:'3'}]}));
          const order=await buy(alice,p);expect(await call('POST',`/invoices/${order.invoiceId}/pay-wallet`,alice,{}));const service=(await db.query('SELECT id FROM services WHERE order_id=$1',[order.id])).rows[0];const job=(await db.query('SELECT id FROM jobs WHERE service_id=$1',[service.id])).rows[0];expect(await call('POST',`/admin/jobs/${job.id}/complete`,admin,{externalId:'real-currency-test-resource'}));
          const changed=expect(await call('POST','/admin/currencies/reprice',admin,{productIds:[p.id],targetCurrency:'USD'}));assert.equal(changed.products[0].priceCents,'143');
          const details=expect(await call('GET',`/admin/catalogue/products/${p.id}`,admin),200);assert.equal(details.periods.find((row:any)=>row.period==='quarter').priceCents,'386');assert.equal(details.options[0].prices.month,'1');assert.equal(details.options[0].setupCents,'1');
          const renewed=expect(await call('POST',`/services/${service.id}/renew`,alice,{period:'month'},randomUUID()));assert.equal(renewed.currency,'CNY');assert.equal(renewed.amountCents,'1001');
          const contract=(await db.query('SELECT billing_currency FROM services WHERE id=$1',[service.id])).rows[0];assert.equal(contract.billing_currency,'CNY');assert.equal((await db.query('SELECT currency FROM orders WHERE id=$1',[order.id])).rows[0].currency,'CNY');
          const quote=expect(await call('POST','/catalogue/quote',undefined,{productId:p.id,period:'month',quantity:1,configuration:{disk:0}}));assert.equal(quote.currency,'USD');assert.equal(quote.unitPriceCents,'143');assert.equal(quote.pricingSource.currency.rateNumerator,'7');
          expect(await call('POST',`/services/${service.id}/upgrade-quote`,alice,{productId:p.id,configuration:{disk:1}}),409);
        });
        await context.test('信用额度与还款按币种独立，双节点并发只占同币种额度',async()=>{
          const person=await actor();await opening(person,'10000','USD');await opening(person,'10000');
          for(const currency of ['CNY','USD'])expect(await call('PUT',`/admin/credit/${person.id}`,admin,{currency,enabled:true,limitCents:'2000',billingDay:1,repaymentDays:15,note:'隔离币种真实授信',password}));
          const p=await product('USD','1500'),a=await buy(person,p),b=await buy(person,p),results=await Promise.all([a,b].map(bill=>call('POST',`/invoices/${bill.invoiceId}/pay-credit`,person,{password})));assert.equal(results.filter(row=>row.status===201).length,1);
          const usd=expect(await call('GET','/credit?currency=USD',person),200),cny=expect(await call('GET','/credit',person),200);assert.equal(usd.usedCents,'1500');assert.equal(cny.usedCents,'0');assert.equal(usd.availableCents,'500');
          const repay=expect(await call('POST','/credit/repayments',person,{currency:'USD'},randomUUID()));assert.equal(repay.currency,'USD');expect(await call('POST',`/invoices/${repay.invoiceId}/pay-wallet`,person,{}));assert.equal(expect(await call('GET','/credit?currency=USD',person),200).usedCents,'0');
          assert.equal(expect(await call('GET','/wallet',person),200).totals.find((row:any)=>row.currency==='USD').balanceCents,'8500');assert.equal(expect(await call('GET',`/invoices/${a.invoiceId}`,person),200).currencyDecimals,2);
          const income=expect(await call('GET','/admin/overview',admin),200);assert.equal(income.currency,'CNY');assert.ok(income.revenueTotals.some((row:any)=>row.currency==='USD'));
        });
        await context.test('充值退款占额只冻结原币种，默认四渠道不创建外币付款意图',async()=>{
          const recharge=expect(await call('POST','/wallet/recharges',alice,{amountCents:'1000'},randomUUID()));await cash(alice,recharge);
          const refund=expect(await call('POST',`/invoices/${recharge.invoiceId}/refunds`,alice,{amountCents:'400',reason:'真实占额币种验证'},randomUUID()));assert.equal(refund.currency,'CNY');
          const wallet=expect(await call('GET','/wallet',alice),200);assert.equal(wallet.heldCents,'400');assert.equal(wallet.totals.find((row:any)=>row.currency==='USD').heldCents,'0');
          expect(await call('POST','/wallet/recharges',alice,{currency:'USD',amountCents:'1000'},randomUUID()),409);
          assert.equal((await db.query("SELECT count(*)::int AS count FROM payment_attempts a JOIN invoices i ON i.id=a.invoice_id WHERE i.currency<>'CNY'")).rows[0].count,0);
        });
        await context.test('USD同币种合并只实扣一笔父账单，混币选择与子单重复付款均拒绝',async()=>{
          const person=await actor();await opening(person,'10000','USD');
          const usd1=await buy(person,await product('USD','301')),usd2=await buy(person,await product('USD','702')),cny=await buy(person,await product('CNY','1000'));
          expect(await call('POST','/combined-invoices',person,{invoiceIds:[usd1.invoiceId,cny.invoiceId]},randomUUID()),409);
          const before=(await db.query('SELECT i.currency,i.status,o.status AS order_status FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=ANY($1::uuid[])',[[usd1.invoiceId,usd2.invoiceId]])).rows;assert.ok(before.every(row=>row.currency==='USD'&&row.status==='unpaid'&&row.order_status==='unpaid'),JSON.stringify(before));
          const key=randomUUID(),body={invoiceIds:[usd1.invoiceId,usd2.invoiceId]},parent=expect(await call('POST','/combined-invoices',person,body,key));const replay=expect(await call('POST','/combined-invoices',person,body,key));assert.equal(parent.invoiceId,replay.invoiceId);assert.equal(parent.currency,'USD');assert.equal(parent.amountCents,'1003');
          expect(await call('POST',`/invoices/${parent.invoiceId}/pay-wallet`,person,{}));expect(await call('POST',`/invoices/${parent.invoiceId}/pay-wallet`,person,{}));expect(await call('POST',`/invoices/${usd1.invoiceId}/pay-wallet`,person,{}),409);
          const facts=(await db.query('SELECT i.currency,i.status,o.kind FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=ANY($1::uuid[])',[ [parent.invoiceId,usd1.invoiceId,usd2.invoiceId] ])).rows;assert.equal(facts.length,3);assert.ok(facts.every(row=>row.currency==='USD'&&row.status==='paid'));
          const income=(await db.query("SELECT count(*)::int AS count,sum(e.amount_cents)::text AS total FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account=$1 AND t.currency='USD'",[`income:${person.id}`])).rows[0];assert.equal(income.count,1);assert.equal(income.total,'-1003');
          assert.equal((await db.query('SELECT count(*)::int AS count FROM wallet_payments WHERE invoice_id=ANY($1::uuid[])',[[parent.invoiceId,usd1.invoiceId,usd2.invoiceId]])).rows[0].count,1);
          const wallet=expect(await call('GET','/wallet',person),200);assert.equal(wallet.totals.find((row:any)=>row.currency==='USD').balanceCents,'8997');assert.equal(wallet.balanceCents,'0');assert.equal((await db.query("SELECT count(*)::int AS count FROM jobs j JOIN services s ON s.id=j.service_id WHERE s.user_id=$1 AND j.action='provision'",[person.id])).rows[0].count,2);
        });
        await context.test('迁移期初工具以同币种空账户为界，预检不写钱且重复来源不重复入账',async()=>{
          const {importOpening}=await import('../../../scripts/opening.js');const person=await actor(),input={sourceId:'currency-test-'+randomUUID(),sourceKey:'0123456789ABCDEF',sourceHash:randomBytes(32).toString('hex'),asOf:new Date().toISOString(),reason:'经原账户外币余额记录逐行核对迁入',balances:[{userId:person.id,currency:'JPY',amountCents:'123'}]};
          const c=await db.connect();try{await c.query('BEGIN');assert.equal((await importOpening(c,input,false)).applied,false);assert.equal((await c.query('SELECT count(*)::int AS count FROM opening_balances WHERE user_id=$1',[person.id])).rows[0].count,0);await c.query('ROLLBACK');await c.query('BEGIN');const first=await importOpening(c,input,true);await c.query('COMMIT');await c.query('BEGIN');const replay=await importOpening(c,input,true);assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);await c.query('COMMIT');await c.query('BEGIN');await assert.rejects(importOpening(c,{...input,sourceId:'different-'+randomUUID()},true),/已有此币种钱包流水/);await c.query('ROLLBACK');}finally{c.release();}
          assert.equal(expect(await call('GET','/wallet',person),200).totals.find((row:any)=>row.currency==='JPY').balanceCents,'123');
          const p=await product('XTS','1'),bill=await buy(person,p);assert.equal(bill.currencyDecimals,8);assert.equal(expect(await call('GET',`/invoices/${bill.invoiceId}`,person),200).currencyDecimals,8);
        });
        assert.ok((await verifyAudit(db,secret)).count>0);
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
        for (const token of tokens)
          await cache.del(
            "session:" + createHash("sha256").update(token).digest("hex"),
          );
        for (const id of users) await cache.del(`account-proof:user:${id}`);
        await cache.del('login:'+createHash('sha256').update(ip).digest('hex'));
        await cache.quit();
      } // 只清理本轮会话与证明键
      await db.end();
      if (created) await master.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await master.end(); // 不保留临时财务事实
    }
  },
);
