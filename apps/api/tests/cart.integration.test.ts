/*
 * 购物车验收：真实PostgreSQL、Redis与独立API验证多项汇总、并发库存、版本CAS、免费交付和旧单项回填。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/cart.integration.test.ts。
 * 只使用yunzou_cart_test、API3304、Redis DB13；013为draft时也显式执行，绝不改dev数据。
 */
import 'reflect-metadata';                                        // 直接故障注入也使用实际Nest业务主体
import test from 'node:test';                                      // 业务竞态在子场景中显式并发
import assert from 'node:assert/strict';                            // 核对HTTP结果与持久资金/库存事实
import { createHash,randomBytes,randomUUID } from 'node:crypto';     // 独立商户与不可预测测试凭据
import { existsSync } from 'node:fs';                              // 环境可直接注入连接
import { mkdtemp,readdir,readFile,rm } from 'node:fs/promises';       // 每次编译独立API产物并在结束清理
import { join } from 'node:path';                                  // 不和root或其它agent共享正在重建的dist
import { fileURLToPath,pathToFileURL } from 'node:url';              // ESM定位项目与临时业务入口
import { execFile,spawn,type ChildProcess } from 'node:child_process'; // 运行实际API，不安装依赖或执行前端构建
import { promisify } from 'node:util';                              // 编译失败直接反馈测试
import { setTimeout as delay } from 'node:timers/promises';          // 有界等待数据库锁和进程退出
import pg from 'pg';                                              // 所有约束和事务都在真实数据库验收
import { createClient } from 'redis';                              // 独立逻辑库内保留真实CAS行为
import { verifyAudit } from '../../../scripts/verify-audit.js';      // 免费/付费/取消共用审计链

const root=fileURLToPath(new URL('../../../',import.meta.url));     // 启动目录变化也不会读错迁移
const execute=promisify(execFile);                                 // 参数分开传，不经过shell
const origin='https://cart.yunzou.test',base='http://127.0.0.1:3304/api/v1'; // 与dev站点和API完全隔离
const password=`Cart-${randomBytes(18).toString('hex')}`;            // 不借用任何真实账号密码
const key=randomBytes(32).toString('hex');                          // 只给隔离易支付通知签名
const audit=randomBytes(32).toString('hex');                        // 不使用根审计密钥造测试数据

type Actor={id:string;cookie:string;email:string};                 // 身份从真实HTTP注册获取
let database:pg.Pool,cache:ReturnType<typeof createClient>,process_:ChildProcess|undefined; // 清理按实际资源逐一执行
let administrator:pg.Client|undefined,directory='',created=false;   // 只删本轮创建的预留库
let directStore:any;                                              // 仅在故障注入子场景打开真实业务连接
const tokens=new Set<string>(),addresses=new Set<string>();        // 不扫描或清空其他人的会话
const oldEnvironment={DATABASE_URL:process.env.DATABASE_URL,REDIS_URL:process.env.REDIS_URL,AUDIT_KEY:process.env.AUDIT_KEY}; // 只恢复测试进程自己的配置

async function request(method:string,path:string,actor?:Actor,body?:unknown,token?:string){
 const headers:Record<string,string>={origin};                      // Cookie写操作遵守真实CSRF规则
 if(actor)headers.cookie=actor.cookie;if(body!==undefined)headers['content-type']='application/json';if(token)headers['idempotency-key']=token; // 不接收自报客户ID
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15_000)}); // 请求故障不会无限等待
 for(const value of response.headers.getSetCookie()){const token=/^yunzou_session=([^;]+)/.exec(value)?.[1];if(token)tokens.add(decodeURIComponent(token));} // 精确记录本轮令牌
 const text=await response.text();let data:any=text;try{data=JSON.parse(text);}catch{} // 机构纯文本与API JSON各有真实含义
 return {status:response.status,data,headers:response.headers};     // 不把Cookie或签名URL写入日志
}
function expect(response:{status:number;data:any},status:number){assert.equal(response.status,status,response.status>=400?JSON.stringify(response.data):'HTTP状态不符');} // 错误回执不含密钥
async function register(label:string):Promise<Actor>{
 const email=`${label}-${randomUUID()}@example.test`;addresses.add(email); // 账号不与开发数据碰撞
 const result=await request('POST','/auth/register',undefined,{email,name:label,password});expect(result,201); // 经过实际Argon2和会话流程
 return {id:result.data.id,email,cookie:result.headers.getSetCookie().find(value=>value.startsWith('yunzou_session='))!.split(';')[0]}; // 只保留本轮会话
}
async function product(admin:Actor,price='100',stock:number|null=20){
 const result=await request('POST','/admin/products',admin,{name:`购物车商品-${randomUUID()}`,description:'隔离验收',priceCents:price,currency:'CNY',stock,provider:'manual',active:true});expect(result,201); // 免费和付费均走真实后台校验
 return result.data;
}
async function add(actor:Actor,productId:string,quantity=1){const result=await request('POST','/cart',actor,{productId,quantity,period:'month'});expect(result,201);return result.data;} // 所有数量通过HTTP边界
async function clear(actor:Actor){expect(await request('DELETE','/cart',actor),200);} // 清空也生成新revision
async function checkout(actor:Actor,revision:string,token=randomUUID()){return request('POST','/cart/checkout',actor,{revision},token);} // 每次新业务动作使用稳定key
async function wait(check:()=>Promise<boolean>,message:string){for(let index=0;index<150;index++){if(await check())return;await delay(20);}throw new Error(message);} // 不用长固定sleep猜时序

