/* 财务与资源独立复验：真实随机PostgreSQL库、Redis私有键及随机端口运行源码API。
 * 调用：npm run test:review；也可 node --import tsx apps/api/tests/finance-review.integration.ts。
 * 范围：钱包双向账本/并发、终止后的晚到续费款、退款结案、人工暂停补恢复、账单权限与隐私缓存。
 * 出站queryRefund仅在本测试进程用固定结果替身，不请求支付机构，不代表商户协议已联调。
 * 只允许本机PG/Redis；凭据从根目录.env读取，结束关闭连接再删除自身随机库，不修改业务源码。
 */
import pg from 'pg';                                                // 使用真实事务与延迟约束
import {hash} from 'argon2';                                       // 管理员当前密码走真实摘要校验
import type {SessionRequest} from '../src/utils/access.js';          // 控制器夹具只提供本轮身份
import type {PaymentPlugin} from '@fuxoria/payments';                 // 机构替身仍遵循实际支付合同
import {fileURLToPath} from 'node:url';                             // 项目位置随测试文件移动而确定
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto'; // 随机主体、恢复码和加密材料互不复用
import {readdir,readFile} from 'node:fs/promises';                    // 所有正式迁移参与复验
import {spawn} from 'node:child_process'; // 仅启动本轮隔离源码API
import {createServer} from 'node:net'; // 不占用开发服务的固定端口
import assert from 'node:assert/strict'; // 每组同时检查返回值与持久事实
import 'reflect-metadata';                                         // 源码控制器需要Nest元数据
type InvoiceReview={status:string;payable:boolean;paymentMessage:string|null;billingReview:{status:string}|null}; // 复核新增的账单合同
const root=fileURLToPath(new URL('../../../',import.meta.url));       // 不依赖工作目录或开发者账号
process.loadEnvFile(new URL('../../../.env',import.meta.url));        // 不输出连接串与密钥
assert.ok(process.env.DATABASE_URL,'请先配置本机DATABASE_URL'); // 缺少本机配置时明确停止
assert.ok(process.env.REDIS_URL,'请先配置本机REDIS_URL'); // 不悄悄使用默认缓存服务器
const original=new URL(process.env.DATABASE_URL); // 只借用本机服务器连接信息
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.REDIS_URL).hostname),'只允许本机Redis');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(original.hostname)); // 不会向外部数据库创建或删除资源
const run=randomUUID().replaceAll('-',''); // 所有可清理对象都属于本次运行
const databaseName='yunzou_final_review_'+run; // 随机库名避免与固定集成套件冲突
const target=new URL(original);target.pathname='/'+databaseName; // 应用连接从此指向本轮空库
const admin=new pg.Client({connectionString:original.href});await admin.connect(); // 管理连接只创建和删除自身测试库
let application:typeof import('../src/features/store.js')|undefined; // 异常路径同样关闭连接
let child:ReturnType<typeof spawn>|undefined;                       // 只结束本轮随机端口的API
let created=false; // 创建失败时不误删不存在的目标
const cleanupKeys:string[]=[];                                    // 不扫描或清空别人的Redis键
const pass=(name:string,details:object={})=>console.log(JSON.stringify({pass:name,...details})); // 只输出场景和无凭据结果
try {
 await admin.query(`CREATE DATABASE "${databaseName}"`);created=true; // 不在开发业务表中插入夹具
 process.env.DATABASE_URL=target.href; // 业务连接池初始化前切换目标
 process.env.AUDIT_KEY=randomBytes(32).toString('hex'); // 夹具审计不使用部署真实签名钥
 process.env.TOTP_KEY=randomBytes(32).toString('hex'); // 测试因素密文只在本轮可用
 process.env.PUBLIC_ORIGIN='http://127.0.0.1';
 const store=await import('../src/features/store.js');application=store; // 按切换后的环境创建真实业务连接
 await store.connect(); // PG和Redis都就绪才开始业务断言
 const db=store.pool; // 后续查询始终使用隔离连接池
 await db.query('CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())'); // 源码API启动会核对所有迁移摘要
 for(const name of (await readdir(root+'/database/migrations')).filter(name=>name.endsWith('.sql')).sort()) {
  const sql=await readFile(root+'/database/migrations/'+name,'utf8'); // 完整原迁移包含本轮资金和资源约束
  await store.transaction(async c=>{await c.query(sql);await c.query('INSERT INTO migrations(name,hash) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}); // 迁移和其SHA记录在同一事务提交
 }
 const password='review-password-'+run; // 管理员口令无跨轮固定值
 const digest=await hash(password); // 证明步骤验证真实Argon2摘要
 const owner=randomUUID(),operator=randomUUID(),other=randomUUID(),product=randomUUID(); // 客户、管理员与越权客户分别存在
 await db.query("INSERT INTO users(id,email,name,password,role) VALUES($1,'review-owner@example.invalid','Review owner',$4,'customer'),($2,'review-admin@example.invalid','Review admin',$4,'admin'),($3,'review-other@example.invalid','Review other',$4,'customer')",[owner,operator,other,digest]); // 不复制任何真实客户或管理员数据
 await db.query("INSERT INTO products(id,name,price_cents,provider) VALUES($1,'Review resource',100,'manual')",[product]); // 人工插件不触发实际云资源出站
 const request={user:{id:owner,email:'review-owner@example.invalid',name:'Review owner',role:'customer'},ip:'review-'+run} as unknown as SessionRequest; // 直接方法调用的范围固定为夹具客户
 const operatorRequest={user:{id:operator,email:'review-admin@example.invalid',name:'Review admin',role:'admin'},ip:'review-'+run} as unknown as SessionRequest; // 管理员证明仍由真实安全主体核验
 const create=async(status='active')=>store.transaction(async c=>{ // 每个场景拥有独立订单、账单与服务
  const order=randomUUID(),invoice=randomUUID(),service=randomUUID(); // 原支付和资源归属都有真实外键
  await c.query("INSERT INTO orders(id,user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1,$2,$3,$4,'review',100)",[order,owner,product,randomUUID()]); // 订单金额固定为100分，避免自报报价
  await c.query('INSERT INTO invoices(id,order_id,user_id,amount_cents) VALUES($1,$2,$3,100)',[invoice,order,owner]); // 账单归属与订单客户保持一致
  await c.query("INSERT INTO services(id,user_id,product_id,order_id,name,status,due_at,external_id) VALUES($1,$2,$3,$4,'Review resource',$5,now()-interval '1 day','review-resource')",[service,owner,product,order,status]); // 过期资源夹具只供隔离调度断言
  return {order,invoice,service}; // 每组只取得自身资源标识
 });
 const {default:Wallet}=await import('../src/features/wallet.js'); // 并发扣款调用真实钱包主体
 const {default:Service}=await import('../src/features/service.js'); // 续费和管理动作不复制业务实现
 const {default:Admin}=await import('../src/features/admin.js'); // 人工确认使用实际生产控制器
 const {default:Invoice}=await import('../src/features/invoice.js'); // 新增SQL字段通过真实查询验证
 const {default:Reconciliation}=await import('../src/features/reconciliation.js'); // 核对清单沿用后台权限入口
 const {settle}=await import('../src/features/settlement.js'); // 确认后的现金只走统一入账事务
 const wallet=new Wallet(),service=new Service(),management=new Admin(),invoices=new Invoice(); // 控制器不注入测试支付确认入口
 // --- 余额来源必须有完整账本，重试不会重复扣款 ---
 const first=await create();
 await assert.rejects(db.query("INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,100,'CNY')",[first.invoice,owner]),/余额支付必须有真实已付账单/); // 只有来源标记没有分录必须提交失败
 assert.equal((await db.query('SELECT count(*)::int n FROM wallet_payments')).rows[0].n,0); // 数据库支付事实数量和实际支出相等
 pass('015孤立钱包来源无法提交');
 const imported=randomUUID(),balance=randomUUID(); // 期初余额有独立导入来源
 await store.transaction(async c=>{
  await c.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary) VALUES($1,$2,$3,$4,$5)',[imported,'review-'+run,run.slice(0,16).toUpperCase(),'1'.repeat(64),{}]); // 期初钱包负债能追溯到迁移批次
  await c.query("INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,'CNY',1000,now())",[balance,imported,owner]); // 1000分起始资金不伪造支付机构收入
  const ledger=(await c.query("INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,'CNY') RETURNING id",[balance])).rows[0].id; // 会计事务对应唯一真实来源
  await c.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,-1000),($1,'migration:equity',1000)",[ledger,'wallet:'+owner]); // 期初负债和迁移权益借贷相抵
 });
 const second=await create();
 await Promise.all([wallet.pay(first.invoice,request),wallet.pay(second.invoice,request)]); // 不同账单实际争用同一客户余额锁
 await Promise.all(Array.from({length:12},()=>wallet.pay(first.invoice,request))); // 网络重放不能再扣已付账单
 assert.equal((await wallet.get(request)).balanceCents,'800'); // 两笔100分支出后严格剩余800分
 assert.equal((await db.query('SELECT count(*)::int n FROM wallet_payments')).rows[0].n,2); // 数据库支付事实数量和实际支出相等
 pass('钱包并发与重试仅扣两笔', {balanceCents:'800'});

 // --- 原死锁顺序：钱包等服务时，续费仍可检查同客户外键 ---
 const ordinary=await create(); // 复现同客户续费外键与钱包交付的旧锁顺序
 const pendingRenewal=await service.renew(ordinary.service,randomUUID(),{period:'month'},request); // 只有已有续费账单才会在交付阶段等服务锁
 const blocker=await db.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[ordinary.service]); // 让竞争顺序由数据库锁决定
 const paying=wallet.pay(pendingRenewal.invoiceId,request);let payingResult; // 钱包真实事务将在资源行等待
 void paying.catch(()=>undefined);                                // 竞争过程提前失败也留给后面的await和finally收尾
 try {
  for(let i=0;i<200;i++) {
   const waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,status,termination_requested_at%FROM services%' ) AS yes")).rows[0].yes; // 读取实际锁等待，不靠固定长睡眠猜测
   if(waiting)break; // 确认钱包已越过余额锁进入交付
   if(i===199)throw new Error('钱包没有进入受控服务锁等待'); // 未复现既定竞争就失败而非伪称通过
   await new Promise(resolve=>setTimeout(resolve,10)); // 短轮询为等待状态留出调度时间
  }
  await blocker.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,kind) VALUES($1,$2,$3,'review-concurrent-renew',100,'renew')",[owner,product,randomUUID()]); // 持服务锁时检查用户外键应当仍可前进
  await blocker.query('COMMIT');payingResult=await paying; // 释放服务锁后钱包能完成真实交付
 } finally {await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(payingResult.status,'paid');pass('钱包持锁期间并发续费用户外键不再死锁');

 // --- 用真实加密因素和恢复码验证当前管理员身份 ---
 const {base32}=await import('../src/utils/otp.js'); // 测试使用与认证器相同的密钥编码
 const secret=base32(randomBytes(20)),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(process.env.TOTP_KEY,'hex'),nonce); // AES密文和恢复码都仅属于夹具管理员
 cipher.setAAD(Buffer.from(`yunzou:totp:v1:${operator}:active`)); // 密文绑定账号和active用途
 const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]); // 数据库内不放明文TOTP密钥
 const sealed=['v1',nonce.toString('base64url'),encrypted.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.'); // 沿用实际安全主体的带版本密文格式
 await db.query('INSERT INTO account_security(user_id,enabled,secret_ciphertext) VALUES($1,true,$2)',[operator,sealed]); // 开启MFA后管理动作不能只验证密码
 const recovery=async()=>{
  const value=randomBytes(16).toString('hex'); // 每次动作使用独立一次性恢复码
  await db.query('INSERT INTO account_recovery_codes(user_id,hash) VALUES($1,$2)',[operator,createHash('sha256').update(operator+':'+value).digest('hex')]); // 恢复码只写哈希，明文只给当次请求
  return value; // 下一次调用不会复用已消费证明
 };
 // --- 身份证明先提交，和资源交付的service→audit顺序兼容 ---
 const proofService=await create(),proofKey=randomUUID(); // 并发管理动作共用稳定提交键
 const held=await db.connect();await held.query('BEGIN');
 await held.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[proofService.service]); // 模拟Go交付先持有服务行的顺序
 const codes=[await recovery(),await recovery()];                 // 同键重试也各自提供真实一次性证明
 const actionPromises=codes.map(recoveryCode=>service.action(proofService.service,{action:'suspend',reason:'Review concurrent action',password,recoveryCode},proofKey,operatorRequest)); // 两次真实证明后争用同一资源任务
 const actionResults=Promise.all(actionPromises);void actionResults.catch(()=>undefined); // 验证期间的失败不能绕过本轮连接清理
 try {
  for(let attempt=0;attempt<200;attempt++) {
   const waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT s.*,p.provider FROM services%') AS yes")).rows[0].yes; // 读取实际锁等待，不靠固定长睡眠猜测
   if(waiting)break;                                             // 身份事务已经完成，资源事务开始等服务锁
   if(attempt===199)throw new Error('资源动作未进入受控锁等待');
   await new Promise(resolve=>setTimeout(resolve,10)); // 短轮询为等待状态留出调度时间
  }
  const {record}=await import('../src/features/audit.js');
  await record(held,'agent','job.succeeded',proofService.service,{scope:'review-lock-order'}); // Go完成使用同一service→audit顺序
  await held.query('COMMIT');                                    // 不会再被身份事务持有的audit锁阻塞
  const actions=await actionResults;
  assert.equal(actions[0].id,actions[1].id);                       // 同键并发在证明后仍返回同一个已保存任务
 }finally {await held.query('ROLLBACK');held.release();await Promise.allSettled(actionPromises);}
 pass('MFA证明与交付审计不再死锁，同键并发返回同一资源任务');

 // --- 终止意图保留资源实际状态，晚到现金明确进入核对 ---
 const late=await create(); // 另一个资源用于测试终止后的旧账单
 const lateRenewal=await service.renew(late.service,randomUUID(),{period:'month'},request); // 终止之前合法生成尚未支付的续费单
 const beforeDue=(await db.query('SELECT due_at FROM services WHERE id=$1',[late.service])).rows[0].due_at.toISOString(); // 晚到款不能悄悄改变原到期时间
 const termination=await service.action(late.service,{action:'terminate',reason:'Review termination',password,recoveryCode:await recovery()},randomUUID(),operatorRequest); // 实际验证密码及恢复码并保存终止意图
 await assert.rejects(()=>service.renew(late.service,randomUUID(),{period:'month'},request),{status:409}); // 终止意图一旦保存就不再报价续费
 const beforeBalance=(await wallet.get(request)).balanceCents; // 无法交付时内部余额支出必须回滚
 await assert.rejects(()=>wallet.pay(lateRenewal.invoiceId,request),{status:409}); // 账单未付也不能为终止资源扣款
 assert.equal((await wallet.get(request)).balanceCents,beforeBalance); // 整个扣款事务没有留下余额变化
 const unpaid=await invoices.get(lateRenewal.invoiceId,request) as unknown as InvoiceReview; // 运行断言核对SQL返回的新字段
 assert.equal(unpaid.payable,false);assert.ok(unpaid.paymentMessage); // 界面不能继续引导用户支付已终止资源
 const payment=await import('../src/features/payment.js');await payment.loadPayments();
 await assert.rejects(()=>new payment.default().checkout(lateRenewal.invoiceId,{gateway:'wechat'},request),{status:409}); // 不会再给旧续费单生成付款入口
 await db.query("INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'review')",[lateRenewal.invoiceId]); // 模拟终止前已经存在的真实渠道意图
 const notification={invoiceId:lateRenewal.invoiceId,transactionId:randomUUID(),amountCents:'100',currency:'CNY',paid:true}; // 这一步只模拟已完成验签的业务结果
 await Promise.all(Array.from({length:10},()=>settle('review',notification))); // 十次机构通知只能保留一份收款事实
 const paid=await invoices.get(lateRenewal.invoiceId,request) as unknown as InvoiceReview; // 现金已收与资源待核对同时表达
 assert.equal(paid.status,'paid');assert.equal(paid.billingReview?.status,'open'); // 待核对原因必须实际返回给客户
 assert.equal((await db.query('SELECT due_at FROM services WHERE id=$1',[late.service])).rows[0].due_at.toISOString(),beforeDue); // 待核对现金没有换成虚假的资源续期
 assert.equal((await db.query('SELECT count(*)::int n FROM billing_reviews')).rows[0].n,1);
 await management.complete(termination.id,{note:'Review: supplier resource deleted'},operatorRequest); // 供应商删除事实经实际人工确认入口提交
 assert.equal((await db.query('SELECT status FROM services WHERE id=$1',[late.service])).rows[0].status,'cancelled');
 pass('终止意图阻断新续费与钱包扣款，十次晚到通知只入一笔现金和一条核对');

 // --- 部分退款不结案，真实成功累计全额才关闭核对 ---
 const {default:Refund,refreshRefund}=await import('../src/features/refund.js');
 const refunds=new Refund(); // 退款预留和确认都使用真实主体
 const r1=await refunds.create(lateRenewal.invoiceId,{amountCents:'40',reason:'Review partial refund'},randomUUID(),request); // 第一笔只退原收款中的40分
 const r2=await refunds.create(lateRenewal.invoiceId,{amountCents:'60',reason:'Review remaining refund'},randomUUID(),request); // 第二笔预留剩余60分，不超过原款
 await db.query("UPDATE refunds SET status='processing' WHERE id=ANY($1::uuid[])",[[r1.id,r2.id]]); // 只隔离机构已受理这一出站边界
 let providerStatus:'pending'|'succeeded'='pending';
 const originalGet=payment.payments.get.bind(payment.payments);
 const provider:PaymentPlugin={configured:true,name:'Isolated queryRefund boundary',acknowledgment:'unused',create:async()=>{throw new Error('测试禁止出站下单')},verify:async()=>{throw new Error('测试不替代机构验签')},queryRefund:async input=>({reference:'review-'+input.refundId,status:providerStatus})}; // 仅隔离退款确认的外部边界
 payment.payments.get=id=>id==='review'?provider:originalGet(id);   // 子API进程仍加载真实支付插件
 await refreshRefund(r1.id,'review'); // pending只能保留预留，不能视为现金已退
 assert.equal((await db.query('SELECT status FROM billing_reviews WHERE invoice_id=$1',[lateRenewal.invoiceId])).rows[0].status,'open');
 providerStatus='succeeded';await refreshRefund(r1.id,'review'); // 随后仅让40分退款得到明确成功结果
 assert.equal((await db.query('SELECT status FROM billing_reviews WHERE invoice_id=$1',[lateRenewal.invoiceId])).rows[0].status,'open');
 await Promise.all(Array.from({length:8},()=>refreshRefund(r2.id,'review'))); // 重复查询同一退款号不能重复冲账
 const resolved=(await db.query('SELECT status,resolution,resolved_at IS NOT NULL AS stamped FROM billing_reviews WHERE invoice_id=$1',[lateRenewal.invoiceId])).rows[0]; // 检查核对状态和结案时间确实持久化
 assert.deepEqual(resolved,{status:'resolved',resolution:'refunded',stamped:true}); // 只有两笔合计100分成功才结案
 assert.equal((await db.query('SELECT count(*)::int n FROM ledger_transactions WHERE refund_id IS NOT NULL')).rows[0].n,2);
 pass('退款pending及部分成功不结案，合计100分确认后resolved且并发不重复记账');

 // --- 先续费后实际暂停，必须继续安排供应商恢复 ---
 const overdue=await create();
 const oldJob=(await db.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,'suspend','manual',jsonb_build_object('reason','overdue','dueAt',now()-interval '1 day'),$2) RETURNING id",[overdue.service,randomUUID()])).rows[0].id; // 欠费暂停意图在续费之前已排队
 const renewal=await service.renew(overdue.service,randomUUID(),{period:'month'},request); // 客户为同一资源提交真实续费账单
 await db.query("INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'review')",[renewal.invoiceId]); // 模拟终止前已经存在的真实渠道意图
 await settle('review',{invoiceId:renewal.invoiceId,transactionId:randomUUID(),amountCents:'100',currency:'CNY',paid:true});
 await Promise.all(Array.from({length:8},()=>management.complete(oldJob,{note:'Review: overdue suspension actually performed'},operatorRequest))); // 人工重复确认只安排一份补偿恢复
 const resumed=(await db.query("SELECT status,due_at>now() AS paid_future,(SELECT count(*)::int FROM jobs WHERE service_id=$1 AND action='resume') AS resume_count FROM services WHERE id=$1",[overdue.service])).rows[0]; // 暂停事实与待恢复意图同时保留
 assert.deepEqual(resumed,{status:'suspended',paid_future:true,resume_count:1}); // 不会直接把实际暂停的资源写成active
 pass('人工确认旧欠费暂停保留事实并仅补一条恢复任务');
 await assert.rejects(()=>management.updateProduct(product,{name:'Review resource',priceCents:'100',provider:'other'},operatorRequest),{status:409}); // 已有资源的externalId不得转交另一个供应商
 pass('有既有资源时拒绝更换供应商');
 assert.equal((await new Reconciliation().reviews({status:'resolved'})).total,1);
 await assert.rejects(()=>new Reconciliation().reviews({limit:'201'}),{status:400}); // 后台清单有最大页长边界
 await assert.rejects(()=>invoices.get(lateRenewal.invoiceId,{user:{id:other}} as SessionRequest),{status:404}); // 直接SQL路径也限制账单所有权
 pass('账单明细与后台核对SQL实际可用且边界页长有效');

 // --- 使用真正main.ts运行权限和缓存边界，避免直接方法调用遗漏Guard ---
 const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve)); // 由系统选择空闲端口
 const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve())); // 只给本轮API使用
 let output=''; // 仅在源码API启动失败时提供诊断
 child=spawn(process.execPath,['--import','tsx',root+'/apps/api/src/main.ts'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'test',TSX_TSCONFIG_PATH:root+'/apps/api/tsconfig.json'},stdio:['ignore','pipe','pipe']}); // 新进程只连接随机库，不影响现有API
 child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>output+=chunk);
 const base=`http://127.0.0.1:${port}/api/v1`;
 for(let i=0;i<200;i++) {
  if(child.exitCode!==null)throw new Error('隔离API未启动: '+output.slice(-3000));
  try {if((await fetch(base+'/health')).ok)break;}catch{}
  if(i===199)throw new Error('隔离API启动超时: '+output.slice(-3000)); // 未复现既定竞争就失败而非伪称通过
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const cookie=async (id:string)=>{const value=randomBytes(32).toString('hex'),key='session:'+createHash('sha256').update(value).digest('hex');await store.redis.set(key,JSON.stringify({id,version:0}),{EX:60});cleanupKeys.push(key);return 'yunzou_session='+value;}; // 仅创建本轮私有会话键，结束逐一删除
 const ownerCookie=await cookie(owner),adminCookie=await cookie(operator),otherCookie=await cookie(other); // 权限组合分别使用真实客户和管理员会话
 assert.equal((await fetch(base+'/admin/billing-reviews')).status,401); // 匿名访问不能读取财务核对清单
 assert.equal((await fetch(base+'/admin/billing-reviews',{headers:{cookie:ownerCookie}})).status,403); // 普通客户也不能读取全站财务列表
 let response=await fetch(base+'/admin/billing-reviews?status=resolved',{headers:{cookie:adminCookie}});assert.equal(response.status,200);assert.equal((await response.json()).total,1);assert.equal(response.headers.get('cache-control'),'private, no-store');
 response=await fetch(base+'/invoices/'+lateRenewal.invoiceId,{headers:{cookie:ownerCookie}});assert.equal(response.status,200);assert.equal((await response.json()).billingReview.status,'resolved');
 assert.equal((await fetch(base+'/invoices/'+lateRenewal.invoiceId,{headers:{cookie:otherCookie}})).status,404);
 pass('实际源码API运行：核对接口401/403/200、账单跨户404、私有缓存no-store');
} finally {
 const running=child;                                            // 固定本轮进程引用，等待其关闭连接后才删除数据库
 if(running && running.exitCode===null) {running.kill('SIGTERM');await new Promise(resolve=>running.once('exit',resolve));}
 if(application) {
  const store=application;
  for(const key of cleanupKeys)await store.redis.del(key); // 不调用FLUSHDB或删除其它测试的会话
  const own=await store.pool.query('SELECT id FROM users').catch(()=>({rows:[]}));
  for(const row of own.rows) {await store.redis.del('account-proof:user:'+row.id);await store.redis.del('account-factor:'+row.id);}
  await store.redis.del('account-proof:ip:'+createHash('sha256').update('review-'+run).digest('hex'));
  await store.close(); // 先关闭所有Redis和PG使用者
 }
 if(created)await admin.query(`DROP DATABASE "${databaseName}"`); // 只删除本轮随机库，不强制踢其它连接
 await admin.end(); // 最后释放管理连接，不留后台会话
}
