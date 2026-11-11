/* 退款与对账的真实PostgreSQL验证：每次创建独立临时数据库，完成后删除。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/refund.integration.test.ts。
 * 连接必须位于本机；支付机构只在本测试中用离线响应替代，生产API没有模拟确认入口。
 */
import 'reflect-metadata';                                       // 与生产装饰器使用同一元数据机制
import test, { before, after } from 'node:test';                  // 测试显式管理隔离数据库生命周期
import assert from 'node:assert/strict';                         // 核对金额、状态与真实分录
import { randomBytes, randomUUID } from 'node:crypto';           // 测试对象与临时密钥不使用生产值
import { readdir, readFile } from 'node:fs/promises';             // 使用项目真实迁移创建数据库
import { existsSync } from 'node:fs';                            // 本地.env可省略，由运行环境直接提供
import pg from 'pg';                                            // 不用内存数据库替代PostgreSQL锁
import { hash, argon2id } from 'argon2';                         // 审批校验使用真实密码摘要
import type { PaymentPlugin } from '@fuxoria/payments';           // 离线机构遵守真实插件合同
import type { SessionRequest } from '../src/utils/access.js';    // HTTP身份由测试显式提供

if (existsSync(new URL('../../../.env',import.meta.url))) process.loadEnvFile(new URL('../../../.env',import.meta.url)); // 环境文件路径不依赖工作目录
const originalUrl = process.env.REFUND_TEST_DATABASE_URL ?? process.env.DATABASE_URL; // 可单独指定隔离测试集群
if (!originalUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(originalUrl).hostname)) throw new Error('退款集成测试只允许使用明确配置的本机PostgreSQL'); // 不在远端生产集群创建测试数据库
const database = `yunzou_refund_${randomUUID().replaceAll('-','')}`; // 只使用随机十六进制构造SQL标识
const admin = new pg.Client({connectionString:originalUrl});    // 仅用于建库和删库
const target = new URL(originalUrl); target.pathname = `/${database}`; // 业务池连接到独立数据库
process.env.DATABASE_URL = target.href;                          // 主体模块加载前确定唯一测试数据来源
process.env.AUDIT_KEY = `refund-integration-${randomUUID()}-${randomUUID()}`; // 不用真实生产审计密钥生成测试链
process.env.TOTP_KEY = randomBytes(32).toString('hex');           // 退款MFA测试使用独立临时加密密钥
const { pool, redis, transaction } = await import('../src/features/store.js'); // 连接池现在只会访问临时库
const Refund = (await import('../src/features/refund.js')).default; // 使用实际退款业务
const { refreshRefund } = await import('../src/features/refund.js'); // 测试真实异步确认流程
const { reconcileInvoice } = await import('../src/features/reconciliation.js'); // 复用实际主动对账
const { settle } = await import('../src/features/settlement.js'); // 收款使用生产唯一入账主线
const paymentModule = await import('../src/features/payment.js'); // 插件仅在本测试进程替换传输结果
const Security = (await import('../src/features/security.js')).default; // 退款审批验证与登录共享真实MFA
const {totp} = await import('../src/utils/otp.js');               // 生成临时管理员实际认证器口令
const {tokenHash} = await import('../src/utils/access.js');       // 只保留会话令牌的摘要
const controller = new Refund();                                // HTTP适配层调用相同业务指令
const currentPassword = 'refund-admin-current-password';        // 只存在于临时测试库的口令
let digest: string;                                             // 同一轮测试复用临时密码摘要
let created = false;                                            // 失败清理不能误删已有数据库
const users: string[] = [];                                     // Redis只清理本轮测试自己的限流键
const minted: string[] = [];                                    // 记录本测试安全设置签发的Cookie摘要
const offline: PaymentPlugin = {name:'仅测试进程中的离线机构',configured:true,acknowledgment:'success',async create(){throw new Error('此测试不创建付款链接');},async verify(){throw new Error('通知协议另由支付包测试');}}; // 生产发现目录中没有该插件