async function settle(actor:Actor,invoiceId:string,amount:string){
 expect(await request('POST',`/invoices/${invoiceId}/checkout`,actor,{gateway:'epay'}),201); // 先通过收银台登记支付渠道
 const cents=BigInt(amount);const fields:Record<string,string>={pid:'cart-test-merchant',out_trade_no:invoiceId.replaceAll('-',''),trade_no:`cart-${randomUUID()}`,money:`${cents/100n}.${(cents%100n).toString().padStart(2,'0')}`,trade_status:'TRADE_SUCCESS'}; // 真实V1协议金额
 const source=Object.keys(fields).sort().map(name=>`${name}=${fields[name]}`).join('&');fields.sign=createHash('md5').update(source+key).digest('hex');fields.sign_type='MD5'; // 独立参考签名，不开放模拟付款端点
 const result=await request('GET',`/payments/epay/notify?${new URLSearchParams(fields)}`);expect(result,200);assert.equal(result.data,'success'); // 正常结清汇总账单
}

async function stop(){
 if(!process_ || process_.exitCode!==null || process_.signalCode!==null)return; // 不重复给已经退出的进程发信号
 const exited=new Promise<void>(resolve=>process_!.once('exit',()=>resolve())); // 先监听再停止
 process_.kill('SIGTERM');await Promise.race([exited,delay(4000,undefined,{ref:false})]); // 等待真实连接优雅关闭
 if(process_.exitCode===null && process_.signalCode===null){process_.kill('SIGKILL');await exited;} // 异常进程也不能留在后台
}

