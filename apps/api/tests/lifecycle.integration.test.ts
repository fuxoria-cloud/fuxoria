/*
 * 资源生命周期验收：在随机独立PostgreSQL库内运行真实HTTP API和Go调度器，核对资金与资源状态。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/lifecycle.integration.test.ts。
 * 每轮创建yunzou_lifecycle_<随机值>、随机HTTP端口、独立Redis前缀下的会话；退出删除数据库和临时产物。
 */
import test from 'node:test';                                      // 场景顺序执行，场景内显式构造重试与并发
import assert from 'node:assert/strict';                            // HTTP回执还须和持久事实一致
import { createHash,randomBytes,randomUUID } from 'node:crypto';     // 隔离身份、商户和签名密钥
import { existsSync } from 'node:fs';                              // 部署环境也可直接注入连接
import { mkdtemp,readdir,readFile,rm,writeFile } from 'node:fs/promises'; // 独立构建目录不会覆盖正在运行的API
import { join } from 'node:path';                                  // 固定项目文件位置
import { fileURLToPath } from 'node:url';                           // 不依赖命令启动目录
import { createServer } from 'node:net';                           // 自动分配闲置本地HTTP端口
import { execFile,spawn,type ChildProcess } from 'node:child_process'; // 所有子进程都使用参数数组，不经过shell
import { promisify } from 'node:util';                              // 编译失败直接作为验收失败
import { setTimeout as delay } from 'node:timers/promises';          // 只在有界轮询中等待实际事实
import pg from 'pg';                                              // 测试真实行锁、延迟约束和资金事务
import { createClient } from 'redis';                              // 会话走真实Redis而非内存替身
import { verifyAudit } from '../../../scripts/verify-audit.js';      // Go和TypeScript共用签名原文验链
import { totp } from '../src/utils/otp.js';                         // 用实际RFC算法启用真实管理员双因素

const root=fileURLToPath(new URL('../../../',import.meta.url));     // 迁移与构建使用同一项目树
const execute=promisify(execFile),origin='https://lifecycle.yunzou.test'; // 外部支付地址仅生成签名，不发网络请求
const password=`Lifecycle-${randomBytes(18).toString('hex')}`;       // 不借用任何真实客户口令
const merchant=`lifecycle-${randomBytes(6).toString('hex')}`,key=randomBytes(32).toString('hex'),audit=randomBytes(32).toString('hex'); // 测试密钥只传隔离进程
type Actor={id:string;cookie:string;email:string};                  // 身份从真正注册取得
type Resource={productId:string;serviceId:string;invoiceId:string;orderId:string}; // 记录已确认交付的测试资源
let database:pg.Pool,administrator:pg.Client,cache:ReturnType<typeof createClient>; // 结束时按依赖顺序关闭
let application:ChildProcess|undefined,agent:ChildProcess|undefined,directory='',databaseName='',base=''; // 只清理本轮资源
let environment:NodeJS.ProcessEnv,customer:Actor,admin:Actor;         // 子进程不会使用开发数据库与密钥
const tokens=new Set<string>(),addresses=new Set<string>(),people=new Set<string>(); // 精确清理本轮缓存键

