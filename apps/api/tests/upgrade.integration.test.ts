/* 服务升降级真实事务验证：随机PostgreSQL库，实际收款/钱包/人工交付与不可变成交约束。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/upgrade.integration.test.ts。
 * 不替换财务主体，所有收款是本轮内部已验签结果夹具，不请求支付机构。
 */
import 'reflect-metadata';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import type {SessionRequest} from '../src/utils/access.js';
if(!process.env.DATABASE_URL)process.loadEnvFile(new URL('../../../.env',import.meta.url));
const source=process.env.UPGRADE_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;if(!['localhost','127.0.0.1','[::1]'].includes(new URL(source).hostname))throw new Error('升降级测试只连接本机隔离数据库');
const database='yunzou_upgrade_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);target.pathname='/'+database;process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');
const {pool}=await import('../src/features/store.js');
const {default:Upgrade,upgradeCharge}=await import('../src/features/upgrade.js');
const Admin=(await import('../src/features/admin.js')).default;
const Recharge=(await import('../src/features/recharge.js')).default;
const Wallet=(await import('../src/features/wallet.js')).default;
const {settle}=await import('../src/features/settlement.js');
const {verifyAudit}=await import('../../../scripts/verify-audit.js');
const upgrades=new Upgrade(),administrator=new Admin();let created=false;
let owner:SessionRequest,other:SessionRequest,operator:SessionRequest;
async function identity(role='customer'){const user=(await pool.query('INSERT INTO users(email,name,password,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role',[randomUUID()+'@upgrade.test','升降级测试','fixture-only',role])).rows[0];return {user,actorId:user.id,requestId:randomUUID()} as SessionRequest;}
async function fixture(oldPrice='1000',newPrice='2001',provider='manual'){
 const product=(await pool.query('INSERT INTO products(name,price_cents,provider) VALUES($1,$2,$3) RETURNING id',['原服务',oldPrice,provider])).rows[0];
 const target=(await pool.query('INSERT INTO products(name,price_cents,provider) VALUES($1,$2,$3) RETURNING id',['新方案',newPrice,provider])).rows[0];
 const order=(await pool.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1,$2,$3,'fixture',$4) RETURNING id",[owner.user.id,product.id,randomUUID(),oldPrice])).rows[0];
 const service=(await pool.query("INSERT INTO services(user_id,product_id,order_id,name,status,external_id,due_at,renew_amount_cents) VALUES($1,$2,$3,'实际已交付服务','active','existing-resource',clock_timestamp()+interval '15 days',$4) RETURNING id,due_at::text AS due",[owner.user.id,product.id,order.id,oldPrice])).rows[0];
 return {product,target,order,service};
}
async function pay(invoiceId:string){const invoice=(await pool.query('SELECT amount_cents,currency FROM invoices WHERE id=$1',[invoiceId])).rows[0];await pool.query("INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,'epay') ON CONFLICT DO NOTHING",[invoiceId]);return settle('epay',{invoiceId,amountCents:invoice.amount_cents,currency:invoice.currency,paid:true,transactionId:randomUUID()});}
before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;
 const directory=new URL('../../../database/migrations/',import.meta.url),files=await readdir(directory),selected=new Map<string,string>();
 for(const file of files.filter(file=>(file.endsWith('.sql')||file.endsWith('.draft'))).sort()){const key=file.slice(0,3);if(!selected.has(key)||file.endsWith('.sql'))selected.set(key,file);}
 for(const file of [...selected.values()].sort())await pool.query(await readFile(new URL(file,directory),'utf8'));
 [owner,other,operator]=await Promise.all([identity(),identity(),identity('admin')]);
});
after(async()=>{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();});

test('差价只用BigInt有理数向上取到分，降配没有虚构退款',()=>{assert.equal(upgradeCharge(100n,101n,1n,3n),1n);assert.equal(upgradeCharge(1000n,2001n,15n,30n),501n);assert.equal(upgradeCharge(2000n,1000n,1n,2n),0n);assert.equal(upgradeCharge(0n,999999999999n,999999999n,1000000000n),999999999000n);});

