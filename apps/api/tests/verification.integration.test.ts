/* 邮箱手机验证真实回归：随机PostgreSQL、生产Access/Nest HTTP、Redis会话和临时文件发送程序。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/verification.integration.test.ts。
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
const database='yunzou_verification_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);target.pathname='/'+database;
process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');process.env.TOTP_KEY=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'yunzou-verification-')),config=join(directory,'senders.json'),outbox=join(directory,'outbox.jsonl'),script=join(directory,'sender.cjs');process.env.MESSAGE_SENDER_CONFIG=config;process.env.VERIFICATION_TEST_OUTBOX=outbox;
const {pool,redis}=await import('../src/features/store.js');
const {Access,tokenHash}=await import('../src/utils/access.js');
const {start}=await import('../src/features/session.js');
const Verification=(await import('../src/features/verification.js')).default,Account=(await import('../src/features/account.js')).default,Security=(await import('../src/features/security.js')).default;
const {totp}=await import('../src/utils/otp.js');
const {verifyAudit}=await import('../../../scripts/verify-audit.js');
class TestApplication{}Module({controllers:[Verification,Account,Security]})(TestApplication);
let app:INestApplication,url='',created=false;const sessions=new Set<string>(),users:string[]=[];const password='Verification-isolated-password-2026';
type Identity={id:string;cookie:string};
async function identity():Promise<Identity>{const row=(await pool.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) RETURNING id',[randomUUID()+'@example.test','验证回归',await hash(password)])).rows[0];users.push(row.id);let token='';await start(row.id,0,{cookie(_name:string,value:string){token=value;sessions.add(tokenHash(value));}} as unknown as Response);return {id:row.id,cookie:'yunzou_session='+token};}
async function http(path:string,who:Identity|null,method='GET',body?:unknown){const response=await fetch(url+path,{method,headers:{...(who?{Cookie:who.cookie}:{}),Origin:process.env.PUBLIC_ORIGIN!,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json();let cookie='';for(const header of response.headers.getSetCookie()){const match=/^yunzou_session=([^;]+)/.exec(header);if(match){cookie='yunzou_session='+match[1];sessions.add(tokenHash(decodeURIComponent(match[1])));}}return {status:response.status,data,cookie};}
async function okay(path:string,who:Identity,method='GET',body?:unknown){const result=await http(path,who,method,body);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result.data));return result;}
async function message(id:string){return (await readFile(outbox,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.id===id);}
async function enable(){await writeFile(config,JSON.stringify({email:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX']},sms:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX']}}),{mode:0o600});process.env.MESSAGE_SENDER_CONFIG=config;}
async function challenge(who:Identity,channel='email',destination=randomUUID()+'@example.test'){return (await okay('/auth/verification/challenges',who,'POST',{channel,destination})).data;}
before(async()=>{
 await writeFile(script,"const fs=require('node:fs');const message=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(process.env.VERIFICATION_TEST_OUTBOX,JSON.stringify(message)+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({accepted:true}));",{mode:0o600});await enable();
 await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;const root=new URL('../../../database/migrations/',import.meta.url),files=await readdir(root),selected=new Map<string,string>();
 for(const file of files.filter(file=>(file.endsWith('.sql')||file.endsWith('.draft'))).sort()){const key=file.slice(0,3);if(!selected.has(key)||file.endsWith('.sql'))selected.set(key,file);}for(const file of [...selected.values()].sort())await pool.query(await readFile(new URL(file,root),'utf8'));
 await redis.connect();app=await NestFactory.create(TestApplication,{logger:false});app.setGlobalPrefix('api/v1');app.use(cookieParser());app.useGlobalGuards(new Access());await app.listen(0,'127.0.0.1');url=(await app.getUrl())+'/api/v1';
});
after(async()=>{if(app)await app.close();if(redis.isOpen){for(const token of sessions)await redis.del('session:'+token);for(const id of users)await redis.del([`account-proof:user:${id}`,`account-factor:${id}`]);await redis.del('account-proof:ip:'+tokenHash('127.0.0.1'));await redis.quit();}await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});

test('真实发送程序未配置时禁用入口，不能未登录或提交非规范目标',async()=>{
 const who=await identity();delete process.env.MESSAGE_SENDER_CONFIG;let state=await okay('/auth/verification',who);assert.equal(state.data.emailEnabled,false);assert.equal(state.data.smsEnabled,false);assert.equal((await http('/auth/verification/challenges',who,'POST',{channel:'email',destination:'target@example.test'})).status,503);await enable();
 assert.equal((await http('/auth/verification',null)).status,401);assert.equal((await http('/auth/verification/challenges',who,'POST',{channel:'sms',destination:'13800000000'})).status,400);assert.equal((await http('/auth/verification/challenges',who,'POST',{channel:'email',destination:'x\r\nBCC:test@example.test'})).status,400);
});

test('验证码只留摘要，正确密码+新地址证明才换邮箱，旧会话立即失效',async()=>{
 const who=await identity(),target='new-'+randomUUID()+'@example.test',issued=await challenge(who,'email',target),sent=await message(issued.id);assert.equal(sent.destination,target);assert.match(sent.code,/^\d{6}$/);assert.equal('code' in issued,false);
 const stored=(await pool.query('SELECT * FROM verification_challenges WHERE id=$1',[issued.id])).rows[0];assert.equal(stored.code_hash.length,64);assert.notEqual(stored.code_hash,sent.code);assert.ok(stored.sent_at);assert.equal(stored.consumed_at,null);
 assert.equal((await http('/auth/verification/confirm',who,'POST',{id:issued.id,code:sent.code,password:'incorrect-password'})).status,401);assert.equal((await pool.query('SELECT consumed_at FROM verification_challenges WHERE id=$1',[issued.id])).rows[0].consumed_at,null);
 const confirmed=await okay('/auth/verification/confirm',who,'POST',{id:issued.id,code:sent.code,password});assert.ok(confirmed.cookie);assert.equal((await http('/auth/profile',who)).status,401);who.cookie=confirmed.cookie;
 const profile=await okay('/auth/profile',who);assert.equal(profile.data.email,target);assert.equal(profile.data.emailVerified,true);assert.equal((await http('/auth/verification/confirm',who,'POST',{id:issued.id,code:sent.code,password})).status,400);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM audit WHERE target=$1 AND action=\'verification.confirmed\'',[issued.id])).rows[0].count,1);
});

test('五次错误不可回滚计数，过期或其它账户的挑战不能消费',async()=>{
 const who=await identity(),other=await identity(),issued=await challenge(who),sent=await message(issued.id),wrong=String((Number(sent.code)+1)%1000000).padStart(6,'0');
 assert.equal((await http('/auth/verification/confirm',other,'POST',{id:issued.id,code:sent.code,password})).status,400);
 for(let index=0;index<5;index++)assert.equal((await http('/auth/verification/confirm',who,'POST',{id:issued.id,code:wrong,password})).status,400);
 const stored=(await pool.query('SELECT attempts,consumed_at FROM verification_challenges WHERE id=$1',[issued.id])).rows[0];assert.equal(stored.attempts,5);assert.ok(stored.consumed_at);assert.equal((await http('/auth/verification/confirm',who,'POST',{id:issued.id,code:sent.code,password})).status,400);
 const expiredUser=await identity(),expired=await challenge(expiredUser),code=(await message(expired.id)).code;await pool.query("UPDATE verification_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal((await http('/auth/verification/confirm',expiredUser,'POST',{id:expired.id,code,password})).status,400);
});

test('已验证手机全局唯一，普通资料不能覆盖或通过格式变化绕过唯一约束',async()=>{
 const first=await identity(),second=await identity(),phone='+8613800000001';const issued=await challenge(first,'sms',phone),code=(await message(issued.id)).code;
 const confirmed=await okay('/auth/verification/confirm',first,'POST',{id:issued.id,code,password});first.cookie=confirmed.cookie;assert.equal((await okay('/auth/profile',first)).data.phoneVerified,true);
 assert.equal((await http('/auth/profile',first,'PUT',{name:'资料更新',phone:'+8613800000002'})).status,409);
 const same=await okay('/auth/profile',first,'PUT',{name:'资料更新',phone:'+86 13800000001'});assert.equal(same.data.phone,phone);assert.equal(same.data.phoneVerified,true);
 await pool.query("UPDATE verification_challenges SET created_at=now()-interval '61 seconds' WHERE id=$1",[issued.id]); // 只在隔离夹具推进发送冷却时间
 const duplicate=await challenge(second,'sms',phone),duplicateCode=(await message(duplicate.id)).code;assert.equal((await http('/auth/verification/confirm',second,'POST',{id:duplicate.id,code:duplicateCode,password})).status,400);
 assert.equal((await pool.query('SELECT count(*)::int AS count FROM users WHERE phone=$1 AND phone_verified_at IS NOT NULL',[phone])).rows[0].count,1);
});

test('开启MFA后仅验证码和密码仍不足，恢复码可完成一次确认',async()=>{
 const who=await identity(),setup=await okay('/auth/mfa/setup',who,'POST',{password}),enabled=await okay('/auth/mfa/confirm',who,'POST',{code:totp(setup.data.secret)});who.cookie=enabled.cookie;
 const issued=await challenge(who),code=(await message(issued.id)).code;const missing=await http('/auth/verification/confirm',who,'POST',{id:issued.id,code,password});assert.equal(missing.status,401);assert.match(missing.data.message,/双因素/);
 const confirmed=await okay('/auth/verification/confirm',who,'POST',{id:issued.id,code,password,recoveryCode:enabled.data.recoveryCodes[0]});assert.ok(confirmed.cookie);assert.equal((await pool.query('SELECT count(*)::int AS count FROM account_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL',[who.id])).rows[0].count,1);
});

test('同一正确验证码并发仅一次确认，发送冷却与失败程序状态可核对',async()=>{
 const who=await identity(),issued=await challenge(who),code=(await message(issued.id)).code;assert.equal((await http('/auth/verification/challenges',who,'POST',{channel:'email',destination:'another@example.test'})).status,429);
 const results=await Promise.all([http('/auth/verification/confirm',who,'POST',{id:issued.id,code,password}),http('/auth/verification/confirm',who,'POST',{id:issued.id,code,password})]);assert.equal(results.filter(row=>row.status===201).length,1);assert.equal(results.filter(row=>[400,401].includes(row.status)).length,1);
 const fail=await identity(),bad=join(directory,'refused.cjs');await writeFile(bad,"process.stdout.write(JSON.stringify({accepted:false}));",{mode:0o600});await writeFile(config,JSON.stringify({email:{executable:process.execPath,arguments:[bad]}}),{mode:0o600});assert.equal((await http('/auth/verification/challenges',fail,'POST',{channel:'email',destination:'not-sent@example.test'})).status,503);
 const failed=(await pool.query('SELECT sent_at,consumed_at FROM verification_challenges WHERE user_id=$1',[fail.id])).rows[0];assert.equal(failed.sent_at,null);assert.ok(failed.consumed_at);await enable();const verified=await verifyAudit(pool,process.env.AUDIT_KEY!);assert.ok(verified.count>0);
});