async function request(method:string,path:string,actor?:Actor,body?:unknown,idempotency?:string){
 const headers:Record<string,string>={origin};                     // 写请求遵守实际Origin边界
 if(actor)headers.cookie=actor.cookie;if(body!==undefined)headers['content-type']='application/json';if(idempotency)headers['idempotency-key']=idempotency; // 客户ID不能自行提交
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)}); // 故障不无限挂起
 for(const value of response.headers.getSetCookie()){const token=/^yunzou_session=([^;]+)/.exec(value)?.[1];if(token)tokens.add(decodeURIComponent(token));} // Cookie不进入测试日志
 const raw=await response.text();let data:any=raw;try{data=JSON.parse(raw);}catch{} // 支付回执是协议要求的纯文本
 return {status:response.status,data,headers:response.headers};     // 断言只打印不含密钥的业务错误
}
function expect(result:{status:number;data:any},status:number){assert.equal(result.status,status,result.status>=400?JSON.stringify(result.data):'HTTP状态不符');} // 失败保留服务器请求号
async function wait(check:()=>Promise<boolean>,message:string){for(let round=0;round<250;round++){if(await check())return;await delay(20);}throw new Error(message);} // 先查实际状态，再短暂让出执行
async function stop(child:ChildProcess|undefined){
 if(!child || child.exitCode!==null || child.signalCode!==null)return; // 不重复向已经退出的进程发送信号
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM'); // 监听先于退出信号
 await Promise.race([exited,delay(4000,undefined,{ref:false})]);if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exited;} // 异常也不残留后台进程
}
async function register(label:string):Promise<Actor>{
 const email=`${label}-${randomUUID()}@example.test`;addresses.add(email);const result=await request('POST','/auth/register',undefined,{email,name:label,password});expect(result,201); // Argon2与会话是真实实现
 people.add(result.data.id);return {id:result.data.id,email,cookie:result.headers.getSetCookie().find(value=>value.startsWith('yunzou_session='))!.split(';')[0]}; // 只用本轮账号
}
async function product(){
 const result=await request('POST','/admin/products',admin,{name:`生命周期-${randomUUID()}`,description:'隔离资源验收',priceCents:'100',currency:'CNY',stock:30,provider:'manual',active:true});expect(result,201);return result.data; // 商品真实建立但不调用云供应商
}
function notification(invoiceId:string,transactionId=`lifecycle-${randomUUID()}`){
 const fields:Record<string,string>={pid:merchant,out_trade_no:invoiceId.replaceAll('-',''),trade_no:transactionId,money:'1.00',trade_status:'TRADE_SUCCESS'}; // 每张账单精确100分
 const canonical=Object.keys(fields).sort().map(name=>`${name}=${fields[name]}`).join('&');fields.sign=createHash('md5').update(canonical+key).digest('hex');fields.sign_type='MD5'; // 真实易支付V1签名
 return `/payments/epay/notify?${new URLSearchParams(fields)}`;        // 只给本机API发送通知，不访问支付商
}
async function initiate(invoiceId:string){expect(await request('POST',`/invoices/${invoiceId}/checkout`,customer,{gateway:'epay'}),201);} // 先登记真实支付尝试
async function notify(path:string){const result=await request('GET',path);expect(result,200);assert.equal(result.data,'success');} // 签名校验与入账都必须成功
async function complete(id:string,body:{externalId?:string;note?:string}){expect(await request('POST',`/admin/jobs/${id}/complete`,admin,body),201);} // 人工操作须有明确交付说明
async function resource():Promise<Resource>{
 const selected=await product();const order=await request('POST','/orders',customer,{productId:selected.id,period:'month'},randomUUID());expect(order,201); // 库存按真实订购预占
 await initiate(order.data.invoiceId);await notify(notification(order.data.invoiceId)); // 真实签名收款产生开通任务
 const job=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",[order.data.serviceId])).rows[0]; // 一个资源一项交付
 await complete(job.id,{externalId:`isolated-resource-${randomUUID()}`}); // 示例资源只存在隔离库
 return {productId:selected.id,serviceId:order.data.serviceId,invoiceId:order.data.invoiceId,orderId:order.data.id}; // 不把排队误认为已交付
}
async function renewal(serviceId:string){const result=await request('POST',`/services/${serviceId}/renew`,customer,{period:'month'},randomUUID());expect(result,201);return result.data;} // 价格取既有合同
async function action(serviceId:string,kind:'suspend'|'resume'|'terminate',reason:string,token=randomUUID()){
 const result=await request('POST',`/admin/services/${serviceId}/actions`,admin,{action:kind,reason,password},token);expect(result,201);return result.data; // 破坏性动作经过当前密码验证
}
async function service(serviceId:string){return (await database.query('SELECT status,due_at::text AS due,termination_requested_at::text AS terminating,suspend_type FROM services WHERE id=$1',[serviceId])).rows[0];} // 时间保留数据库完整精度
async function startAgent(){
 const before=Number((await database.query('SELECT count(*) AS n FROM agent_presence')).rows[0].n); // 重启必须观察本次新进程的心跳
 let logs='';agent=spawn(join(directory,'agent'),['--plugins',join(root,'agent/plugins'),'--concurrency','1','--poll','100ms','--schedule'],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']}); // 显式开启实际到期调度，不开启回调监听
 const keep=(value:Buffer)=>{logs=(logs+value.toString()).slice(-8000);};agent.stdout!.on('data',keep);agent.stderr!.on('data',keep); // 日志只用于失败诊断
 await wait(async()=>Number((await database.query('SELECT count(*) AS n FROM agent_presence')).rows[0].n)>before,'Go调度器未登记运行心跳').catch(error=>{throw new Error(error.message+'：'+logs.replaceAll(audit,'[redacted]'));}); // 不靠固定sleep猜进程是否启动
}
async function walletOpening(amount:string){
 const connection=await database.connect();await connection.query('BEGIN'); // 期初事实和两条分录须原子提交
 try{
  const source=randomUUID(),balance=randomUUID();await connection.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary) VALUES($1,$2,$3,$4,$5)',[source,`lifecycle-${source}`,'0123456789ABCDEF',randomBytes(32).toString('hex'),{}]); // 明确专用迁移来源
  await connection.query("INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,'CNY',$4,now())",[balance,source,customer.id,amount]); // 钱包只记公司负债，不伪造营业收款
  const ledger=(await connection.query("INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,'CNY') RETURNING id",[balance])).rows[0]; // 独立期初来源关联
  await connection.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,'migration:equity',$4)",[ledger.id,`wallet:${customer.id}`,(-BigInt(amount)).toString(),amount]);await connection.query('COMMIT'); // 正确贷方钱包与借方迁移权益
 }catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();} // 失败不留孤立来源
}

