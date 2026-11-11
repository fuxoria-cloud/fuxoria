/* 商品域回归：独立PostgreSQL/Redis中执行真实主体，核对周期配置、逐分折扣、快照、并发库存与优惠额度。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/catalogue.integration.test.ts。
 * 只创建随机yunzou_catalogue_*数据库；不迁移dev，不清空Redis逻辑库。
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
test('3.7.6商品周期与优惠真实事务回归',{timeout:120_000},async context=>{
  const name=`yunzou_catalogue_${randomBytes(6).toString('hex')}`;
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
      const {default:Catalogue,quoteSelection,periods}=await load('catalogue'),{default:Cart}=await load('cart'),{default:Promotion}=await load('promotion'),{default:Order,purchase}=await load('order'),{default:Admin}=await load('admin'),{default:Rules}=await load('catalogue-rule'),{default:Service}=await load('service'),{default:Wallet,funds}=await load('wallet'),{default:Autorenew}=await load('autorenew'),{default:Upgrade}=await load('upgrade');
      const catalogue=new Catalogue(),cart=new Cart(),promotions=new Promotion();
      const password='Catalogue-'+randomBytes(16).toString('hex'),passwordHash=await hash(password,{type:argon2id});
      const user=async()=>{const id=(await database.query("INSERT INTO users(email,name,password) VALUES($1,'隔离商品测试',$2) RETURNING id",[randomUUID()+'@catalogue.test',passwordHash])).rows[0].id;users.push(id);return {user:{id,role:'admin'}};};
      const alice=await user(),bob=await user();
      const product=async(stock=20,amount='1000')=>(await database.query("INSERT INTO products(name,price_cents,stock,provider) VALUES('可配置云主机',$1,$2,'manual') RETURNING *",[amount,stock])).rows[0];
      const setup=async(id:string)=>catalogue.configure(id,{groupId:null,periods:[{period:'month',priceCents:'1001',setupCents:'101'},{period:'quarter',priceCents:'2701',setupCents:'101'},{period:'onetime',priceCents:'9999'}],options:[{key:'region',name:'地区',kind:'select',choices:[{value:'cn',label:'中国',prices:{month:'11',quarter:'31'}},{value:'jp',label:'日本',prices:{month:'21',quarter:'61'}}]},{key:'disk',name:'数据盘',kind:'quantity',minimum:1,maximum:10,prices:{month:'7',quarter:'19'},setupCents:'3'},{key:'backup',name:'备份',kind:'boolean',prices:{month:'13',quarter:'37'}}]},alice);
      const request=(id:string,period='month',configuration:any={})=>({productId:id,quantity:1,period,configuration});
      const buy=(actor:any,items:any[],code?:string,key=randomUUID())=>store.transaction((connection:any)=>purchase(connection,actor.user.id,key,{items,promotionCode:code,fingerprint:JSON.stringify({items,code})}));
      await promotions.create({code:'PAY90',name:'九折',kind:'percent',value:'9000',recurring:true},alice);
      await context.test('所有周期元数据、配置报价与错误选择',async()=>{
        assert.deepEqual(Object.values(periods).map((value:any)=>value.months),[0,0,0,1,3,6,12,24,36,0]);
        const p=await product();await setup(p.id);
        const quote=await quoteSelection(store.pool,p,request(p.id,'quarter',{region:'jp',disk:3,backup:true}));
        assert.equal(quote.unitPriceCents,'2966');assert.equal(quote.renewAmountCents,'2856');assert.equal(quote.setupCents,'110');
        assert.deepEqual(quote.configurationLabels,{'地区':'日本','数据盘':'3','备份':'是'});
        await assert.rejects(()=>quoteSelection(store.pool,p,request(p.id,'quarter',{disk:11})),/数量不在允许范围/);
        await assert.rejects(()=>quoteSelection(store.pool,p,request(p.id,'year')),/不支持所选/);
        await assert.rejects(()=>quoteSelection(store.pool,p,request(p.id,'month',{forged:0})),/配置已经变化/);
      });
      await context.test('月付兼容、同商品不同配置独立行、精确删除',async()=>{
        const p=await product();await setup(p.id);
        await cart.add(request(p.id,'month',{region:'cn',disk:1}),alice);
        const two=await cart.add(request(p.id,'quarter',{region:'jp',disk:2}),alice);assert.equal(two.items.length,2);assert.notEqual(two.items[0].lineId,two.items[1].lineId);
        const removed=await cart.removeLine(two.items[0].lineId,alice);assert.equal(removed.items.length,1);assert.equal(removed.items[0].lineId,two.items[1].lineId);
        const empty=await cart.remove(p.id,alice);assert.equal(empty.items.length,0);
        const legacy=await product();const order=await buy(alice,[{productId:legacy.id,quantity:1,period:'month'}]);assert.equal(order.amountCents,'1000');assert.equal(order.items.length,1);
        const endpoint=new Order(),key=randomUUID();const first=await endpoint.create({productId:legacy.id,period:'month'},key,alice);const replay=await endpoint.create({productId:legacy.id,period:'month'},key,alice);assert.equal(first.id,replay.id);
      });
      await context.test('客户组减免后使用优惠，逐项取分且保留续费合同',async()=>{
        const grouped=await user(),p=await product();await setup(p.id);
        const group=(await database.query("INSERT INTO client_groups(name,discount_percent) VALUES('九折客户组',10) RETURNING id")).rows[0];await database.query('UPDATE users SET client_group_id=$2 WHERE id=$1',[grouped.user.id,group.id]);
        const order=await buy(grouped,[request(p.id,'quarter',{region:'jp',disk:3,backup:true})],'PAY90');assert.equal(order.amountCents,'2402');assert.equal(order.items[0].originalUnitPriceCents,'2966');assert.equal(order.items[0].discountCents,'564');
        const service=(await database.query('SELECT renew_amount_cents::text FROM services WHERE order_id=$1',[order.id])).rows[0];assert.equal(service.renew_amount_cents,'2313');
      });
      await context.test('购物车优惠修订、成交幂等与取消后恢复额度',async()=>{
        const p=await product();await promotions.create({code:'CARTONCE',name:'购物车一次额度',kind:'fixed',value:'101',maxUses:1},alice);
        const original=await cart.add(request(p.id),alice);const withPromotion=await cart.promotion({code:'cartonce'},alice);assert.notEqual(original.revision,withPromotion.revision);assert.equal(withPromotion.amountCents,'899');
        const key=randomUUID();const order=await cart.checkout({revision:withPromotion.revision},key,alice);const replay=await cart.checkout({revision:withPromotion.revision},key,alice);assert.equal(order.id,replay.id);assert.equal(order.items[0].amountCents,'899');assert.equal((await cart.get(alice)).items.length,0);
        const endpoint=new Order();await endpoint.cancel(order.id,alice);await endpoint.cancel(order.id,alice);assert.equal((await database.query('SELECT stock FROM products WHERE id=$1',[p.id])).rows[0].stock,20);
        const next=await buy(bob,[request(p.id)],'CARTONCE');assert.equal(next.amountCents,'899');
      });
      await context.test('人工交付按十种合同周期生成到期日，重复确认不延期',async()=>{
        const p=await product();await catalogue.configure(p.id,{periods:Object.keys(periods).map(period=>({period,priceCents:'0'})),options:[]},alice);const admin=new Admin();
        for(const [period,meta] of Object.entries(periods) as [string,{months:number;seconds:number}][]){
          const order=await buy(bob,[request(p.id,period)]);assert.equal(order.status,'paid');const job=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",[order.serviceId])).rows[0];assert.ok(job);
          await admin.complete(job.id,{externalId:'manual-'+period},alice);const state=(await database.query("SELECT status,due_at,CASE WHEN billing_months=0 AND billing_seconds=0 THEN due_at IS NULL ELSE due_at BETWEEN now()+make_interval(months=>billing_months,secs=>billing_seconds)-interval '2 seconds' AND now()+make_interval(months=>billing_months,secs=>billing_seconds)+interval '2 seconds' END correct FROM services WHERE id=$1",[order.serviceId])).rows[0];assert.equal(state.status,'active');assert.equal(state.correct,true);if(meta.months===0&&meta.seconds===0&&period!=='ontrial')assert.equal(state.due_at,null);
          await admin.complete(job.id,{externalId:'manual-'+period},alice);assert.deepEqual((await database.query('SELECT due_at FROM services WHERE id=$1',[order.serviceId])).rows[0].due_at,state.due_at);
        }
      });
      await context.test('折后单价乘数量、续费价与历史快照保持整数',async()=>{
        const p=await product();await setup(p.id);
        const item={...request(p.id,'quarter',{region:'jp',disk:3,backup:true}),quantity:3};
        const order=await buy(alice,[item],'PAY90');assert.equal(order.amountCents,'8007');assert.equal(order.items[0].unitPriceCents,'2669');assert.equal(order.items[0].amountCents,'8007');assert.equal(order.items[0].discountCents,'297');
        const contracts=(await database.query('SELECT renew_amount_cents::text,configuration,billing_period,billing_months FROM services WHERE order_id=$1',[order.id])).rows;
        assert.equal(contracts.length,3);assert.ok(contracts.every(row=>row.renew_amount_cents==='2570'&&row.billing_period==='quarter'&&row.billing_months===3));
        await database.query("UPDATE products SET name='后来改名',price_cents=2000 WHERE id=$1",[p.id]);await setup(p.id);
        const immutable=(await database.query('SELECT product_name,unit_price_cents::text,configuration_labels FROM order_items WHERE order_id=$1',[order.id])).rows[0];assert.equal(immutable.product_name,'可配置云主机');assert.equal(immutable.unit_price_cents,'2669');assert.equal(immutable.configuration_labels['地区'],'日本');
      });
      await context.test('免安装费、固定减免、覆盖价格与一次性合同',async()=>{
        const p=await product();await setup(p.id);
        for(const [code,kind,value,amount] of [['FREESETUP','free','0','1026'],['FIXED200','fixed','200','933'],['OVERRIDE','override','500','500']] as const){await promotions.create({code,name:code,kind,value},alice);const order=await buy(bob,[request(p.id,'month',{region:'cn',disk:2})],code);assert.equal(order.amountCents,amount);}
        const one=await buy(bob,[request(p.id,'onetime',{region:'cn',disk:1})]);const contract=(await database.query('SELECT billing_period,billing_months FROM services WHERE order_id=$1',[one.id])).rows[0];assert.deepEqual(contract,{billing_period:'onetime',billing_months:0});
      });
      await context.test('同商品跨配置合计库存，失败整单回滚',async()=>{
        const p=await product(2);await setup(p.id);const before=(await database.query('SELECT count(*)::int n FROM orders')).rows[0].n;
        await assert.rejects(()=>buy(alice,[{...request(p.id,'month',{region:'cn',disk:1}),quantity:2},{...request(p.id,'quarter',{region:'jp',disk:2}),quantity:1}]),/库存不足/);
        assert.equal((await database.query('SELECT stock FROM products WHERE id=$1',[p.id])).rows[0].stock,2);assert.equal((await database.query('SELECT count(*)::int n FROM orders')).rows[0].n,before);
      });
      await context.test('不同客户并发抢最后库存与最后优惠额度',async()=>{
        const p=await product(1);const results=await Promise.allSettled([buy(alice,[request(p.id)]),buy(bob,[request(p.id)])]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await database.query('SELECT stock FROM products WHERE id=$1',[p.id])).rows[0].stock,0);
        const left=await product(),right=await product();await promotions.create({code:'ONLYONCE',name:'唯一额度',kind:'fixed',value:'1',maxUses:1},alice);
        const limited=await Promise.allSettled([buy(alice,[request(left.id)],'ONLYONCE'),buy(bob,[request(right.id)],'ONLYONCE')]);assert.equal(limited.filter(result=>result.status==='fulfilled').length,1);assert.equal((await database.query("SELECT count(*)::int n FROM promotion_uses u JOIN promotions p ON p.id=u.promotion_id WHERE p.code='ONLYONCE'")).rows[0].n,1);
      });
      await context.test('优惠范围、时间、次数、首单与不可变证据',async()=>{
        const p=await product(),other=await product();
        for(const [code,fields,pattern] of [['EXPIRED',{endsAt:'2020-01-01T00:00:00Z'},/已经结束/],['FUTURE',{startsAt:'2099-01-01T00:00:00Z'},/尚未开始/],['SCOPED',{productIds:[other.id]},/范围/],['FIRSTONLY',{firstOrderOnly:true},/首次购买/]] as const){await promotions.create({code,name:code,kind:'fixed',value:'1',...fields},alice);await assert.rejects(()=>buy(alice,[request(p.id)],code),pattern);}
        const first=await user();await promotions.create({code:'PERSONAL',name:'每人一次',kind:'fixed',value:'1',perUserLimit:1,periods:['month']},alice);await buy(first,[request(p.id)],'PERSONAL');await assert.rejects(()=>buy(first,[request(p.id)],'PERSONAL'),/次数/);
        await assert.rejects(()=>database.query('UPDATE order_items SET quantity=quantity+1'),/不能修改|只.*追加|不可变|不允许/);
        await assert.rejects(()=>database.query('DELETE FROM promotion_uses'),/不能修改|只.*追加|不可变|不允许/);
      });
      await context.test('条件与链式选项在报价和成交同算，循环和失效引用不能保存',async()=>{
        const p=await product(),rules=new Rules();await catalogue.configure(p.id,{periods:[{period:'month',priceCents:'1000'}],options:[{key:'region',name:'地区',kind:'select',choices:[{value:'cn',label:'中国'},{value:'jp',label:'日本'}]},{key:'zone',name:'可用区',kind:'select',choices:[{value:'cn1',label:'中国一'},{value:'jp1',label:'日本一'}]},{key:'disk',name:'磁盘',kind:'quantity',minimum:0,maximum:100,prices:{month:'1'}},{key:'backup',name:'备份',kind:'boolean'}]},alice);
        const definitions=[{name:'中国可用区',conditions:[{key:'region',operator:'eq',value:'cn'}],effects:[{key:'zone',allowedValues:['cn1']}]},{name:'日本可用区',conditions:[{key:'region',operator:'eq',value:'jp'}],effects:[{key:'zone',allowedValues:['jp1']}]},{name:'日本磁盘下限',conditions:[{key:'zone',operator:'eq',value:'jp1'}],effects:[{key:'disk',minimum:20,maximum:30}]},{name:'备份模式隐藏磁盘',conditions:[{key:'backup',operator:'eq',value:true}],effects:[{key:'disk',hidden:true}]}];await rules.save(p.id,{rules:definitions},alice);
        const normalized=await catalogue.quote({...request(p.id,'month',{region:'jp',zone:'cn1',disk:0,backup:false})});assert.equal(normalized.configuration.zone,'jp1');assert.equal(normalized.configuration.disk,20);assert.equal(normalized.unitPriceCents,'1020');
        await assert.rejects(()=>buy(alice,[request(p.id,'month',{region:'jp',zone:'cn1',disk:20,backup:false})]),/不兼容/);
        const actual=await buy(alice,[request(p.id,'month',normalized.configuration)]);assert.equal(actual.amountCents,'1020');assert.equal(actual.items[0].pricingSource.rules.length,2);
        const hidden=await catalogue.quote(request(p.id,'month',{region:'cn',zone:'cn1',disk:1,backup:true}));assert.equal(hidden.options.find((option:any)=>option.key==='disk').hidden,true);assert.equal(Object.hasOwn(hidden.configuration,'disk'),false);
        await assert.rejects(()=>rules.save(p.id,{rules:[...definitions,{name:'循环引用',conditions:[{key:'zone',operator:'eq',value:'cn1'}],effects:[{key:'region',allowedValues:['cn']}]}]},alice),/循环/);
        await assert.rejects(()=>catalogue.configure(p.id,{periods:[{period:'month',priceCents:'1000'}],options:[]},alice),/不存在/);assert.equal((await catalogue.configuration(p.id)).options.length,4);
        await rules.price(p.id,{userId:alice.user.id,period:'month',priceCents:'123',setupCents:'4'},alice);const special=await buy(alice,[request(p.id,'month',{region:'cn',zone:'cn1',disk:2,backup:false})]);assert.equal(special.amountCents,'127');assert.equal(special.items[0].pricingSource.customPrice.priceCents,'123');const normal=await buy(bob,[request(p.id,'month',{region:'cn',zone:'cn1',disk:2,backup:false})]);assert.equal(normal.amountCents,'1002');
      });
      const credit=async(actor:any,amount:string)=>store.transaction(async(connection:any)=>{const source=randomUUID(),opening=randomUUID();await connection.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary)VALUES($1,$2,$3,$4,$5)',[source,'catalogue:'+source,randomBytes(8).toString('hex').toUpperCase(),randomBytes(32).toString('hex'),{}]);await connection.query("INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at)VALUES($1,$2,$3,'CNY',$4,now())",[opening,source,actor.user.id,amount]);const ledger=(await connection.query("INSERT INTO ledger_transactions(opening_balance_id,currency)VALUES($1,'CNY')RETURNING id",[opening])).rows[0];await connection.query('INSERT INTO ledger_entries(transaction_id,account,amount_cents)VALUES($1,$2,$3),($1,$4,$5)',[ledger.id,'wallet:'+actor.user.id,(-BigInt(amount)).toString(),'migration:equity',amount]);});
      await context.test('试用永久一次、不能续费或自动续费，转正只有真实付款与供应商确认才切周期',async()=>{
        const owner=await user(),p=await product();await catalogue.configure(p.id,{trialDays:2,periods:[{period:'ontrial',priceCents:'0'},{period:'month',priceCents:'1000'},{period:'quarter',priceCents:'2700'}],options:[]},alice);
        await assert.rejects(()=>buy(owner,[{...request(p.id,'ontrial'),quantity:2}]),/一件/);const attempts=await Promise.allSettled([buy(owner,[request(p.id,'ontrial')]),buy(owner,[request(p.id,'ontrial')])]);assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);const trial=(attempts.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<any>).value;
        const job=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",[trial.serviceId])).rows[0];await new Admin().complete(job.id,{externalId:'trial-resource'},alice);assert.equal((await database.query('SELECT billing_seconds FROM services WHERE id=$1',[trial.serviceId])).rows[0].billing_seconds,172800);
        await assert.rejects(()=>new Service().renew(trial.serviceId,randomUUID(),{period:'ontrial'},owner),/一次性服务无需续费|当前服务的计费周期/);await assert.rejects(()=>new Autorenew().authorize(trial.serviceId,{enabled:true,password},owner),/不支持自动续费/);
        const upgrades=new Upgrade(),quote=await upgrades.quote(trial.serviceId,{productId:p.id,configuration:{},period:'quarter'},owner);assert.equal(quote.amountCents,'2700');assert.equal(quote.cycleChange,true);const change=await upgrades.create(trial.serviceId,randomUUID(),{quoteId:quote.id},owner);await credit(owner,'10000');await new Wallet().pay(change.invoiceId,owner);
        assert.equal((await database.query('SELECT billing_period FROM services WHERE id=$1',[trial.serviceId])).rows[0].billing_period,'ontrial');const operation=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='upgrade'",[trial.serviceId])).rows[0];await new Admin().complete(operation.id,{note:'隔离测试供应商已确认转为季付'},alice);assert.equal((await database.query('SELECT billing_period FROM services WHERE id=$1',[trial.serviceId])).rows[0].billing_period,'quarter');assert.equal((await database.query('SELECT period FROM order_items WHERE order_id=$1',[trial.id])).rows[0].period,'ontrial');await assert.rejects(()=>buy(owner,[request(p.id,'ontrial')]),/已使用过/);
      });
      await context.test('小时与日付只在周期四分之一窗口内自动续费一次，新到期日不触发连续预付',async()=>{
        const owner=await user(),p=await product();await catalogue.configure(p.id,{periods:[{period:'hour',priceCents:'10'},{period:'day',priceCents:'100'}],options:[]},alice);await credit(owner,'10000');const scheduler=new Autorenew(),second=new Autorenew();
        for(const [period,amount,outside,inside,window] of [['hour','10','30 minutes','5 minutes',900],['day','100','7 hours','3 hours',21600]] as const){
          const order=await buy(owner,[request(p.id,period)]);await new Wallet().pay(order.invoiceId,owner);const job=(await database.query("SELECT id FROM jobs WHERE service_id=$1 AND action='provision'",[order.serviceId])).rows[0];await new Admin().complete(job.id,{externalId:'metered-'+period},alice);await scheduler.authorize(order.serviceId,{enabled:true,password},owner);
          assert.equal((await database.query("SELECT (details->>'windowSeconds')::int AS seconds FROM audit WHERE target=$1 AND action='service.auto_renew' ORDER BY id DESC LIMIT 1",[order.serviceId])).rows[0].seconds,window);
          await database.query('UPDATE services SET due_at=now()+$2::interval WHERE id=$1',[order.serviceId,outside]);const before=await funds(store.pool,owner.user.id);await scheduler.run();assert.equal((await funds(store.pool,owner.user.id)).balanceCents,before.balanceCents);
          await database.query('UPDATE services SET due_at=now()+$2::interval WHERE id=$1',[order.serviceId,inside]);await Promise.all([scheduler.run(),second.run()]);const after=await funds(store.pool,owner.user.id);assert.equal(BigInt(before.balanceCents)-BigInt(after.balanceCents),BigInt(amount));await scheduler.run();assert.equal((await funds(store.pool,owner.user.id)).balanceCents,after.balanceCents);assert.equal((await database.query('SELECT count(*)::int n FROM renewals WHERE service_id=$1',[order.serviceId])).rows[0].n,1);
        }
      });
      const verified=await verifyAudit(database,process.env.AUDIT_KEY!);assert.ok(verified.count>20);
    }finally{await database.end();}
  }finally{
    if(store){for(const id of users)await store.redis.del(`cart:${id}`);await store.close();}
    await administrator.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await administrator.end();if(directory)await rm(directory,{recursive:true,force:true});
  }
});
