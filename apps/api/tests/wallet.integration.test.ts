/* 钱包集成：真实独立PostgreSQL验证并发扣款、幂等、所有权和资金分录。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/wallet.integration.test.ts。
 * 只创建yunzou_wallet_test，结束后删除；不写入开发业务库。
 */
import test from 'node:test';                                     // 并发在业务场景内显式构造
import assert from 'node:assert/strict';                           // 同时检查可见结果与数据库事实
import { randomUUID,randomBytes } from 'node:crypto';               // 测试身份与密钥完全独立
import { readdir,readFile } from 'node:fs/promises';                 // 每次使用全部真实迁移
import pg from 'pg';                                              // 使用真实锁、事务与延迟约束

test('钱包并发与账本在独立数据库内保持一致',async context=>{
  assert.ok(process.env.DATABASE_URL,'请提供PostgreSQL连接');      // 没有基础设施就明确失败
  const address=new URL(process.env.DATABASE_URL);                // 只借用数据库服务器地址
  const master=new URL(address); master.pathname='/postgres';    // 不进入开发业务库做测试
  const admin=new pg.Client({connectionString:master.href});       // 仅用于创建专用测试库
  await admin.connect();                                         // 连接错误不掩盖成跳过
  await admin.query('SELECT pg_advisory_lock(812441)');           // 同名测试库不能同时运行两套
  const name='yunzou_wallet_test';                                // 固定且仅用于本测试
  let application:typeof import('../src/features/store.js')|undefined; // 测试结束主动归还应用连接
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); // 只清理明确预留的测试数据库
    await admin.query(`CREATE DATABASE ${name}`);                  // 不在生产表里插验收数据
    address.pathname=`/${name}`;                                  // 所有后续查询切换到隔离库
    process.env.DATABASE_URL=address.href;                         // 仅影响当前测试进程
    process.env.AUDIT_KEY=randomBytes(32).toString('hex');          // 不读取真实审计密钥验造数据
    application=await import('../src/features/store.js');          // 连接池在切换地址后才初始化
    const database=application.pool;                              // 下面全部操作只到独立库
    const directory=new URL('../../../database/migrations/',import.meta.url); // 迁移位置固定相对文件
    for (const file of (await readdir(directory)).filter(file=>file.endsWith('.sql')).sort()) await database.query(await readFile(new URL(file,directory),'utf8')); // 所有约束参与测试
    const Wallet=(await import('../src/features/wallet.js')).default; // 调用真实业务主体，不复制扣款逻辑
    const wallet=new Wallet();                                    // 主体直接依赖唯一连接来源
    const customer=randomUUID(),other=randomUUID(),product=randomUUID(),source=randomUUID(); // 各主体有真实外键记录
    await database.query("INSERT INTO users(id,email,name,password) VALUES($1,'wallet-one@example.invalid','钱包验收','not-a-login'),($2,'wallet-two@example.invalid','另一位验收','not-a-login')",[customer,other]); // 密码不是可用于真实登录的摘要
    await database.query("INSERT INTO products(id,name,price_cents,provider) VALUES($1,'钱包验收商品',80,'manual')",[product]); // 明确是测试数据
    await database.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary) VALUES($1,$2,$3,$4,$5)',[source,'wallet-test','0123456789ABCDEF','1'.repeat(64),{}]); // 期初余额与真实迁移来源同形
    const balance=randomUUID();                                  // 唯一期初来源避免伪造支付机构收入
    await application.transaction(async connection=>{
      await connection.query("INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,'CNY',100,now())",[balance,source,customer]); // 迁移来的100分只记为期初负债
      const ledger=await connection.query("INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,'CNY') RETURNING id",[balance]); // 使用专用期初来源
      await connection.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,-100),($1,'migration:equity',100)",[ledger.rows[0].id,`wallet:${customer}`]); // 客户余额为负债贷方，不计收入
    });
    const request={user:{id:customer,email:'wallet-one@example.invalid',name:'钱包验收',role:'customer'}} as never; // 身份边界单独由HTTP集成覆盖
    const another={user:{id:other,email:'wallet-two@example.invalid',name:'另一位验收',role:'customer'}} as never; // 跨账号请求不能花对方余额
    async function invoice() {
      const order=randomUUID(),bill=randomUUID();                 // 创建彼此独立的应付账单
      await database.query("INSERT INTO orders(id,user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1::uuid,$2,$3,($1::uuid)::text,'wallet-test',80)",[order,customer,product]); // UUID确定类型后再转换为幂等文本
      await database.query("INSERT INTO invoices(id,order_id,user_id,amount_cents) VALUES($1,$2,$3,80)",[bill,order,customer]); // 账单归属固定为测试客户
      await database.query("INSERT INTO services(user_id,product_id,order_id,name) VALUES($1,$2,$3,'钱包测试资源')",[customer,product,order]); // 付款后通过真实fulfill排队
      return bill;                                               // 不提供任何真实云资源
    }
    const first=await invoice(),second=await invoice();            // 总应付160分大于100分余额
    let paid='';                                                  // 后续幂等检查针对实际成功的那张账单
    await context.test('同一账号同时付两张账单不会透支',async()=>{
      const results=await Promise.allSettled([wallet.pay(first,request),wallet.pay(second,request)]); // 显式并发争用用户余额锁
      assert.equal(results.filter(item=>item.status==='fulfilled').length,1); // 只能成功一笔80分
      paid=results[0]!.status==='fulfilled'?first:second;           // 不预设哪张账单先取得锁
      assert.equal((await wallet.get(request)).balanceCents,'20'); // 剩余金额准确到分
      assert.equal((await database.query('SELECT count(*)::int n FROM wallet_payments')).rows[0].n,1); // 数据库只有一笔有效支出
    });
    await context.test('十次重复扣款只保留一次支付和一次开通',async()=>{
      await Promise.all(Array.from({length:10},()=>wallet.pay(paid,request))); // 模拟网络重试与连续点击
      assert.equal((await wallet.get(request)).balanceCents,'20'); // 不会再扣一次
      assert.equal((await database.query('SELECT count(*)::int n FROM wallet_payments')).rows[0].n,1); // 发起次数不等于交易次数
      assert.equal((await database.query('SELECT count(*)::int n FROM jobs')).rows[0].n,1); // 资源只排一次
      const ledger=await database.query('SELECT count(*)::int n,sum(e.amount_cents)::text amount FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.wallet_payment_id IS NOT NULL'); // 核对真正的借贷分录
      assert.equal(ledger.rows[0].n,2); assert.equal(ledger.rows[0].amount,'0'); // 钱包减少与收入增加保持平衡
    });
    await context.test('不能用别人的账单探测或扣款',async()=>{
      await assert.rejects(()=>wallet.pay(paid,another),{status:404}); // 所有权在业务入口就拒绝
      assert.equal((await wallet.get(another)).balanceCents,'0'); // 他人余额完全不变
    });
    await context.test('钱包明细可追到原账单与期初来源',async()=>{
      const history=await wallet.history('1',request);             // 读取真实账本而非前端拼凑
      assert.equal(history.length,2);                             // 一笔期初、一笔支付
      assert.equal(history[0].amountCents,'-80');                   // 支付展示为支出
      assert.equal(history[0].invoiceId,paid);                     // 支出有原账单依据
      assert.equal(history[1].amountCents,'100');                  // 期初展示为可用余额增加
      assert.equal(history[1].openingBalanceId,balance);           // 不把期初负债当收入
    });
    await context.test('数据库拒绝没有分录的孤立钱包支付标记',async()=>{
      const bill=await invoice();                                 // 准备一张真实但未付款的账单
      await assert.rejects(()=>database.query("INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,80,'CNY')",[bill,customer]),/真实已付账单|实际借贷分录/); // 只有标记而没有资金事实不能提交
      assert.equal((await database.query('SELECT status FROM invoices WHERE id=$1',[bill])).rows[0].status,'unpaid'); // 账单不会被孤立标记改成已付款
    });
    await context.test('旧孤立记录不能让重试接口误报付款成功',async()=>{
      const bill=await invoice();                                 // 只在专用测试库模拟旧版本留下的异常记录
      await database.query('ALTER TABLE wallet_payments DISABLE TRIGGER wallet_has_ledger'); // 模拟015之前没有的来源约束
      try {await database.query("INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,80,'CNY')",[bill,customer])} // 不伪造任何账本或收款
      finally {await database.query('ALTER TABLE wallet_payments ENABLE TRIGGER wallet_has_ledger')} // 立即恢复真实约束
      await assert.rejects(()=>wallet.pay(bill,request),{status:409}); // 异常来源必须核对，不报告paid
      assert.equal((await wallet.get(request)).balanceCents,'20'); // 也不会重复或错误扣除余额
    });
  } finally {
    if (application) await application.pool.end();                // 先关闭待删除测试库的连接池
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);           // 连接池应已关闭；仍有连接时直接失败，不能靠强制断开掩盖泄漏
    await admin.end();                                            // 最后释放测试库互斥锁
  }
});
