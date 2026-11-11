/* 商品域回归：独立PostgreSQL/Redis中执行真实主体，核对周期配置、逐分折扣、快照、并发库存与优惠额度。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/catalogue.integration.test.ts。
 * 只创建随机yunzou_scheduler_*数据库；不迁移dev，不清空Redis逻辑库。
 */
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { readdir,readFile,mkdtemp,rm } from 'node:fs/promises';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import {hash,argon2id} from 'argon2';
import { verifyAudit } from '../../../scripts/verify-audit.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
test('信用出账与自动续费跨页调度回归',{timeout:120_000},async context=>{
  const name=`yunzou_scheduler_${randomBytes(6).toString('hex')}`;
  const address=new URL(process.env.DATABASE_URL!),cacheAddress=new URL(process.env.REDIS_URL!);address.pathname='/postgres';cacheAddress.pathname='/14';
  const administrator=new pg.Client({connectionString:address.href});let store:any,directory='';const users:string[]=[];
  await administrator.connect();
  try{
    await administrator.query(`CREATE DATABASE ${name}`);address.pathname='/'+name;
    const database=new pg.Pool({connectionString:address.href});
    try{
      const files=(await readdir(join(root,'database/migrations'))).filter(file=>file.endsWith('.sql')||file.startsWith('032_')||file.startsWith('033_')).sort();
      for(const file of files)await database.query(await readFile(join(root,'database/migrations',file),'utf8'));
      process.env.DATABASE_URL=address.href;process.env.REDIS_URL=cacheAddress.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');
      directory=await mkdtemp(join(root,'.runtime/catalogue-test-'));
      await promisify(execFile)(join(root,'node_modules/.bin/tsc'),['-p',join(root,'apps/api/tsconfig.json'),'--outDir',join(directory,'api')],{cwd:root,timeout:60_000});
      const load=(file:string)=>import(pathToFileURL(join(directory,'api/features',file+'.js')).href);
      store=await load('store');await store.connect();
      const {default:Catalogue,quoteSelection,periods}=await load('catalogue'),{default:Cart}=await load('cart'),{default:Promotion}=await load('promotion'),{default:Order,purchase}=await load('order'),{default:Admin}=await load('admin'),{default:Rules}=await load('catalogue-rule'),{default:Service}=await load('service'),{default:Wallet,funds}=await load('wallet'),{default:Autorenew}=await load('autorenew'),{default:Upgrade}=await load('upgrade'),{default:Credit}=await load('credit');
      const catalogue=new Catalogue(),cart=new Cart(),promotions=new Promotion();
      const password='Catalogue-'+randomBytes(16).toString('hex'),passwordHash=await hash(password,{type:argon2id});
      const user=async()=>{const id=(await database.query("INSERT INTO users(email,name,password) VALUES($1,'隔离商品测试',$2) RETURNING id",[randomUUID()+'@catalogue.test',passwordHash])).rows[0].id;users.push(id);return {user:{id,role:'admin'}};};
      const alice=await user(),bob=await user();
      const product=async(stock=20,amount='1000')=>(await database.query("INSERT INTO products(name,price_cents,stock,provider) VALUES('可配置云主机',$1,$2,'manual') RETURNING *",[amount,stock])).rows[0];
      const setup=async(id:string)=>catalogue.configure(id,{groupId:null,periods:[{period:'month',priceCents:'1001',setupCents:'101'},{period:'quarter',priceCents:'2701',setupCents:'101'},{period:'onetime',priceCents:'9999'}],options:[{key:'region',name:'地区',kind:'select',choices:[{value:'cn',label:'中国',prices:{month:'11',quarter:'31'}},{value:'jp',label:'日本',prices:{month:'21',quarter:'61'}}]},{key:'disk',name:'数据盘',kind:'quantity',minimum:1,maximum:10,prices:{month:'7',quarter:'19'},setupCents:'3'},{key:'backup',name:'备份',kind:'boolean',prices:{month:'13',quarter:'37'}}]},alice);
      const request=(id:string,period='month',configuration:any={})=>({productId:id,quantity:1,period,configuration});
      const buy=(actor:any,items:any[],code?:string,key=randomUUID())=>store.transaction((connection:any)=>purchase(connection,actor.user.id,key,{items,promotionCode:code,fingerprint:JSON.stringify({items,code})}));

      const opening=async(actor:any,amount:string)=>store.transaction(async(connection:any)=>{const source=randomUUID(),id=randomUUID();await connection.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary)VALUES($1,$2,$3,$4,$5)',[source,'scheduler:'+source,'0123456789ABCDEF',randomBytes(32).toString('hex'),{}]);await connection.query("INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at)VALUES($1,$2,$3,'CNY',$4,now())",[id,source,actor.user.id,amount]);const ledger=(await connection.query("INSERT INTO ledger_transactions(opening_balance_id,currency)VALUES($1,'CNY')RETURNING id",[id])).rows[0];await connection.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents)VALUES($1,$2,$3),($1,'migration:equity',$4)",[ledger.id,'wallet:'+actor.user.id,(-BigInt(amount)).toString(),amount]);});
      await context.test('26份余额不足服务不占后续候选，补款恢复原账单且不重复通知',async()=>{
        const poor=await user(),funded=await user(),p=await product(null,'10'),manual=new Admin();await opening(poor,'260');await opening(funded,'20');const services:string[]=[];
        for(let index=0;index<27;index++){
          const owner=index<26?poor:funded,order=await buy(owner,[request(p.id)]);await new Wallet().pay(order.invoiceId,owner);const job=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",[order.serviceId])).rows[0];await manual.complete(job.id,{externalId:'fair-auto-'+index},alice);await database.query("UPDATE services SET auto_renew=true,due_at=now()+CASE WHEN $2::boolean THEN interval '2 hours' ELSE interval '1 hour' END WHERE id=$1",[order.serviceId,index===26]);services.push(order.serviceId);
        }
        const worker=new Autorenew();assert.equal(await worker.run(),25);assert.equal(await worker.run(),2);assert.equal(await worker.run(),0);
        assert.equal((await database.query('SELECT count(*)::int n FROM auto_renew_attempts WHERE owner_id=$1',[poor.user.id])).rows[0].n,26);assert.equal((await database.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND title='自动续费需要处理'",[poor.user.id])).rows[0].n,26);
        const rich=(await database.query("SELECT due_at>now()+interval '27 days' renewed FROM services WHERE id=$1",[services[26]])).rows[0];assert.equal(rich.renewed,true);assert.equal((await funds(store.pool,funded.user.id)).balanceCents,'0');
        const originals=(await database.query('SELECT invoice_id FROM auto_renew_attempts WHERE owner_id=$1',[poor.user.id])).rows.map(row=>row.invoice_id);await opening(poor,'10');await worker.run();assert.equal((await database.query("SELECT count(*)::int n FROM invoices WHERE id=ANY($1::uuid[]) AND status='paid'",[originals])).rows[0].n,1);assert.equal((await database.query('SELECT count(*)::int n FROM auto_renew_attempts WHERE owner_id=$1',[poor.user.id])).rows[0].n,26);assert.equal((await funds(store.pool,poor.user.id)).balanceCents,'0');assert.equal(await worker.run(),0);
      });
      await context.test('51个信用客户跨页出账，双节点与重复运行不重复归集或卡住最后客户',async()=>{
        const p=await product(null,'10'),owners:string[]=[];for(let index=0;index<51;index++){
          const person=await user();owners.push(person.user.id);await database.query("INSERT INTO credit_accounts(user_id,currency,enabled,limit_cents,note)VALUES($1,'CNY',true,100,'隔离调度授信夹具')",[person.user.id]);const order=await buy(person,[request(p.id)]);await new Credit().pay(order.invoiceId,{password},person);
        }
        const at=new Date((await database.query('SELECT max(bill_at) at FROM credit_payments')).rows[0].at.getTime()+60000);const results=await Promise.all([new Credit().run(at),new Credit().run(at)]);assert.equal(results.reduce((sum,value)=>sum+value,0),50);assert.equal(await new Credit().run(at),1);assert.equal(await new Credit().run(at),0);
        assert.equal((await database.query('SELECT count(*)::int n FROM credit_repayments WHERE user_id=ANY($1::uuid[])',[owners])).rows[0].n,51);assert.equal((await database.query('SELECT count(*)::int n FROM credit_repayment_items i JOIN credit_payments p ON p.id=i.payment_id WHERE p.user_id=ANY($1::uuid[])',[owners])).rows[0].n,51);
      });
      const verified=await verifyAudit(database,process.env.AUDIT_KEY!);assert.ok(verified.count>20);
    }finally{await database.end();}
  }finally{
    if(store){for(const id of users)await store.redis.del(`cart:${id}`);await store.close();}
    await administrator.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await administrator.end();if(directory)await rm(directory,{recursive:true,force:true});
  }
});