before(async()=>{
  await admin.connect();                                        // 本机测试账号需有创建临时库权限
  await admin.query(`CREATE DATABASE "${database}"`);            // 不修改已有业务库
  created = true;                                               // 只有新库成功创建后才允许清理
  const migration = await pool.connect();                       // 真实迁移在独立库执行
  try {
    for (const file of (await readdir(new URL('../../../database/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) {
      await migration.query('BEGIN');                           // 每个迁移与生产执行方式保持一致
      await migration.query(await readFile(new URL(`../../../database/migrations/${file}`,import.meta.url),'utf8')); // 不复制表定义到测试
      await migration.query('COMMIT');                          // 约束在提交时真正运行
    }
  } finally { migration.release(); }                           // 测试失败也归还数据库连接
  await redis.connect();                                        // 当前密码限流同样使用真实Redis
  digest = await hash(currentPassword,{type:argon2id});           // 密码校验不使用存根
  await paymentModule.loadPayments();                            // 先按生产规则发现四个通道
  const original = paymentModule.payments.get.bind(paymentModule.payments); // 其他通道保持原实现
  paymentModule.payments.get = (id:string)=>id==='alipay' ? offline : original(id); // 仅当前隔离测试进程使用离线机构
});

after(async()=>{
  if (redis.isOpen) {
    for (const user of users) {
      await redis.del([`refund-password:${user}:${tokenHash('127.0.0.1')}`,`account-proof:user:${user}`,`account-factor:${user}`]); // 不清空共享Redis
    }
    for (const token of minted) await redis.del(`session:${token}`); // 清理临时管理员MFA确认后签发的会话
    await redis.quit();                                          // 只关闭本测试客户端
  }
  await pool.end();                                              // 删库前关闭测试业务连接
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); // 只删除本轮随机创建的临时库
  await admin.end();                                             // 释放建库连接
});

function request(id:string,role:'customer'|'admin'='customer'):SessionRequest {
  return {user:{id,email:`${id}@example.test`,name:'测试账号',role},ip:'127.0.0.1',requestId:randomUUID()} as SessionRequest; // 生产HTTP仍由真实Access验证身份
}

async function fixture(amount='100',paid=true) {
  offline.configured = true;                                    // 每个场景从可用通道开始
  offline.refund = async()=>({reference:'offline-refund',status:'pending'}); // 机构默认只受理，不宣告到账
  offline.queryRefund = async()=>({reference:'offline-refund',status:'succeeded'}); // 后续查单可明确成功
  const data = await transaction(async connection=>{
    const customer = await connection.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) RETURNING id',[`${randomUUID()}@example.test`,'客户',digest]); // 当前客户
    const reviewer = await connection.query("INSERT INTO users(email,name,password,role) VALUES($1,$2,$3,'admin') RETURNING id",[`${randomUUID()}@example.test`,'管理员',digest]); // 审批人是数据库中的真实管理员
    const product = await connection.query('INSERT INTO products(name,price_cents) VALUES($1,$2) RETURNING id',['测试云服务',amount]); // 使用真实商品和订单结构
    const order = await connection.query('INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',[customer.rows[0].id,product.rows[0].id,randomUUID(),'test-fixture',amount]); // 原收款准备数据
    const invoice = await connection.query('INSERT INTO invoices(order_id,user_id,amount_cents) VALUES($1,$2,$3) RETURNING id',[order.rows[0].id,customer.rows[0].id,amount]); // 不直接伪造已收款状态
    await connection.query('INSERT INTO services(user_id,product_id,order_id,name) VALUES($1,$2,$3,$4)',[customer.rows[0].id,product.rows[0].id,order.rows[0].id,'测试云服务']); // 收款流程需要实际待开通服务
    await connection.query("INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'alipay')",[invoice.rows[0].id]); // 只允许原支付通道入账
    return {invoiceId:invoice.rows[0].id,customer:customer.rows[0].id,reviewer:reviewer.rows[0].id,amount,transactionId:randomUUID()}; // 无真实机构数据
  });
  users.push(data.reviewer);                                    // 只登记将产生Redis限流键的测试账号
  const result = {invoiceId:data.invoiceId,transactionId:data.transactionId,amountCents:amount,currency:'CNY',paid:true}; // 机构协议已经由支付包单独验证
  offline.query = async()=>result;                              // 主动查询得到当前场景原订单
  if (paid) await settle('alipay',result);                       // 使用生产入账事务写原始双分录
  return {...data,owner:request(data.customer),admin:request(data.reviewer,'admin')}; // 业务方法只读这些已认证身份
}

test('同键并发申请只占额一次，同键改金额和其他账号申请均被拒绝', async()=>{
  const data = await fixture();                                 // 原收款100分
  const key = randomUUID();                                     // 一次申请的稳定提交标识
  const body = {amountCents:'30',reason:'客户申请'};              // 同一份真实退款意图
  const [first,second] = await Promise.all([controller.create(data.invoiceId,body,key,data.owner),controller.create(data.invoiceId,body,key,data.owner)]); // 触发真实同键锁竞争
  assert.equal(first.id,second.id);                              // 返回同一申请
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM refunds WHERE receipt_id=$1',[first.receiptId])).rows[0].count,1); // 不重复占用额度
  await assert.rejects(controller.create(data.invoiceId,{...body,amountCents:'31'},key,data.owner),/同一个提交标识/); // 同键改内容明确冲突
  await assert.rejects(controller.create(data.invoiceId,body,randomUUID(),request(data.reviewer)),/已付款账单不存在/); // 管理员账号也不能冒充账单所有者申请
});

test('不同键并发申请不能超收款额度，数据库也阻止直接越界插入', async()=>{
  const data = await fixture();                                 // 原收款100分
  const results = await Promise.allSettled([controller.create(data.invoiceId,{amountCents:'80',reason:'申请一'},randomUUID(),data.owner),controller.create(data.invoiceId,{amountCents:'80',reason:'申请二'},randomUUID(),data.owner)]); // 两个独立申请竞争原收款锁
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); // 只允许一笔80分申请
  const application = (results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<any>).value; // 已预留真实额度
  assert.equal((await pool.query('SELECT sum(amount_cents)::text AS total FROM refunds WHERE receipt_id=$1',[application.receiptId])).rows[0].total,'80'); // 累计额没有变成160
  await assert.rejects(transaction(connection=>connection.query("INSERT INTO refunds(receipt_id,user_id,amount_cents,currency,reason,idempotency_key,request_hash) VALUES($1,$2,30,'CNY','直接越界插入',$3,$4)",[application.receiptId,data.customer,randomUUID(),'0'.repeat(64)])),/不能超过原收款金额/); // 其它入口也不能绕开数据库预留约束
});