test('报价绑定当前归属/供应商/计费时间，拒绝越权、跨供应商和离线能力',async()=>{
 const f=await fixture();const quote=await upgrades.quote(f.service.id,{productId:f.target.id,configuration:{}},owner);
 assert.equal(quote.amountCents,upgradeCharge(1000n,2001n,BigInt(quote.remainingMs),BigInt(quote.periodMs)).toString());assert.equal(quote.renewAmountCents,'2001');
 await assert.rejects(upgrades.quote(f.service.id,{productId:f.target.id},other),/服务不存在/);
 const foreign=(await pool.query("INSERT INTO products(name,price_cents,provider) VALUES('另一供应商',1000,'foreign') RETURNING id")).rows[0];await assert.rejects(upgrades.quote(f.service.id,{productId:foreign.id},owner),/跨供应商/);
 const offline=await fixture('1000','2000','offline-provider');assert.equal((await upgrades.options(offline.service.id,owner)).canUpgrade,false);await assert.rejects(upgrades.quote(offline.service.id,{productId:offline.target.id},owner),/供应商/);
 await assert.rejects(pool.query('UPDATE service_upgrades SET amount_cents=0 WHERE id=$1',[quote.id]),/快照不能修改/);
});

test('同键并发只产生一张差价账单，真实支付后仍保留旧配置直到人工确认',async()=>{
 const f=await fixture(),quote=await upgrades.quote(f.service.id,{productId:f.target.id,configuration:{}},owner),key=randomUUID();
 const results=await Promise.all(Array.from({length:8},()=>upgrades.create(f.service.id,key,{quoteId:quote.id},owner)));assert.equal(new Set(results.map(row=>row.invoiceId)).size,1);
 const order=results[0];assert.equal((await pool.query('SELECT current_product_id FROM services WHERE id=$1',[f.service.id])).rows[0].current_product_id,null);await pay(order.invoiceId);
 const job=(await pool.query("SELECT * FROM jobs WHERE service_id=$1 AND action='upgrade'",[f.service.id])).rows[0];assert.equal(job.state,'queued');assert.equal(job.payload.productId,f.target.id);
 let service=(await pool.query('SELECT *,due_at::text AS due FROM services WHERE id=$1',[f.service.id])).rows[0];assert.equal(service.current_product_id,null);assert.equal(service.renew_amount_cents,'1000');
 await administrator.complete(job.id,{note:'已在供应商面板核对并完成配置变更。'},operator);
 service=(await pool.query('SELECT *,due_at::text AS due FROM services WHERE id=$1',[f.service.id])).rows[0];assert.equal(service.current_product_id,f.target.id);assert.equal(service.product_id,f.product.id);assert.equal(service.order_id,f.order.id);assert.equal(service.renew_amount_cents,'2001');assert.equal(service.due,f.service.due);assert.equal(service.external_id,'existing-resource');
 const original=(await pool.query('SELECT product_id FROM order_items WHERE order_id=$1',[f.order.id])).rows[0];assert.equal(original.product_id,f.product.id);
 await administrator.complete(job.id,{note:'网络重试'},operator);assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit WHERE target=$1 AND action='service.deliver'",[f.service.id])).rows[0].count,1);
});

test('降配创建0元成交与真实任务，不增加钱包或伪造现金退款',async()=>{
 const f=await fixture('2000','800'),quote=await upgrades.quote(f.service.id,{productId:f.target.id},owner);assert.equal(quote.amountCents,'0');
 const purchase=await upgrades.create(f.service.id,randomUUID(),{quoteId:quote.id},owner);assert.equal(purchase.status,'paid');
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM payment_receipts WHERE invoice_id=$1',[purchase.invoiceId])).rows[0].count,0);
 const job=(await pool.query("SELECT id FROM jobs WHERE service_id=$1 AND action='upgrade'",[f.service.id])).rows[0];await administrator.complete(job.id,{note:'已真实完成降配。'},operator);
 assert.equal((await pool.query('SELECT renew_amount_cents FROM services WHERE id=$1',[f.service.id])).rows[0].renew_amount_cents,'800');assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit WHERE target=$1 AND action='upgrade.create' AND details->>'refundCents'='0'",[f.service.id])).rows[0].count,1);
});