test('资源生命周期与终止后资金事实的真实隔离回归',{timeout:180_000},async context=>{
 let created=false;                                             // 只删除本轮确实创建的随机库
 try{
  if(existsSync(join(root,'.env')))process.loadEnvFile(join(root,'.env'));assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL); // 缺依赖直接失败
  databaseName=`yunzou_lifecycle_${randomBytes(8).toString('hex')}`;assert.match(databaseName,/^yunzou_lifecycle_[0-9a-f]{16}$/); // 数据库标识只含固定前缀和随机hex
  const address=new URL(process.env.DATABASE_URL!);address.pathname='/postgres';administrator=new pg.Client({connectionString:address.href});await administrator.connect(); // 不进入开发业务库
  await administrator.query(`CREATE DATABASE ${databaseName}`);created=true;address.pathname=`/${databaseName}`;database=new pg.Pool({connectionString:address.href,max:12}); // 无DROP已有库的行为
  await database.query('CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())'); // API启动核对与生产相同的SHA记录
  for(const name of (await readdir(join(root,'database/migrations'))).filter(name=>name.endsWith('.sql')).sort()){const sql=await readFile(join(root,'database/migrations',name),'utf8');await database.query(sql);await database.query('INSERT INTO migrations(name,hash)VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);} // 所有正式迁移及延迟约束参加验收
  const redisAddress=new URL(process.env.REDIS_URL!);redisAddress.pathname='/12';cache=createClient({url:redisAddress.href});await cache.connect(); // 不FLUSHDB，只精确清本轮键
  directory=await mkdtemp(join(root,'.runtime/lifecycle-test-')); // 临时Go入口只调用实际Queue主体，不复制调度SQL
  await writeFile(join(directory,'schedule.go'),`/* 生命周期单次调度探针：使用实际Queue.Schedule，让竞态测试不依赖60秒定时器。 */
package main
import("context";"fmt";"os";"time";"github.com/jackc/pgx/v5/pgxpool";"github.com/fuxoria-cloud/fuxoria/agent/features")
func main(){ctx:=context.Background();pool,err:=pgxpool.New(ctx,os.Getenv("DATABASE_URL"));if err!=nil{panic("测试连接失败")};defer pool.Close();queue:=features.Queue{Pool:pool,Lease:time.Minute,AuditKey:[]byte(os.Getenv("AUDIT_KEY"))};if len(os.Args)>1&&os.Args[1]=="skip"{if err=queue.SkipRenewed(ctx);err!=nil{panic(err)};return};count,err:=queue.Schedule(ctx);if err!=nil{panic(err)};fmt.Println(count)}
`); // 不保存生产凭据、不暴露HTTP调度入口
  await Promise.all([execute(join(root,'node_modules/.bin/tsc'),['-p',join(root,'apps/api/tsconfig.json'),'--outDir',join(directory,'api')],{cwd:root,timeout:90_000}),execute('go',['build','-o',join(directory,'agent'),'.'],{cwd:join(root,'agent'),timeout:90_000}),execute('go',['build','-o',join(directory,'schedule'),join(directory,'schedule.go')],{cwd:join(root,'agent'),timeout:90_000})]); // 独立构建互不覆盖正在运行的API或守护进程
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=(socket.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));base=`http://127.0.0.1:${port}/api/v1`; // 只监听本机随机闲置端口
  environment={...process.env,DATABASE_URL:address.href,REDIS_URL:redisAddress.href,AUDIT_KEY:audit,TOTP_KEY:randomBytes(32).toString('hex'),PUBLIC_ORIGIN:origin,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),EPAY_VERSION:'1',EPAY_URL:'https://lifecycle-pay.example.invalid/submit.php',EPAY_PID:merchant,EPAY_KEY:key}; // 私有环境不影响dev支付渠道
  let logs='';application=spawn(process.execPath,[join(directory,'api/main.js')],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']});const keep=(value:Buffer)=>{logs=(logs+value.toString()).slice(-10000);};application.stdout!.on('data',keep);application.stderr!.on('data',keep); // 仅隔离API日志
  await wait(async()=>{try{return (await fetch(base+'/health')).status===200;}catch{return false;}},'生命周期API未能启动').catch(error=>{throw new Error(error.message+'：'+logs.replaceAll(audit,'[redacted]').replaceAll(key,'[redacted]'));}); // 健康依赖实际PG和Redis
  customer=await register('lifecycle-customer');admin=await register('lifecycle-admin');await database.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]); // 独立管理员不复用真实账号

  await context.test('015拒绝未入账钱包标记，错误账本事务整体回滚',async()=>{
   const selected=await product();const order=await request('POST','/orders',customer,{productId:selected.id,period:'month'},randomUUID());expect(order,201); // 真正未付款订单
   await assert.rejects(database.query("INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,100,'CNY')",[order.data.invoiceId,customer.id]),/真实已付账单|实际借贷分录/); // 自动提交时约束必须阻止孤立标记
   const connection=await database.connect();await connection.query('BEGIN'); // 已付标记也不能替代准确分录
   try{
    await connection.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1",[order.data.invoiceId]);const payment=(await connection.query("INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,100,'CNY') RETURNING id",[order.data.invoiceId,customer.id])).rows[0]; // 先构造异常待提交事实
    const ledger=(await connection.query("INSERT INTO ledger_transactions(wallet_payment_id,currency)VALUES($1,'CNY')RETURNING id",[payment.id])).rows[0];await connection.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents)VALUES($1,$2,99),($1,$3,-99)",[ledger.id,`wallet:${customer.id}`,`income:${customer.id}`]); // 平衡但金额错1分
    await assert.rejects(connection.query('COMMIT'),/实际借贷分录|余额支付/); // 守恒还必须和原支付事实匹配
   }finally{await connection.query('ROLLBACK');connection.release();} // 被拒绝的事务不留下paid或分录
   assert.equal((await request('GET',`/invoices/${order.data.invoiceId}`,customer)).data.status,'unpaid');assert.equal((await database.query('SELECT count(*)::int n FROM wallet_payments WHERE invoice_id=$1',[order.data.invoiceId])).rows[0].n,0); // HTTP事实仍是未付款
  });

  await context.test('终止意图立即阻止续费与新支付，确认销毁才改变真实状态',async()=>{
   const owned=await resource();const renewal_=await renewal(owned.serviceId);await initiate(renewal_.invoiceId);const due=(await service(owned.serviceId)).due; // 旧支付尝试发生在终止意图以前
   const token=randomUUID();const jobs=await Promise.all(Array.from({length:4},()=>action(owned.serviceId,'terminate','客户明确终止',token)));assert.equal(new Set(jobs.map(job=>job.id)).size,1); // 并发重复确认只有一项任务
   const pending=await service(owned.serviceId);assert.equal(pending.status,'active');assert.ok(pending.terminating);assert.equal(pending.due,due); // 请求销毁不能谎报供应商已经销毁
   expect(await request('POST',`/services/${owned.serviceId}/renew`,customer,{period:'month'},randomUUID()),409);expect(await request('POST',`/invoices/${renewal_.invoiceId}/checkout`,customer,{gateway:'epay'}),409); // 禁止继续收取无法保证交付的款项
   const invoice=await request('GET',`/invoices/${renewal_.invoiceId}`,customer);expect(invoice,200);assert.equal(invoice.data.payable,false);assert.ok(invoice.data.paymentMessage); // 用户能看见真实阻止原因
   expect(await request('POST',`/admin/jobs/${jobs[0].id}/complete`,admin,{}),400); // 无实际说明不能确认销毁
   await complete(jobs[0].id,{note:'隔离资源已确认销毁'});assert.equal((await service(owned.serviceId)).status,'cancelled'); // 状态只随真实确认改变
   const path=notification(renewal_.invoiceId);await Promise.all(Array.from({length:8},()=>notify(path))); // 已在途款项在销毁后重复到账
   const after=await service(owned.serviceId);assert.equal(after.status,'cancelled');assert.equal(after.due,due); // 不复活且不延长已销毁资源
   const facts=(await database.query('SELECT (SELECT count(*)::int FROM payment_receipts WHERE invoice_id=$1) AS receipts,(SELECT count(*)::int FROM billing_reviews WHERE invoice_id=$1 AND status=\'open\') AS reviews,(SELECT count(*)::int FROM jobs WHERE service_id=$2 AND action=\'resume\') AS resumes',[renewal_.invoiceId,owned.serviceId])).rows[0];assert.deepEqual(facts,{receipts:1,reviews:1,resumes:0}); // 真实现金只入账一次并明确等待核对
   const paid=(await request('GET',`/invoices/${renewal_.invoiceId}`,customer)).data;assert.equal(paid.status,'paid');assert.equal(paid.billingReview.reason,'renewal_resource_unavailable');assert.equal(paid.billingReview.status,'open'); // 页面可见到账与交付分离
   assert.equal((await database.query("SELECT count(*)::int n FROM audit WHERE action='renewal.review' AND target=$1",[renewal_.invoiceId])).rows[0].n,1); // 重放不重复建立核对审计
  });

  await context.test('终止待处理时晚到账也只记收款与核对，不修改资源到期',async()=>{
   const owned=await resource();const bill=await renewal(owned.serviceId);await initiate(bill.invoiceId);const due=(await service(owned.serviceId)).due; // 先发起后终止的合法在途支付
   const terminate=await action(owned.serviceId,'terminate','待供应商终止');await notify(notification(bill.invoiceId));const current=await service(owned.serviceId); // 终止任务尚未确认
   assert.equal(current.status,'active');assert.ok(current.terminating);assert.equal(current.due,due);assert.equal((await database.query('SELECT reason FROM billing_reviews WHERE invoice_id=$1',[bill.invoiceId])).rows[0].reason,'renewal_resource_unavailable'); // 保留供应商真实active且不假续期
   await complete(terminate.id,{note:'隔离资源后续销毁确认'});assert.equal((await service(owned.serviceId)).status,'cancelled'); // 核对资金不阻止原终止动作
  });

  await context.test('旧续费账单余额支付遇终止原子回滚，钱包与待付状态完整保留',async()=>{
   await walletOpening('500');const owned=await resource();const bill=await renewal(owned.serviceId);const before=(await request('GET','/wallet',customer)).data.balanceCents;const due=(await service(owned.serviceId)).due; // 真正期初负债提供余额
   const terminate=await action(owned.serviceId,'terminate','余额付款前已终止');expect(await request('POST',`/invoices/${bill.invoiceId}/pay-wallet`,customer,{}),409); // 内部尚未扣款，可以整体拒绝
   assert.equal((await request('GET','/wallet',customer)).data.balanceCents,before);const invoice=(await request('GET',`/invoices/${bill.invoiceId}`,customer)).data;assert.equal(invoice.status,'unpaid');assert.equal(invoice.billingReview,null);assert.equal((await service(owned.serviceId)).due,due); // 没收钱也不产生虚假核对收款
   const facts=(await database.query('SELECT (SELECT count(*)::int FROM wallet_payments WHERE invoice_id=$1) wallets,(SELECT count(*)::int FROM ledger_transactions t JOIN wallet_payments w ON w.id=t.wallet_payment_id WHERE w.invoice_id=$1) ledgers',[bill.invoiceId])).rows[0];assert.deepEqual(facts,{wallets:0,ledgers:0}); // 来源标记和账本也须一起回滚
   await complete(terminate.id,{note:'隔离资源销毁已确认'}); // 不留悬而未决任务影响后续调度
  });

  await context.test('真实Go逾期人工任务在续费后才确认暂停，会补一次实际恢复',async()=>{
   const owned=await resource();await database.query("UPDATE services SET due_at=now()-interval '1 day' WHERE id=$1",[owned.serviceId]);await startAgent(); // 用实际时钟产生真正调度任务
   let overdue='';await wait(async()=>{const rows=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='suspend' AND payload->>'reason'='overdue' AND result->>'manualRequired'='true'",[owned.serviceId])).rows;if(rows[0])overdue=rows[0].id;return Boolean(overdue);},'没有实际逾期人工等待任务'); // 让真实Go持续运行，维护不能丢弃已移交人工的动作
   assert.equal((await service(owned.serviceId)).status,'active');const bill=await renewal(owned.serviceId);await initiate(bill.invoiceId);await notify(notification(bill.invoiceId));const due=(await service(owned.serviceId)).due;assert.ok(Date.parse(due)>Date.now()); // 付款先到账，此时供应商仍active
   await execute(join(directory,'schedule'),['skip'],{cwd:root,env:environment,timeout:15_000});assert.equal((await database.query('SELECT state FROM jobs WHERE id=$1',[overdue])).rows[0].state,'queued'); // 确定性触发真实维护，人工结果未核对时不能假称安全跳过
   assert.equal((await database.query("SELECT count(*)::int n FROM jobs WHERE service_id=$1 AND action='resume'",[owned.serviceId])).rows[0].n,0); // 未暂停不能谎造已恢复
   await Promise.all(Array.from({length:6},()=>complete(overdue,{note:'实际逾期暂停随后才确认'})));const suspended=await service(owned.serviceId);assert.equal(suspended.status,'suspended');assert.equal(suspended.suspend_type,'overdue');assert.equal(suspended.due,due); // 先保存真实暂停事实
   await wait(async()=>Boolean((await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='resume' AND state='queued' AND result->>'manualRequired'='true'",[owned.serviceId])).rowCount),'恢复任务未被真实Go移交人工');await stop(agent);agent=undefined; // 恢复也走实际消费者，不能直接把排队视为恢复完成
   const resumes=(await database.query("SELECT id,state,payload FROM jobs WHERE service_id=$1 AND action='resume'",[owned.serviceId])).rows;assert.equal(resumes.length,1);assert.equal(resumes[0].state,'queued');assert.equal(resumes[0].payload.reason,'renewal_raced_overdue'); // 同一旧任务重试只补一项恢复
   await complete(resumes[0].id,{note:'隔离资源已确认恢复'});await complete(resumes[0].id,{note:'重复提交确认'});const active=await service(owned.serviceId);assert.equal(active.status,'active');assert.equal(active.due,due);assert.equal(active.suspend_type,''); // 恢复确认不额外加一个月
  });

  await context.test('旧人工暂停确未执行时须经管理员密码与MFA核实跳过，不能伪造暂停',async()=>{
   const owned=await resource();await database.query("UPDATE services SET due_at=now()-interval '1 day' WHERE id=$1",[owned.serviceId]);await startAgent(); // 生成真实调度载荷与人工交接事实
   let overdue='';await wait(async()=>{const rows=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='suspend' AND result->>'manualRequired'='true'",[owned.serviceId])).rows;if(rows[0])overdue=rows[0].id;return Boolean(overdue);},'待核对人工任务未生成'); // 不手工伪造可跳过标志
   const listed=await request('GET','/admin/jobs',admin);expect(listed,200);const valid=listed.data.find((job:any)=>job.id===overdue);assert.equal(valid.scheduledReason,'overdue');assert.equal(valid.manualRequired,true);assert.equal(valid.skipAvailable,false); // 仍在真实到期时不能随手清除
   expect(await request('POST',`/admin/jobs/${overdue}/skip`,customer,{reason:'越权关闭',password}),403);expect(await request('POST',`/admin/jobs/${overdue}/skip`,admin,{reason:'未核实',password:'wrong-password'}),401); // 客户与错误口令都在业务写入以前拒绝
   expect(await request('POST',`/admin/jobs/${overdue}/skip`,admin,{reason:'仍欠费',password}),409);expect(await request('POST',`/admin/jobs/${overdue}/skip`,admin,{reason:' ',password}),400); // 不满足过时条件或缺少说明均不能确认
   const bill=await renewal(owned.serviceId);await initiate(bill.invoiceId);await notify(notification(bill.invoiceId));const before=await service(owned.serviceId); // 续费后这项旧到期动作确实已过时
   await execute(join(directory,'schedule'),['skip'],{cwd:root,env:environment,timeout:15_000});assert.equal((await database.query('SELECT state FROM jobs WHERE id=$1',[overdue])).rows[0].state,'queued'); // 清理器不能代替人工核实未执行
   const stale=(await request('GET','/admin/jobs',admin)).data.find((job:any)=>job.id===overdue);assert.equal(stale.skipAvailable,true); // UI依据真实数据库边界展示动作
   const proof=await register('lifecycle-mfa-admin');await database.query("UPDATE users SET role='admin' WHERE id=$1",[proof.id]);const setup=await request('POST','/auth/mfa/setup',proof,{password});expect(setup,201); // 新管理员使用独立因素密钥
   const enabled=await request('POST','/auth/mfa/confirm',proof,{code:totp(setup.data.secret)});expect(enabled,201);proof.cookie=enabled.headers.getSetCookie().find(value=>value.startsWith('yunzou_session='))!.split(';')[0]; // 启用MFA签发新版本会话，旧会话不再有效
   expect(await request('POST',`/admin/jobs/${overdue}/skip`,proof,{reason:'只有密码',password}),401);const recovery=enabled.data.recoveryCodes as string[]; // 当前密码正确也不能跳过已启用因素
   expect(await request('POST',`/admin/jobs/${overdue}/skip`,proof,{reason:'已核实供应商未执行暂停',password,recoveryCode:recovery[0]}),201); // 唯一一次明确关闭待办
   expect(await request('POST',`/admin/jobs/${overdue}/skip`,proof,{reason:'重放同一个恢复码',password,recoveryCode:recovery[0]}),401);expect(await request('POST',`/admin/jobs/${overdue}/skip`,proof,{reason:'网络重试重新证明',password,recoveryCode:recovery[1]}),201); // 业务幂等也不放松身份因子防重放
   await stop(agent);agent=undefined;const after=await service(owned.serviceId);assert.deepEqual(after,before); // 没有实际暂停就不改状态、到期或外部事实
   const job=(await database.query('SELECT state,result FROM jobs WHERE id=$1',[overdue])).rows[0];assert.equal(job.state,'succeeded');assert.equal(job.result.skipped,true);assert.equal(job.result.reason,'manual_not_executed');assert.equal(job.result.confirmedBy,proof.id); // 完成的是核实跳过，不伪装供应商已执行
   expect(await request('POST',`/admin/jobs/${overdue}/complete`,admin,{note:'不能再把已跳过任务确认成暂停'}),409);assert.equal((await database.query("SELECT count(*)::int n FROM jobs WHERE service_id=$1 AND action='resume'",[owned.serviceId])).rows[0].n,0); // 无实际停机就不制造恢复任务
   assert.equal((await database.query("SELECT count(*)::int n FROM audit WHERE action='job.manual_skip' AND details->>'jobId'=$1",[overdue])).rows[0].n,1); // 重试不重复追加业务关闭审计
  });

  await context.test('人工风控暂停续费只延时，不能当成欠费自动恢复',async()=>{
   const owned=await resource();const suspended=await action(owned.serviceId,'suspend','overdue');await complete(suspended.id,{note:'人工核查期间暂停确认'});const due=(await service(owned.serviceId)).due; // 自由说明碰巧同名，但没有调度器dueAt仍是人工暂停
   const bill=await renewal(owned.serviceId);await initiate(bill.invoiceId);await notify(notification(bill.invoiceId));const current=await service(owned.serviceId);assert.equal(current.status,'suspended');assert.equal(current.suspend_type,'manual');assert.ok(Date.parse(current.due)>Date.parse(due)); // 正常计费不能绕过管理员核查
   assert.equal((await database.query("SELECT count(*)::int n FROM jobs WHERE service_id=$1 AND action='resume'",[owned.serviceId])).rows[0].n,0); // 只欠费暂停才走自动恢复
  });

  await context.test('已有关联资源的商品不能更换供应商，同插件调价保留合同价',async()=>{
   const owned=await resource();const body={name:'改价后的生命周期商品',description:'隔离验收',priceCents:'200',currency:'CNY',stock:20,provider:'other-provider',active:true}; // 不允许旧externalId被派往新供应商
   expect(await request('PUT',`/admin/products/${owned.productId}`,admin,body),409);assert.equal((await database.query('SELECT provider FROM products WHERE id=$1',[owned.productId])).rows[0].provider,'manual'); // 失败不能留下部分修改
   expect(await request('PUT',`/admin/products/${owned.productId}`,admin,{...body,provider:'manual'}),200);const bill=await renewal(owned.serviceId);assert.equal(bill.amountCents,'100'); // 允许新报价但既有资源按成交合同续费
   const selected=await product();const pending=await request('POST','/orders',customer,{productId:selected.id,period:'month'},randomUUID());expect(pending,201);expect(await request('PUT',`/admin/products/${selected.id}`,admin,body),409); // 尚未付款的pending资源也已有明确归属
  });

  await context.test('已经请求终止的到期资源不再被Go排入逾期暂停',async()=>{
   const owned=await resource();await database.query("UPDATE services SET due_at=now()-interval '1 day' WHERE id=$1",[owned.serviceId]);const terminate=await action(owned.serviceId,'terminate','先终止后到期调度'); // 真实active状态还会保留至供应商确认
   await execute(join(directory,'schedule'),[],{cwd:root,env:environment,timeout:15_000}); // 确定性调用实际Go调度器，不能用SQL替身
   const jobs=(await database.query("SELECT id,action,state FROM jobs WHERE service_id=$1 AND action IN('suspend','terminate')",[owned.serviceId])).rows;assert.deepEqual(jobs.map(job=>job.action),['terminate']); // 终止意图优先，不能再为同一资源排相反操作
   await complete(terminate.id,{note:'隔离资源已终止'});             // 验收后消除悬挂操作
  });

  await context.test('全生命周期资金借贷平衡且Go与TypeScript审计链可独立验签',async()=>{
   const broken=(await database.query('SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.id GROUP BY t.id HAVING count(e.id)<>2 OR sum(e.amount_cents)<>0')).rows;assert.deepEqual(broken,[]); // 不只核对HTTP状态
   assert.ok((await database.query("SELECT count(*)::int n FROM audit WHERE actor='agent' AND action='job.overdue_scheduled'")).rows[0].n>0); // 验链确实覆盖跨语言记录
   const verified=await verifyAudit(database,audit);assert.ok(verified.count>50);assert.equal(verified.historicalCount,0); // 所有新增事实都有精确签名原文
  });
 }finally{
  await stop(agent);await stop(application);                       // 先停止依赖使用者，防止删除库时继续写入
  if(cache?.isOpen){const hash=(value:string)=>createHash('sha256').update(value).digest('hex');const keys=[...tokens].map(token=>`session:${hash(token)}`);for(const email of addresses)keys.push(`login:${hash(email)}`);for(const id of people)keys.push(`account-proof:user:${id}`,`account-factor:${id}`);for(const ip of ['127.0.0.1','::ffff:127.0.0.1'])keys.push(`login:${hash(ip)}`,`account-proof:ip:${hash(ip)}`);if(keys.length)await cache.del(keys);await cache.quit();} // 只清本轮账号与本机验收来源键
  if(database)await database.end();if(created&&administrator)await administrator.query(`DROP DATABASE ${databaseName}`);if(administrator)await administrator.end(); // 不使用FORCE掩盖连接泄漏
  if(directory)await rm(directory,{recursive:true,force:true});      // 不残留子进程产物与随机密钥环境文件
 }
});