test('拒绝未发送申请释放预留，退款审批必须核对当前管理员密码', async()=>{
  const data = await fixture();                                 // 创建真实已付款账单
  const application = await controller.create(data.invoiceId,{amountCents:'100',reason:'客户申请'},randomUUID(),data.owner); // 先占满可退额度
  await assert.rejects(controller.approve(application.id,{password:'wrong-password'},data.admin),/密码不正确/); // 盗取会话无法直接出站退款
  assert.equal((await pool.query('SELECT status FROM refunds WHERE id=$1',[application.id])).rows[0].status,'requested'); // 密码失败不改变申请状态
  await controller.reject(application.id,{reason:'客户撤回'},data.admin); // 未出站才允许明确拒绝
  const next = await controller.create(data.invoiceId,{amountCents:'100',reason:'重新申请'},randomUUID(),data.owner); // 被拒绝的金额重新可申请
  assert.notEqual(next.id,application.id);                        // 新申请有独立审计事实
  assert.deepEqual(Reflect.getMetadata('roles',Refund.prototype.approve),['admin']); // HTTP入口的角色要求没有遗漏
  await assert.rejects(controller.approve(next.id,{password:currentPassword},request(data.customer,'admin')),/没有退款审批权限/); // 伪造过时角色也不能绕过数据库当前权限
});

