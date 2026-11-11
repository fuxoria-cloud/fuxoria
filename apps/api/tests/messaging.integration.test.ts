/* 持久消息队列真实回归：随机PostgreSQL、生产Access/Nest HTTP、Redis会话和临时文件发送程序。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/messaging.integration.test.ts。
 * 本轮发送程序把消息交到私有临时文件，不访问真实邮箱或短信机构，不向API返回验证码。
 */
import 'reflect-metadata';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {hash} from 'argon2';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type {Response} from 'express';
if(!process.env.DATABASE_URL)process.loadEnvFile(new URL('../../../.env',import.meta.url));
const source=process.env.VERIFICATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;if(!['127.0.0.1','localhost','[::1]'].includes(new URL(source).hostname))throw new Error('验证测试只允许本机隔离数据库');
const database='yunzou_messaging_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);target.pathname='/'+database;
process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');process.env.TOTP_KEY=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'yunzou-messaging-')),config=join(directory,'senders.json'),outbox=join(directory,'outbox.jsonl'),script=join(directory,'sender.cjs');process.env.MESSAGE_SENDER_CONFIG=config;process.env.VERIFICATION_TEST_OUTBOX=outbox;process.env.MESSAGE_TEST_MODE='accept';
const {pool,redis}=await import('../src/features/store.js');
const {Access,tokenHash}=await import('../src/utils/access.js');
const {start}=await import('../src/features/session.js');
const {default:Messaging,nextMessageTime}=await import('../src/features/messaging.js');
const Verification=(await import('../src/features/verification.js')).default,Account=(await import('../src/features/account.js')).default,Security=(await import('../src/features/security.js')).default;
const {totp}=await import('../src/utils/otp.js');
const {verifyAudit}=await import('../../../scripts/verify-audit.js');
class TestApplication{}Module({controllers:[Messaging,Verification,Account,Security]})(TestApplication);
let app:INestApplication,worker:InstanceType<typeof Messaging>,url='',created=false;const sessions=new Set<string>(),users:string[]=[];const password='Verification-isolated-password-2026';
type Identity={id:string;cookie:string};
let owner:Identity,operator:Identity;
async function identity(role='customer'):Promise<Identity>{const row=(await pool.query('INSERT INTO users(email,name,password,role,email_verified_at) VALUES($1,$2,$3,$4,now()) RETURNING id',[randomUUID()+'@example.test','消息回归',await hash(password),role])).rows[0];users.push(row.id);let token='';await start(row.id,0,{cookie(_name:string,value:string){token=value;sessions.add(tokenHash(value));}} as unknown as Response);return {id:row.id,cookie:'yunzou_session='+token};}
async function http(path:string,who:Identity|null,method='GET',body?:unknown,key?:string){const response=await fetch(url+path,{method,headers:{...(who?{Cookie:who.cookie}:{}),Origin:process.env.PUBLIC_ORIGIN!,...(key?{'Idempotency-Key':key}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json();let cookie='';for(const header of response.headers.getSetCookie()){const match=/^yunzou_session=([^;]+)/.exec(header);if(match){cookie='yunzou_session='+match[1];sessions.add(tokenHash(decodeURIComponent(match[1])));}}return {status:response.status,data,cookie};}
async function okay(path:string,who:Identity,method='GET',body?:unknown,key?:string){const result=await http(path,who,method,body,key);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result.data));return result;}
async function message(id:string){return (await readFile(outbox,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.id===id);}
async function enable(){await writeFile(config,JSON.stringify({email:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX','MESSAGE_TEST_MODE']},sms:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX','MESSAGE_TEST_MODE']}}),{mode:0o600});process.env.MESSAGE_SENDER_CONFIG=config;}
async function challenge(who:Identity,channel='email',destination=randomUUID()+'@example.test'){return (await okay('/auth/verification/challenges',who,'POST',{channel,destination})).data;}
before(async()=>{
 await writeFile(script,"const fs=require('node:fs'),message=JSON.parse(fs.readFileSync(0,'utf8')),path=process.env.VERIFICATION_TEST_OUTBOX;const mode=process.env.MESSAGE_TEST_MODE;if(mode==='retry'){process.stdout.write(JSON.stringify({accepted:false,retryable:true}));process.exit(0);}let existing=[];try{existing=fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}if(!existing.some(item=>item.id===message.id))fs.appendFileSync(path,JSON.stringify(message)+'\\n',{mode:0o600});if(mode==='unknown')process.exit(1);process.stdout.write(JSON.stringify({accepted:true}));",{mode:0o600});await enable();
 await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;const root=new URL('../../../database/migrations/',import.meta.url),files=await readdir(root),selected=new Map<string,string>();
 for(const file of files.filter(file=>(file.endsWith('.sql')||file.endsWith('.draft'))).sort()){const key=file.slice(0,3);if(!selected.has(key)||file.endsWith('.sql'))selected.set(key,file);}for(const file of [...selected.values()].sort())await pool.query(await readFile(new URL(file,root),'utf8'));
 await redis.connect();app=await NestFactory.create(TestApplication,{logger:false});app.setGlobalPrefix('api/v1');app.use(cookieParser());app.useGlobalGuards(new Access());await app.listen(0,'127.0.0.1');url=(await app.getUrl())+'/api/v1';worker=app.get(Messaging);worker.onModuleDestroy();owner=await identity();operator=await identity('admin');
});
after(async()=>{if(app)await app.close();if(redis.isOpen){for(const token of sessions)await redis.del('session:'+token);for(const id of users)await redis.del([`account-proof:user:${id}`,`account-factor:${id}`]);await redis.del('account-proof:ip:'+tokenHash('127.0.0.1'));await redis.quit();}await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});


async function template(input:Record<string,unknown>={}){return (await okay('/admin/messaging/templates',operator,'POST',{name:'实际消息模板',channel:'site',category:'transactional',scope:'account',subject:'通知 {{name}}',body:'你好，{{name}}，这是本次需要核对的进展。',...input})).data;}
async function batch(templateId:string,userIds:string[],key=randomUUID()){return (await okay('/admin/messaging/batches',operator,'POST',{templateId,userIds},key)).data;}
async function boxes(){try{return (await readFile(outbox,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}
async function pref(values:Record<string,unknown>){return okay('/message-preferences',owner,'PUT',{emailMarketing:false,smsMarketing:false,siteMarketing:false,quietEnabled:false,quietStart:1260,quietEnd:480,...values});}

test('模板校验与批次并发幂等，发送前仅有持久意图，站内任务只产生一条消息',async()=>{
 assert.equal((await http('/admin/messaging/templates',owner,'POST',{name:'越权',channel:'site',category:'transactional',subject:'标题',body:'内容'})).status,403);
 assert.equal((await http('/admin/messaging/templates',operator,'POST',{name:'无效',channel:'site',category:'transactional',subject:'{{constructor}}',body:'内容'})).status,400);
 const tpl=await template(),key=randomUUID(),results=await Promise.all([batch(tpl.id,[owner.id],key),batch(tpl.id,[owner.id,owner.id],key)]);assert.equal(results[0].id,results[1].id);assert.equal(results[0].queued,1);assert.equal(results[0].sent,0);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id=$1',[owner.id])).rows[0].count,0);
 await Promise.all([worker.run(),new Messaging().run()]);const progress=(await okay('/admin/messaging/batches/'+results[0].id,operator)).data;assert.equal(progress.total,1);assert.equal(progress.sent,1);assert.equal((await pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id=$1',[owner.id])).rows[0].count,1);
});

test('营销默认不订阅，显式订阅才发送，退订会实际取消待发任务且不影响验证码渠道',async()=>{
 const tpl=await template({channel:'email',category:'marketing'}),first=await batch(tpl.id,[owner.id]);await worker.run();assert.equal((await okay('/admin/messaging/batches/'+first.id,operator)).data.skipped,1);
 await pref({emailMarketing:true});const allowed=await batch(tpl.id,[owner.id]);await worker.run();assert.equal((await okay('/admin/messaging/batches/'+allowed.id,operator)).data.sent,1);assert.equal((await boxes()).length,1);assert.equal('code' in (await boxes())[0],false);
 const queued=await batch(tpl.id,[owner.id]);await pref({emailMarketing:false});await worker.run();assert.equal((await okay('/admin/messaging/batches/'+queued.id,operator)).data.cancelled,1);assert.equal((await boxes()).length,1);assert.equal((await okay('/auth/verification',owner)).data.emailEnabled,true);
});

test('免打扰跨午夜/夏令时按客户时区生效，退出免打扰后待发任务可继续',async()=>{
 const timezone=(await pool.query('SELECT timezone FROM users WHERE id=$1',[owner.id])).rows[0].timezone,parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),minute=Number(parts.find(part=>part.type==='hour')!.value)*60+Number(parts.find(part=>part.type==='minute')!.value);
 await pref({quietEnabled:true,quietStart:minute,quietEnd:(minute+30)%1440});const tpl=await template(),queued=await batch(tpl.id,[owner.id]);await worker.run();let job=(await pool.query('SELECT * FROM message_jobs WHERE batch_id=$1',[queued.id])).rows[0];assert.equal(job.state,'queued');assert.equal(job.attempts,0);assert.ok(new Date(job.run_at).getTime()>Date.now());
 const dst=nextMessageTime({emailMarketing:false,smsMarketing:false,siteMarketing:false,quietEnabled:true,quietStart:60,quietEnd:180},'America/New_York',new Date('2026-03-08T06:30:00Z'));assert.equal(dst!.toISOString(),'2026-03-08T07:00:00.000Z');
 await pref({quietEnabled:false});await worker.run();job=(await pool.query('SELECT * FROM message_jobs WHERE batch_id=$1',[queued.id])).rows[0];assert.equal(job.state,'sent');
});

test('机构结果未知保留待核对，不盲目重试；本人密码与凭据核对后沿原幂等ID重试',async()=>{
 process.env.MESSAGE_TEST_MODE='unknown';const tpl=await template({channel:'email'}),queued=await batch(tpl.id,[owner.id]);await worker.run();let job=(await pool.query('SELECT * FROM message_jobs WHERE batch_id=$1',[queued.id])).rows[0];assert.equal(job.state,'uncertain');assert.equal(job.sent_at,null);assert.equal(job.attempts,1);const count=(await boxes()).length;
 process.env.MESSAGE_TEST_MODE='accept';await worker.run();assert.equal((await boxes()).length,count);assert.equal((await okay('/admin/messaging/batches/'+queued.id,operator)).data.sent,0);
 assert.equal((await http('/admin/messaging/jobs/'+job.id+'/resolve',operator,'POST',{action:'retry',evidence:'已在机构核对原请求',password:'wrong-password'})).status,401);
 await okay('/admin/messaging/jobs/'+job.id+'/resolve',operator,'POST',{action:'retry',evidence:'已核对原机构记录，按原任务幂等编号继续确认',password});await worker.run();job=(await pool.query('SELECT * FROM message_jobs WHERE batch_id=$1',[queued.id])).rows[0];assert.equal(job.state,'sent');assert.equal(job.attempts,2);assert.equal((await boxes()).filter(item=>item.id===job.id).length,1);
});

test('明确未受理才按退避重试，过期执行租约只转未知，不能假报成功',async()=>{
 const tpl=await template({channel:'email'});process.env.MESSAGE_TEST_MODE='retry';const queued=await batch(tpl.id,[owner.id]);await worker.run();let job=(await pool.query('SELECT * FROM message_jobs WHERE batch_id=$1',[queued.id])).rows[0];assert.equal(job.state,'queued');assert.equal(job.attempts,1);assert.equal(job.sent_at,null);assert.ok(new Date(job.run_at).getTime()>Date.now());
 process.env.MESSAGE_TEST_MODE='accept';await pool.query('UPDATE message_jobs SET run_at=now() WHERE id=$1',[job.id]);await worker.run();job=(await pool.query('SELECT * FROM message_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(job.state,'sent');assert.equal(job.attempts,2);
 const lost=await batch(tpl.id,[owner.id]);await pool.query("UPDATE message_jobs SET state='running',lease_token=gen_random_uuid(),lease_until=now()-interval '1 second',attempts=1 WHERE batch_id=$1",[lost.id]);const before=(await boxes()).length;await worker.run();assert.equal((await pool.query('SELECT state FROM message_jobs WHERE batch_id=$1',[lost.id])).rows[0].state,'uncertain');assert.equal((await boxes()).length,before);
});

test('关怀规则多节点幂等且超过100位客户继续推进，服务转移后旧接收方不获通知',async()=>{
 await pool.query("INSERT INTO users(email,name,password,created_at) SELECT gen_random_uuid()::text||'@care.test','关怀客户'||n,'unused',now()-interval '2 days' FROM generate_series(1,105) n");
 const tpl=await template(),rule=(await okay('/admin/messaging/care',operator,'POST',{name:'注册两天关怀',templateId:tpl.id,trigger:'registered_days',days:2,active:true})).data;
 const runs=await Promise.all([worker.scheduleCare(),new Messaging().scheduleCare()]);assert.equal(runs.reduce((a,b)=>a+b,0),100);await pool.query("UPDATE client_care_rules SET last_checked_at=now()-interval '61 seconds' WHERE id=$1",[rule.id]);assert.equal(await worker.scheduleCare(),5);assert.equal((await pool.query('SELECT count(*)::int AS count FROM message_jobs WHERE rule_id=$1',[rule.id])).rows[0].count,105);
 await worker.run(100);await worker.run(20);assert.equal((await pool.query("SELECT count(*)::int AS count FROM message_jobs WHERE rule_id=$1 AND state='sent'",[rule.id])).rows[0].count,105);
 const templateRow=(await pool.query('SELECT * FROM message_templates WHERE id=$1',[tpl.id])).rows[0];const {id,...input}=templateRow;delete input.created_at;delete input.updated_at;assert.equal((await http('/admin/messaging/templates/'+tpl.id,operator,'PUT',{...input,scope:'service'})).status,409);
 const plan=(await pool.query("INSERT INTO products(name,price_cents) VALUES('关怀服务',100) RETURNING id")).rows[0],order=(await pool.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1,$2,$3,'care-fixture',100) RETURNING id",[owner.id,plan.id,randomUUID()])).rows[0];const service=(await pool.query("INSERT INTO services(user_id,product_id,order_id,name,status,due_at) VALUES($1,$2,$3,'到期服务','active',clock_timestamp()+interval '3 days') RETURNING id",[owner.id,plan.id,order.id])).rows[0];
 const serviceTemplate=await template({scope:'service',subject:'{{serviceName}}到期提醒',body:'{{name}}，服务将于{{dueAt}}到期。'}),serviceRule=(await okay('/admin/messaging/care',operator,'POST',{name:'到期前三天',templateId:serviceTemplate.id,trigger:'service_due_days',days:3,productIds:[plan.id],active:true})).data;assert.equal(await worker.scheduleCare(),1);await pool.query('UPDATE services SET current_owner_id=$2 WHERE id=$1',[service.id,operator.id]);await worker.run();assert.equal((await pool.query('SELECT state FROM message_jobs WHERE rule_id=$1',[serviceRule.id])).rows[0].state,'skipped');
 const checked=await verifyAudit(pool,process.env.AUDIT_KEY!);assert.ok(checked.count>0);
});