test('归属或配置变化后的外部实收款保留收入并进入核对，不给新归属覆盖资源',async()=>{
 const f=await fixture(),quote=await upgrades.quote(f.service.id,{productId:f.target.id},owner),purchase=await upgrades.create(f.service.id,randomUUID(),{quoteId:quote.id},owner);
 await pool.query('UPDATE services SET current_owner_id=$2 WHERE id=$1',[f.service.id,other.user.id]);await pay(purchase.invoiceId);
 assert.equal((await pool.query('SELECT status FROM invoices WHERE id=$1',[purchase.invoiceId])).rows[0].status,'paid');assert.equal((await pool.query('SELECT reason FROM billing_reviews WHERE invoice_id=$1',[purchase.invoiceId])).rows[0].reason,'upgrade_resource_changed');
 assert.equal((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE service_id=$1 AND action='upgrade'",[f.service.id])).rows[0].count,0);assert.equal((await pool.query('SELECT current_product_id FROM services WHERE id=$1',[f.service.id])).rows[0].current_product_id,null);
});

test('失效配置的余额付款原子回滚，不提前扣钱包或结清账单',async()=>{
 const recharge=await new Recharge().create({amountCents:'100000'},randomUUID(),owner);await pay(recharge.invoiceId);
 const f=await fixture(),quote=await upgrades.quote(f.service.id,{productId:f.target.id},owner),purchase=await upgrades.create(f.service.id,randomUUID(),{quoteId:quote.id},owner),wallet=new Wallet();
 const before=await wallet.get(owner);await pool.query("UPDATE services SET configuration='{\"changed\":true}' WHERE id=$1",[f.service.id]);
 await assert.rejects(wallet.pay(purchase.invoiceId,owner),/已变化/);assert.deepEqual(await wallet.get(owner),before);
 assert.equal((await pool.query('SELECT status FROM invoices WHERE id=$1',[purchase.invoiceId])).rows[0].status,'unpaid');assert.equal((await pool.query('SELECT count(*)::int AS count FROM wallet_payments WHERE invoice_id=$1',[purchase.invoiceId])).rows[0].count,0);
});

test('过期报价不能创建订单，数据库拒绝未执行成功的配置应用，完整审计链可验',async()=>{
 const f=await fixture(),quote=await upgrades.quote(f.service.id,{productId:f.target.id},owner);
 const expired=(await pool.query("INSERT INTO service_upgrades SELECT (jsonb_populate_record(NULL::service_upgrades,to_jsonb(u)||jsonb_build_object('id',$2::text,'expires_at',(clock_timestamp()-interval '1 second')::text))).* FROM service_upgrades u WHERE id=$1 RETURNING id",[quote.id,randomUUID()])).rows[0];
 await assert.rejects(upgrades.create(f.service.id,randomUUID(),{quoteId:expired.id},owner),/报价或原服务已变化/);
 const current=await upgrades.quote(f.service.id,{productId:f.target.id},owner),purchase=await upgrades.create(f.service.id,randomUUID(),{quoteId:current.id},owner);await pay(purchase.invoiceId);
 const job=(await pool.query("SELECT id FROM jobs WHERE service_id=$1 AND action='upgrade'",[f.service.id])).rows[0];await assert.rejects(pool.query('SELECT apply_service_upgrade($1::uuid)',[job.id]),/实际付款和执行成功/);
 const verified=await verifyAudit(pool,process.env.AUDIT_KEY!);assert.ok(verified.count>0);
});


test('自动续费在扣款事务重新核对停用账户，候选快照不能越过停用',async()=>{
 const Recharge=(await import('../src/features/recharge.js')).default,Service=(await import('../src/features/service.js')).default;
 const recharge=await new Recharge().create({amountCents:'100000'},randomUUID(),owner);await pay(recharge.invoiceId);
 const f=await fixture();const due=(await pool.query("UPDATE services SET auto_renew=true,due_at=clock_timestamp()+interval '23 hours' WHERE id=$1 RETURNING due_at::text AS due",[f.service.id])).rows[0].due;
 const invoice=await new Service().renew(f.service.id,randomUUID(),{period:'month'},owner,{dueAt:due});
 await pool.query('UPDATE users SET disabled=true WHERE id=$1',[owner.user.id]);
 try{await assert.rejects(new Wallet().pay(invoice.invoiceId,owner,{serviceId:f.service.id,dueAt:due}),/授权|账号|账户/);}finally{await pool.query('UPDATE users SET disabled=false WHERE id=$1',[owner.user.id]);}
 assert.equal((await pool.query('SELECT status FROM invoices WHERE id=$1',[invoice.invoiceId])).rows[0].status,'unpaid');
});