test('重复批准只出站一次，待确认不记退款分录，成功查询仅冲账一次', async()=>{
  const data = await fixture();                                 // 原收款和双分录真实存在
  const application = await controller.create(data.invoiceId,{amountCents:'40',reason:'部分退款'},randomUUID(),data.owner); // 申请部分退款
  const original = (await pool.query('SELECT e.id::text,e.account,e.amount_cents::text FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.receipt_id=$1 ORDER BY e.id',[application.receiptId])).rows; // 保存原始分录便于前后对照
  let calls = 0;                                               // 只替代机构HTTP，不替代数据库
  offline.refund = async(input)=>{ calls+=1; assert.equal(input.refundId,application.id); await new Promise(resolve=>setTimeout(resolve,30)); return {reference:'provider-refund-40',status:'pending'}; }; // 网络窗口让重复批准真实交错
  await Promise.all([controller.approve(application.id,{password:currentPassword},data.admin),controller.approve(application.id,{password:currentPassword},data.admin)]); // 同一申请的并发审批
  assert.equal(calls,1);                                        // 处理中记录先提交，第二次不再次发款
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_transactions WHERE refund_id=$1',[application.id])).rows[0].count,0); // 受理不等于已退款
  await Promise.all([refreshRefund(application.id,data.reviewer),refreshRefund(application.id,data.reviewer)]); // 并发最终查询可以安全重入
  assert.equal((await pool.query('SELECT status FROM refunds WHERE id=$1',[application.id])).rows[0].status,'succeeded'); // 机构真实结果推进终态
  const reversal = (await pool.query('SELECT e.account,e.amount_cents::text FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.refund_id=$1 ORDER BY e.amount_cents',[application.id])).rows; // 独立退款会计事务
  assert.deepEqual(reversal,[{account:'cash:alipay',amount_cents:'-40'},{account:`income:${data.customer}`,amount_cents:'40'}]); // 现金与收入逐分反向且平衡
  const unchanged = (await pool.query('SELECT e.id::text,e.account,e.amount_cents::text FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.receipt_id=$1 ORDER BY e.id',[application.receiptId])).rows; // 重新读取原收款历史
  assert.deepEqual(unchanged,original);                          // 原始资金分录从未修改
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit WHERE action='refund.succeed' AND target=$1",[application.id])).rows[0].count,1); // 只留一笔实际成功事实
});

test('网络未知结果继续占额，只能查询原申请，不能手工拒绝释放资金', async()=>{
  const data = await fixture();                                 // 原收款100分
  const application = await controller.create(data.invoiceId,{amountCents:'100',reason:'全额退款'},randomUUID(),data.owner); // 占满额度
  let sends = 0;                                               // 记录机构出站次数
  offline.refund = async()=>{sends+=1;throw new Error('离线机构模拟响应超时');}; // 机构可能已执行，客户端只知道网络异常
  const unknown = await controller.approve(application.id,{password:currentPassword},data.admin); // 先保存processing再请求机构
  assert.equal(unknown.status,'manual_review');                 // 不把未知结果当作失败释放额度
  assert.equal(unknown.providerStatus,'unknown');               // 用户能区分待确认与已退款
  await assert.rejects(controller.create(data.invoiceId,{amountCents:'1',reason:'第二次退款'},randomUUID(),data.owner),/超过当前可退金额/); // 未知退款仍占全部额度
  await assert.rejects(controller.reject(application.id,{reason:'强行取消'},data.admin),/必须核对机构结果/); // 管理员不能抹掉可能已出站的事实
  await controller.approve(application.id,{password:currentPassword},data.admin); // 重复审批只是读取已有状态
  assert.equal(sends,1);                                        // 不能产生第二次退款出站
  const done = await refreshRefund(application.id,data.reviewer); // 使用原申请查询机构真实状态
  assert.equal(done.status,'succeeded');                        // 验证结果后才冲账
});