test('购物车与多项订单真实并发验收',{timeout:180_000},async context=>{
 let alice!:Actor,bob!:Actor,admin!:Actor;let environment:NodeJS.ProcessEnv={}; // 各账号购买选择与权限独立
 try{
  if(existsSync(join(root,'.env')))process.loadEnvFile(join(root,'.env')); // 仅借用基础设施服务器地址
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL);       // 无真实依赖不能假报通过
  const address=new URL(process.env.DATABASE_URL!);address.pathname='/postgres';administrator=new pg.Client({connectionString:address.href});await administrator.connect(); // 不进dev业务库准备数据
  assert.equal((await administrator.query('SELECT pg_try_advisory_lock(812443) AS locked')).rows[0].locked,true); // 同名测试不能互删
  await administrator.query('DROP DATABASE IF EXISTS yunzou_cart_test WITH (FORCE)');await administrator.query('CREATE DATABASE yunzou_cart_test');created=true; // 只操作预留库
  address.pathname='/yunzou_cart_test';database=new pg.Pool({connectionString:address.href,max:12}); // 测试断言走独立连接
  await database.query('CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())'); // 与生产启动检查使用同一迁移登记
  const migrations=(await readdir(join(root,'database/migrations'))).filter(name=>name.endsWith('.sql') || name==='013_cart.sql.draft').sort(); // 未发布draft只在本测试显式执行
  for(const name of migrations.filter(name=>name<'013_cart.sql')){const sql=await readFile(join(root,'database/migrations',name),'utf8');await database.query(sql);await database.query('INSERT INTO migrations(name,hash)VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);} // 先建旧版真实结构
  const legacy=(await database.query(`WITH u AS(INSERT INTO users(email,name,password) VALUES('legacy-cart@example.test','旧单项','unused') RETURNING id),
    p AS(INSERT INTO products(name,price_cents,stock) VALUES('旧单项商品',75,9) RETURNING id),
    o AS(INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) SELECT u.id,p.id,'legacy-cart-order','old-hash',75 FROM u,p RETURNING *)
    INSERT INTO services(user_id,product_id,order_id,name) SELECT user_id,product_id,id,'旧服务' FROM o RETURNING id,order_id`)).rows[0]; // 创建升级前的真实单项归属
  const draftName=migrations.find(name=>name.startsWith('013_'))!;const draftSql=await readFile(join(root,'database/migrations',draftName),'utf8');await database.query(draftSql);await database.query('INSERT INTO migrations(name,hash)VALUES($1,$2)',[draftName.replace(/\.draft$/,''),createHash('sha256').update(draftSql).digest('hex')]);
  for(const name of migrations.filter(name=>name>'013_cart.sql.draft')){const sql=await readFile(join(root,'database/migrations',name),'utf8');await database.query(sql);await database.query('INSERT INTO migrations(name,hash)VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);} // 后续迁移保持生产中的真实顺序 // 真正接受DDL语法与回填验收
  const redisAddress=new URL(process.env.REDIS_URL!);redisAddress.pathname='/13';cache=createClient({url:redisAddress.href});await cache.connect(); // 使用专用逻辑库，绝不FLUSHDB
  directory=await mkdtemp(join(root,'.runtime/cart-test-'));         // 独立编译目录避免其它agent重建dist时互相删除
  await execute(join(root,'node_modules/.bin/tsc'),['-p',join(root,'apps/api/tsconfig.json'),'--outDir',join(directory,'api')],{cwd:root,timeout:90_000}); // 不执行npm install或Nuxt命令
  environment={...process.env,DATABASE_URL:address.href,REDIS_URL:redisAddress.href,AUDIT_KEY:audit,TOTP_KEY:randomBytes(32).toString('hex'),PUBLIC_ORIGIN:origin,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'3304',EPAY_VERSION:'1',EPAY_URL:'https://cart-pay.example.invalid/submit.php',EPAY_PID:'cart-test-merchant',EPAY_KEY:key}; // 假商户仅在测试进程存在
  let logs='';process_=spawn(process.execPath,[join(directory,'api/main.js')],{cwd:root,env:environment,stdio:['ignore','pipe','pipe']}); // 运行真实API
  const keep=(value:Buffer)=>{logs=(logs+value.toString()).slice(-10_000);};process_.stdout!.on('data',keep);process_.stderr!.on('data',keep); // 有界日志只用于启动诊断
  await wait(async()=>{try{return (await fetch(base+'/health')).status===200;}catch{return false;}},'购物车API未能启动').catch(error=>{throw new Error(error.message+'：'+logs.replaceAll(audit,'[redacted]').replaceAll(key,'[redacted]'));}); // 依赖就绪后才发业务请求
  alice=await register('cart-alice');bob=await register('cart-bob');admin=await register('cart-admin');await database.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]); // 不复用dev管理员

  await context.test('旧单项服务回填成交项，原HTTP入口保持兼容',async()=>{
   const old=(await database.query('SELECT s.order_item_id,s.item_number,i.quantity,i.unit_price_cents::text AS price FROM services s JOIN order_items i ON i.id=s.order_item_id WHERE s.id=$1',[legacy.id])).rows[0]; // 回填不会丢历史服务
   assert.deepEqual({number:old.item_number,quantity:old.quantity,price:old.price},{number:1,quantity:1,price:'75'}); // 成交金额来自旧订单
   const cte=(await database.query(`WITH u AS(INSERT INTO users(email,name,password) VALUES(gen_random_uuid()::text||'@cte.test','CTE兼容','unused') RETURNING id),
     p AS(INSERT INTO products(name,price_cents) VALUES('CTE商品',90) RETURNING id),
     o AS(INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) SELECT u.id,p.id,gen_random_uuid()::text,'cte',90 FROM u,p RETURNING *),
     s AS(INSERT INTO services(user_id,product_id,order_id,name) SELECT user_id,product_id,id,'CTE服务' FROM o RETURNING id)
     INSERT INTO jobs(service_id,action,provider,dedup_key) SELECT id,'provision','manual',gen_random_uuid()::text FROM s RETURNING service_id`)).rows[0]; // Go等旧调用在一个命令中创建整条归属
   assert.ok((await database.query('SELECT order_item_id FROM services WHERE id=$1',[cte.service_id])).rows[0].order_item_id); // 提交阶段应读到其它CTE创建的成交行，不报P0002
   const selected=await product(admin,'120',4);const token=randomUUID(); // 新单项仍使用旧body
   const first=await request('POST','/orders',alice,{productId:selected.id,period:'month'},token);expect(first,201); // 兼容单项入口
   const second=await request('POST','/orders',alice,{productId:selected.id,period:'month'},token);expect(second,201); // 同key重放
   assert.equal(first.data.id,second.data.id);assert.ok(first.data.invoiceId && first.data.serviceId);assert.equal(first.data.items.length,1);assert.deepEqual(first.data.serviceIds,[first.data.serviceId]); // 首件返回字段保留
   assert.equal((await database.query('SELECT stock FROM products WHERE id=$1',[selected.id])).rows[0].stock,3); // 只扣一次库存
  });

  await context.test('购物车CRUD、实时价格、数量边界和账号隔离',async()=>{
   expect(await request('GET','/cart'),401);                        // 不做匿名假购物车
   const selected=await product(admin,'100',10);let cart=await add(alice,selected.id,2); // 原价100分两件
   assert.equal(cart.amountCents,'200');const revision=cart.revision; // 报价与选择版本是不同事实
   assert.equal((await request('GET','/cart',bob)).data.items.length,0); // 其它账号看不到客户选择
   expect(await request('PUT','/cart',alice,{productId:selected.id,quantity:3,period:'month'}),200); // 绝对数量修改
   expect(await request('POST','/cart',alice,{productId:selected.id,quantity:21,period:'month'}),400); // 明确的单行上限
   expect(await request('PUT','/cart',alice,{productId:selected.id,quantity:0,period:'month'}),400); // 不能用0隐式删除
   expect(await request('POST','/cart',alice,{productId:selected.id,quantity:1,period:'year'}),409); // 年付是有效周期，但本商品尚未配置
   expect(await request('POST','/cart',alice,{productId:selected.id,quantity:1,period:'century'}),400); // 未定义周期仍由边界拒绝
   expect(await request('POST','/cart',alice,{productId:selected.id,quantity:1,period:'month',priceCents:'0'}),400); // 客户不能在购物选择中塞入自报金额
   const renamed={name:'已调价商品',description:'隔离验收',priceCents:'150',currency:'CNY',stock:10,provider:'manual',active:true};expect(await request('PUT',`/admin/products/${selected.id}`,admin,renamed),200); // 实际后台调价
   cart=(await request('GET','/cart',alice)).data;assert.equal(cart.amountCents,'450');assert.notEqual(cart.revision,revision); // 当前价格不从Redis旧快照推算
   expect(await request('DELETE',`/cart/${selected.id}`,alice),200);assert.equal((await request('GET','/cart',alice)).data.items.length,0); // 只删除指定客户的一项
   const removed=await product(admin,'70',5);await add(alice,removed.id,1);await database.query('DELETE FROM products WHERE id=$1',[removed.id]); // 模拟尚未成交商品被移除
   const unknown=(await request('GET','/cart',alice)).data;assert.equal(unknown.amountCents,null);assert.equal(unknown.items[0].unitPriceCents,null);assert.equal(unknown.canCheckout,false); // 未知报价不能显示为免费
   await clear(alice);                                            // 留新revision阻止旧提交
  });

  await context.test('多项合成一张订单账单，每件一个服务，支付后全部排队一次',async()=>{
   const first=await product(admin,'101',10),second=await product(admin,'203',10),free=await product(admin,'0',10); // 混合免费行仍按整张账单结算
   await add(alice,first.id,2);await add(alice,second.id,3);const cart=await add(alice,free.id,1); // 总额202+609+0=811分
   const token=randomUUID();const results=await Promise.all(Array.from({length:10},()=>checkout(alice,cart.revision,token))); // 网络重试真正并发
   for(const result of results)expect(result,201);assert.equal(new Set(results.map(result=>result.data.id)).size,1); // 只有一个订单头
   const order=results[0].data;assert.equal(order.amountCents,'811');assert.equal(order.items.length,3);assert.equal(order.serviceIds.length,6); // 一个汇总额，三行六件
   assert.equal((await database.query('SELECT count(*)::int n FROM invoices WHERE order_id=$1',[order.id])).rows[0].n,1); // 不能每个服务拆出多张账单
   assert.equal((await database.query('SELECT count(*)::int n FROM jobs WHERE service_id=ANY($1::uuid[])',[order.serviceIds])).rows[0].n,0); // 未付混合账单也不提前交付免费部分
   await settle(alice,order.invoiceId,'811');                      // 真实签名通知结清全部明细
   const counts=(await database.query('SELECT (SELECT count(*)::int FROM jobs WHERE service_id=ANY($1::uuid[])) AS jobs,(SELECT count(*)::int FROM payment_receipts WHERE invoice_id=$2) AS receipts',[order.serviceIds,order.invoiceId])).rows[0]; // 每件都必须有可靠任务
   assert.deepEqual(counts,{jobs:6,receipts:1});                    // 一个收款对应六件资源，而不是只开首件
   const replay=await checkout(alice,cart.revision,token);expect(replay,201);assert.equal(replay.data.id,order.id); // 清车后仍可重放原revision
   assert.equal(replay.data.orderConfirmed,true);assert.equal((await request('GET','/cart',alice)).data.items.length,0); // 合法重放不再加服务
   await assert.rejects(database.query("UPDATE order_items SET unit_price_cents=999 WHERE order_id=$1",[order.id]),/只能追加/); // 成交快照不能被后来调价覆盖
  });

  await context.test('库存任一行不足整车回滚，购物车和其它库存完整保留',async()=>{
   const first=await product(admin,'77',10),short=await product(admin,'88',1); // 另一行不足不能先扣可用行
   await add(alice,first.id,2);const cart=await add(alice,short.id,2);assert.equal(cart.canCheckout,false); // 页面报价明确提示不足
   const before=(await database.query('SELECT count(*)::int n FROM orders')).rows[0].n;expect(await checkout(alice,cart.revision),409); // 真正事务拒绝而非前端自阻止
   assert.equal((await database.query('SELECT count(*)::int n FROM orders')).rows[0].n,before); // 没有半张订单
   assert.equal((await database.query('SELECT stock FROM products WHERE id=$1',[first.id])).rows[0].stock,10); // 首行也不留预占
   assert.equal((await request('GET','/cart',alice)).data.revision,cart.revision); // 失败不能先清车
   await clear(alice);
  });

  await context.test('两个客户反向加入同组商品不会死锁或超卖，取消退回每件数量',async()=>{
   const first=await product(admin,'10',3),second=await product(admin,'20',3); // 两车都要两件，供给只够一车
   await add(alice,first.id,2);const left=await add(alice,second.id,2);await add(bob,second.id,2);const right=await add(bob,first.id,2); // 操作顺序相反
   const results=await Promise.all([checkout(alice,left.revision),checkout(bob,right.revision)]);assert.equal(results.filter(result=>result.status===201).length,1);assert.equal(results.filter(result=>result.status===409).length,1); // 无500死锁和负库存
   const winner=results[0].status===201?alice:bob;const order=results.find(result=>result.status===201)!.data; // 不预设锁的胜者
   expect(await request('POST',`/orders/${order.id}/cancel`,winner),201);expect(await request('POST',`/orders/${order.id}/cancel`,winner),201); // 重复取消不能加倍退库存
   const stocks=(await database.query('SELECT stock FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',[[first.id,second.id]])).rows.map(row=>row.stock);assert.deepEqual(stocks,[3,3]); // 两行每件都释放
   assert.equal((await database.query("SELECT count(*)::int n FROM services WHERE order_id=$1 AND status='cancelled'",[order.id])).rows[0].n,4); // 每件资源同步取消
   await clear(alice);await clear(bob);
  });

  await context.test('旧revision、同key换快照和同revision换key明确冲突',async()=>{
   const selected=await product(admin,'33',10);const first=await add(alice,selected.id,1);const current=await add(alice,selected.id,1); // 同商品现在为两件，新revision
   expect(await checkout(alice,first.revision),409);                 // 首次请求不能结算已修改选择
   const one=randomUUID(),two=randomUUID();const results=await Promise.all([checkout(alice,current.revision,one),checkout(alice,current.revision,two)]); // 不同key争抢同快照
   assert.equal(results.filter(result=>result.status===201).length,1);assert.equal(results.filter(result=>result.status===409).length,1); // revision唯一约束防换key重复结算
   const token=results[0].status===201?one:two;const changed=await add(alice,selected.id,1); // 原车已消费后客户重新选择
   expect(await checkout(alice,changed.revision,token),409);        // 旧key不能换新购物车内容
   await clear(alice);
  });

  await context.test('数据库提交前并发加新商品，CAS保留整份新购物车',async()=>{
   const first=await product(admin,'41',10),second=await product(admin,'42',10);const cart=await add(alice,first.id,1);const token=randomUUID(); // 用户确认原快照
   const blocker=await database.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[first.id]); // 控制真正的数据库竞争时序
   const submitted=checkout(alice,cart.revision,token);             // 此请求会在商品锁处等待
   try{
    await wait(async()=>Boolean((await database.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM products WHERE id=ANY%') AS waiting")).rows[0].waiting),'结算未进入商品锁等待'); // 不靠固定sleep猜测是否读过快照
    const changed=await add(alice,second.id,1);                     // 另一标签页在资金事务等待时添加新内容
    await blocker.query('COMMIT');const paid=await submitted;expect(paid,201); // 原快照完成后CAS应失败而保留新版本
    assert.equal(paid.data.cartChanged,true);assert.equal(paid.data.cartCleared,true);assert.equal(paid.data.orderConfirmed,true); // 订单成功与新购物车并存
    const saved=(await request('GET','/cart',alice)).data;assert.equal(saved.revision,changed.revision);assert.ok(saved.items.some((item:any)=>item.productId===second.id)); // 并发新加商品没有消失
    const replay=await checkout(alice,cart.revision,token);expect(replay,201);assert.equal(replay.data.id,paid.data.id);assert.equal(replay.data.cartChanged,true); // 旧key原revision仍可确认原订单
    assert.equal((await request('GET','/cart',alice)).data.revision,changed.revision); // 重放也不能删除新车
   }finally{await blocker.query('ROLLBACK');blocker.release();}      // 错误路径同样释放本轮持有的锁
   await clear(alice);
  });

  await context.test('提交后Redis同步故障仍返回已确认订单，同key重试恢复清车',async()=>{
   const selected=await product(admin,'51',10);const cart=await add(alice,selected.id,1);const token=randomUUID(); // 使用实际购物车数据
   process.env.DATABASE_URL=environment.DATABASE_URL;process.env.REDIS_URL=environment.REDIS_URL;process.env.AUDIT_KEY=audit; // 只给当前测试进程的实际业务模块连接隔离依赖
   directStore=await import(pathToFileURL(join(directory,'api/features/store.js')).href);await directStore.connect(); // 连接真实PG与Redis
   const commandOptions=directStore.redis.withCommandOptions.bind(directStore.redis);let proxy:any,original:any,failed=false; // 保留真实两秒命令边界
   directStore.redis.withCommandOptions=(options:any)=>{proxy=commandOptions(options);original=proxy.eval.bind(proxy);proxy.eval=async(script:string,arguments_:any)=>{if(!failed && script.includes("redis.call('DEL'")){failed=true;throw new Error('test-only Redis boundary failure');}return original(script,arguments_);};return proxy;}; // 只在新建购物车命令代理处注入一次外部故障
   const Cart=(await import(pathToFileURL(join(directory,'api/features/cart.js')).href)).default;const controller=new Cart(); // 不复制结算主线
   try{
    const confirmed=await controller.checkout({revision:cart.revision},token,{user:{id:alice.id}});assert.equal(confirmed.orderConfirmed,true);assert.equal(confirmed.cartCleared,false); // DB成功不能被缓存故障伪装成失败
    const repeated=await controller.checkout({revision:cart.revision},token,{user:{id:alice.id}});assert.equal(repeated.id,confirmed.id);assert.equal(repeated.cartCleared,true); // 原key恢复清理，不再扣库存
    assert.equal((await database.query('SELECT count(*)::int n FROM orders WHERE user_id=$1 AND idempotency_key=$2',[alice.id,token])).rows[0].n,1); // 实际数据库只留一张订单
   }finally{proxy.eval=original;directStore.redis.withCommandOptions=commandOptions;}                      // 故障注入不能泄漏到后续检查
  });

  await context.test('免费单项与全免费购物车直接交付且没有假收款或会计凭据',async()=>{
   const first=await product(admin,'0',20),second=await product(admin,'0',20); // 后台真实支持零价商品
   const direct=await request('POST','/orders',alice,{productId:first.id,period:'month'},randomUUID());expect(direct,201);assert.equal(direct.data.status,'paid');assert.ok(direct.data.invoiceId && direct.data.serviceId); // 老接口免费也保留账单与服务ID
   await add(alice,first.id,2);const cart=await add(alice,second.id,3);const result=await checkout(alice,cart.revision);expect(result,201); // 一个免费汇总订单
   assert.equal(result.data.status,'paid');assert.equal(result.data.amountCents,'0');assert.equal(result.data.serviceIds.length,5); // 所有件都建立独立服务
   const facts=(await database.query('SELECT (SELECT status FROM invoices WHERE id=$1) AS invoice,(SELECT count(*)::int FROM payment_receipts WHERE invoice_id=$1) AS receipts,(SELECT count(*)::int FROM wallet_payments WHERE invoice_id=$1) AS wallets,(SELECT count(*)::int FROM jobs WHERE service_id=ANY($2::uuid[])) AS jobs',[result.data.invoiceId,result.data.serviceIds])).rows[0]; // 免费交付不伪造付款来源
   assert.deepEqual(facts,{invoice:'paid',receipts:0,wallets:0,jobs:5}); // 钱包、机构收款都不产生零金额凭据
   assert.equal((await database.query("SELECT count(*)::int n FROM audit WHERE action='order.free' AND target=$1",[result.data.id])).rows[0].n,1); // 免费依据进入审计
   const manual=(await database.query('SELECT id FROM jobs WHERE service_id=$1',[direct.data.serviceId])).rows[0]; // 免费首件也通过真实人工交付步骤
   expect(await request('POST',`/admin/jobs/${manual.id}/complete`,admin,{externalId:'isolated-free-resource'}),201); // 只在隔离测试内确认示例资源
   const due=(await database.query('SELECT due_at::text AS due FROM services WHERE id=$1',[direct.data.serviceId])).rows[0].due; // 保留数据库完整时间精度
   const renewalKey=randomUUID();const renewals=await Promise.all(Array.from({length:8},()=>request('POST',`/services/${direct.data.serviceId}/renew`,alice,{period:'month'},renewalKey))); // 免费续费也可能被并发重试
   for(const renewal of renewals)expect(renewal,201);assert.equal(new Set(renewals.map(renewal=>renewal.data.id)).size,1);assert.equal(renewals[0].data.status,'paid'); // 不能留下无人可付的0元未付款账单
   assert.equal((await database.query("SELECT due_at=$2::timestamptz+interval '1 month' AS once FROM services WHERE id=$1",[direct.data.serviceId,due])).rows[0].once,true); // 免费续费只延长一次
   assert.equal((await database.query('SELECT count(*)::int n FROM payment_receipts WHERE invoice_id=$1',[renewals[0].data.invoiceId])).rows[0].n,0); // 免费续费同样没有虚构收款
   const checked=await verifyAudit(database,audit);assert.ok(checked.count>20); // 竞争、免费和故障恢复的审计链保持完整
  });
 }finally{
  if(directStore)await directStore.close();await stop();            // 先停所有依赖使用者
  if(cache?.isOpen){const hash=(value:string)=>createHash('sha256').update(value).digest('hex');const keys=[...tokens].map(token=>`session:${hash(token)}`);for(const email of addresses)keys.push(`login:${hash(email)}`);keys.push(`login:${hash('127.0.0.1')}`,`login:${hash('::ffff:127.0.0.1')}`);if(created){const people=await database.query('SELECT id FROM users');for(const user of people.rows)keys.push(`cart:${user.id}`);}if(keys.length)await cache.del(keys);await cache.quit();} // 只清理自己创建的键
  if(database)await database.end();if(created&&administrator)await administrator.query('DROP DATABASE yunzou_cart_test WITH (FORCE)');if(administrator)await administrator.end(); // 即使断言失败也删除专用库
  for(const [name,value] of Object.entries(oldEnvironment)){if(value===undefined)delete process.env[name];else process.env[name]=value;} // 恢复测试进程环境
  if(directory)await rm(directory,{recursive:true,force:true});      // 不留临时API产物
 }
});