test('主动对账必须匹配金额与币种，重复补偿只产生一笔收款', async()=>{
  const data = await fixture('123',false);                      // 未付款账单但已有原渠道支付尝试
  offline.query = async()=>({invoiceId:data.invoiceId,transactionId:data.transactionId,amountCents:'122',currency:'CNY',paid:true}); // 有效机构结果也可能对应错误金额
  await assert.rejects(reconcileInvoice(data.invoiceId,data.reviewer),/金额或币种与本地账单不一致/); // 不错补一分钱
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM payment_receipts WHERE invoice_id=$1',[data.invoiceId])).rows[0].count,0); // 拒绝后没有收款或开通任务
  offline.query = async()=>({invoiceId:data.invoiceId,transactionId:data.transactionId,amountCents:'123',currency:'USD',paid:true}); // 币种也必须逐项核对
  await assert.rejects(reconcileInvoice(data.invoiceId,data.reviewer),/金额或币种与本地账单不一致/); // 不跨币种补账
  offline.query = async()=>({invoiceId:data.invoiceId,transactionId:data.transactionId,amountCents:'123',currency:'CNY',paid:true}); // 机构已验证结果与账单完全一致
  assert.equal((await reconcileInvoice(data.invoiceId,data.reviewer)).settled,true); // 主动补偿进入生产入账主线
  assert.equal((await reconcileInvoice(data.invoiceId,data.reviewer)).settled,true); // 重复执行同一机构流水幂等
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM payment_receipts WHERE invoice_id=$1',[data.invoiceId])).rows[0].count,1); // 不重复产生原收款
});

test('数据库拒绝没有独立反向分录的“已退款”状态', async()=>{
  const data = await fixture();                                 // 真实收款背景
  const application = await controller.create(data.invoiceId,{amountCents:'10',reason:'约束验证'},randomUUID(),data.owner); // 真实退款申请
  await transaction(connection=>connection.query("UPDATE refunds SET status='processing' WHERE id=$1",[application.id])); // 机构尚未确认
  await assert.rejects(transaction(connection=>connection.query("UPDATE refunds SET status='succeeded' WHERE id=$1",[application.id])),/必须有同币种的独立会计事务/); // 提交时约束阻止无分录结单
  assert.equal((await pool.query('SELECT status FROM refunds WHERE id=$1',[application.id])).rows[0].status,'processing'); // 失败事务没有泄漏伪完成状态
});

test('直接数据库并发插入也不能越过可退总额', async()=>{
  const data = await fixture();                                 // 测试数据库约束而非应用层预查询
  const receipt = (await pool.query('SELECT id FROM payment_receipts WHERE invoice_id=$1',[data.invoiceId])).rows[0].id; // 原不可变收款
  const insert = ()=>transaction(connection=>connection.query("INSERT INTO refunds(receipt_id,user_id,amount_cents,currency,reason,idempotency_key,request_hash) VALUES($1,$2,80,'CNY','并发约束验证',$3,$4)",[receipt,data.customer,randomUUID(),'1'.repeat(64)])); // 故意绕过应用层额度检查
  const results = await Promise.allSettled([insert(),insert()]); // 两条真实数据库事务同时插入
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); // 数据库锁和聚合约束也只能接受一笔
  assert.equal((await pool.query('SELECT sum(amount_cents)::text AS total FROM refunds WHERE receipt_id=$1',[receipt])).rows[0].total,'80'); // 不能依靠旧快照插出160分
});

test('多笔部分退款各有独立反向分录，累计成功退款不能超过收款', async()=>{
  const data = await fixture();                                 // 原收款100分
  const first = await controller.create(data.invoiceId,{amountCents:'40',reason:'第一次部分退款'},randomUUID(),data.owner); // 第一笔独立申请
  const second = await controller.create(data.invoiceId,{amountCents:'60',reason:'第二次部分退款'},randomUUID(),data.owner); // 第二笔占满剩余额度
  offline.refund = async(input)=>({reference:`provider-${input.refundId}`,status:'succeeded'}); // 机构明确返回每笔最终成功
  await Promise.all([controller.approve(first.id,{password:currentPassword},data.admin),controller.approve(second.id,{password:currentPassword},data.admin)]); // 同收款下的不同退款并发完成
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_transactions WHERE refund_id=ANY($1::uuid[])',[[first.id,second.id]])).rows[0].count,2); // 原receipt唯一约束不妨碍多笔独立退款
  const net = (await pool.query("SELECT sum(e.amount_cents)::text AS total FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='cash:alipay' AND (t.receipt_id=$1 OR t.refund_id=ANY($2::uuid[]))",[first.receiptId,[first.id,second.id]])).rows[0].total; // 汇总原现金与两笔退款现金
  assert.equal(net,'0');                                        // 全额累计退完后该收款现金净额为零
  await assert.rejects(controller.create(data.invoiceId,{amountCents:'1',reason:'超额第三次申请'},randomUUID(),data.owner),/超过当前可退金额/); // 已成功的退款仍计入累计额度
  await assert.rejects(transaction(connection=>connection.query('UPDATE refunds SET amount_cents=1 WHERE id=$1',[first.id])),/原始事实不能修改/); // 已申请金额不能事后改写
});

test('批准和拒绝争用同一申请，最多一个动作可以成功', async()=>{
  const data = await fixture();                                 // 原收款100分
  const application = await controller.create(data.invoiceId,{amountCents:'50',reason:'审批竞争验证'},randomUUID(),data.owner); // 同一个待审批申请
  let sends = 0;                                               // 记录真实业务层外部调用次数
  offline.refund = async()=>{sends+=1;return {reference:'provider-race',status:'pending'};}; // 外部机构只受理一次
  const results = await Promise.allSettled([controller.approve(application.id,{password:currentPassword},data.admin),controller.reject(application.id,{reason:'不予退款'},data.admin)]); // 真实并发审批与拒绝
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); // 不能一边释放额度一边把钱退走
  const status = (await pool.query('SELECT status FROM refunds WHERE id=$1',[application.id])).rows[0].status; // 读取唯一提交的业务状态
  assert.ok(['processing','rejected'].includes(status));          // 状态必须对应唯一获胜动作
  assert.equal(sends,status==='processing'?1:0);                  // 拒绝先完成时不会出站请求
});

test('启用MFA的管理员批准退款必须同时提供当次第二因素',async()=>{
  const data=await fixture();                                    // 真实收款与管理员账号
  const security=new Security();                                // 与登录共用相同的因素生命周期
  const setup=await security.setup({password:currentPassword},data.admin); // 设置加密密钥
  const reply={cookie(_name:string,token:string){minted.push(tokenHash(token));},clearCookie(){}} as unknown as import('express').Response; // 只捕获临时Cookie摘要以便清理
  await security.confirm({code:totp(setup.secret)},data.admin,reply); // 开启后当前周期已经消费
  const application=await controller.create(data.invoiceId,{amountCents:'20',reason:'需要MFA的资金申请'},randomUUID(),data.owner); // 客户申请不会发款
  let calls=0;                                                  // 观察是否真的到达机构出站边界
  offline.refund=async()=>{calls+=1;return {reference:'mfa-refund',status:'pending'};}; // 离线机构只受理
  await assert.rejects(controller.approve(application.id,{password:currentPassword},data.admin),/双因素认证/); // 仅盗取会话和口令也不能跳过启用的MFA
  await assert.rejects(controller.approve(application.id,{password:currentPassword,totp:totp(setup.secret)},data.admin),/已使用/); // 开启时消费的口令不能在财务动作重放
  assert.equal(calls,0);                                        // 第二因素失败没有外部资金动作
  await controller.approve(application.id,{password:currentPassword,totp:totp(setup.secret,Date.now()/1000+30)},data.admin); // 相邻周期内的新口令可用一次
  assert.equal(calls,1);                                        // 两因素全部通过才发送机构请求
});
