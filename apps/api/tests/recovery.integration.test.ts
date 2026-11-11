/* 手机登录、验证注册与密码找回真实回归：随机PostgreSQL、生产Access/Nest HTTP、Redis会话和临时文件发送程序。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/recovery.integration.test.ts。
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
const database='yunzou_recovery_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);target.pathname='/'+database;
process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');process.env.TOTP_KEY=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'yunzou-recovery-')),config=join(directory,'senders.json'),outbox=join(directory,'outbox.jsonl'),script=join(directory,'sender.cjs');process.env.MESSAGE_SENDER_CONFIG=config;process.env.VERIFICATION_TEST_OUTBOX=outbox;
const {pool,redis}=await import('../src/features/store.js');
const {Access,tokenHash}=await import('../src/utils/access.js');
const {start}=await import('../src/features/session.js');
const Recovery=(await import('../src/features/recovery.js')).default,Verification=(await import('../src/features/verification.js')).default,Account=(await import('../src/features/account.js')).default,Security=(await import('../src/features/security.js')).default;
const {totp}=await import('../src/utils/otp.js');
const {verifyAudit}=await import('../../../scripts/verify-audit.js');
class TestApplication{}Module({controllers:[Recovery,Verification,Account,Security]})(TestApplication);
let app:INestApplication,url='',created=false;const sessions=new Set<string>(),users:string[]=[],apiKeys:string[]=[];const password='Verification-isolated-password-2026';
type Identity={id:string;cookie:string};
async function identity():Promise<Identity>{const row=(await pool.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) RETURNING id',[randomUUID()+'@example.test','验证回归',await hash(password)])).rows[0];users.push(row.id);let token='';await start(row.id,0,{cookie(_name:string,value:string){token=value;sessions.add(tokenHash(value));}} as unknown as Response);return {id:row.id,cookie:'yunzou_session='+token};}
async function http(path:string,who:Identity|null,method='GET',body?:unknown,authorization?:string){const response=await fetch(url+path,{method,headers:{...(who?{Cookie:who.cookie}:{}),Origin:process.env.PUBLIC_ORIGIN!,...(authorization?{Authorization:authorization}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await response.json();let cookie='';for(const header of response.headers.getSetCookie()){const match=/^yunzou_session=([^;]+)/.exec(header);if(match){cookie='yunzou_session='+match[1];sessions.add(tokenHash(decodeURIComponent(match[1])));}}return {status:response.status,data,cookie};}
async function okay(path:string,who:Identity,method='GET',body?:unknown){const result=await http(path,who,method,body);assert.ok(result.status>=200&&result.status<300,JSON.stringify(result.data));return result;}
async function message(id:string){return (await readFile(outbox,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.id===id);}
async function enable(){await writeFile(config,JSON.stringify({email:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX']},sms:{executable:process.execPath,arguments:[script],environment:['VERIFICATION_TEST_OUTBOX']}}),{mode:0o600});process.env.MESSAGE_SENDER_CONFIG=config;}
async function issue(purpose:string,channel:string,destination:string){await pool.query("UPDATE account_challenges SET created_at=now()-interval '61 seconds' WHERE destination=$1",[destination]);const response=await http('/auth/challenges',null,'POST',{purpose,channel,destination});assert.equal(response.status,201,JSON.stringify(response.data));return {issued:response.data,sent:await message(response.data.id)};}
async function phoneUser(phone:string){const challenge=await issue('register','sms',phone);const result=await http('/auth/verify-register',null,'POST',{id:challenge.issued.id,code:challenge.sent.code,name:'手机主账号',password});assert.equal(result.status,201,JSON.stringify(result.data));users.push(result.data.id);return {id:result.data.id,cookie:result.cookie,phone};}
before(async()=>{
 await writeFile(script,"const fs=require('node:fs');const message=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(process.env.VERIFICATION_TEST_OUTBOX,JSON.stringify(message)+'\\n',{mode:0o600});process.stdout.write(JSON.stringify({accepted:true}));",{mode:0o600});await enable();
 await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;const root=new URL('../../../database/migrations/',import.meta.url),files=await readdir(root),selected=new Map<string,string>();
 for(const file of files.filter(file=>(file.endsWith('.sql')||file.endsWith('.draft'))).sort()){const key=file.slice(0,3);if(!selected.has(key)||file.endsWith('.sql'))selected.set(key,file);}for(const file of [...selected.values()].sort())await pool.query(await readFile(new URL(file,root),'utf8'));
 await redis.connect();app=await NestFactory.create(TestApplication,{logger:false});app.setGlobalPrefix('api/v1');app.use(cookieParser());app.useGlobalGuards(new Access());await app.listen(0,'127.0.0.1');url=(await app.getUrl())+'/api/v1';
});
after(async()=>{if(app)await app.close();if(redis.isOpen){for(const token of sessions)await redis.del('session:'+token);for(const id of users)await redis.del([`account-proof:user:${id}`,`account-factor:${id}`]);await redis.del(['account-proof:ip:'+tokenHash('127.0.0.1'),'access-login:ip:'+tokenHash('127.0.0.1')]);for(const key of apiKeys)await redis.del('api-rate:'+key);for(const value of testedPhones)await redis.del('access-login:destination:'+tokenHash(value));await redis.quit();}await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});


const testedPhones=['+8613800000101','+8613800000102','+8613800000103','+8613800000104','+8613800000105'];

test('无发送配置时关闭验证码渠道，手机密码入口保留，公开请求不枚举账户',async()=>{
 delete process.env.MESSAGE_SENDER_CONFIG;const off=await http('/auth/access-options',null);assert.equal(off.data.emailEnabled,false);assert.equal(off.data.smsEnabled,false);assert.equal(off.data.phonePasswordEnabled,true);assert.equal((await http('/auth/challenges',null,'POST',{purpose:'login',channel:'sms',destination:testedPhones[0]})).status,503);await enable();
 const unknown=await issue('reset','email','unknown-'+randomUUID()+'@example.test');assert.deepEqual(Object.keys(unknown.issued).sort(),['expiresAt','id','retryAfterSeconds']);assert.equal('code' in unknown.issued,false);assert.match(unknown.sent.code,/^\d{6}$/);
 const result=await http('/auth/recover',null,'POST',{id:unknown.issued.id,code:unknown.sent.code,newPassword:password});assert.equal(result.status,400);assert.equal((await pool.query('SELECT count(*)::int AS count FROM users WHERE email=$1',[unknown.sent.destination])).rows[0].count,0);
});

test('公开挑战与登录后换绑共用目标发送冷却，不能交替入口重复发送',async()=>{
 const who=await identity(),destination='shared-'+randomUUID()+'@example.test';
 const issued=await issue('reset','email',destination);
 try{const duplicate=await http('/auth/verification/challenges',who,'POST',{channel:'email',destination});assert.equal(duplicate.status,429,JSON.stringify(duplicate.data));}
 finally{await pool.query("UPDATE account_challenges SET created_at=now()-interval '2 hours' WHERE id=$1",[issued.issued.id]);}
});

test('手机验证注册创建真实主账号且邮箱为NULL，密码与短信均能登录，验证码只消费一次',async()=>{
 const who=await phoneUser(testedPhones[0]),stored=(await pool.query('SELECT * FROM users WHERE id=$1',[who.id])).rows[0];assert.equal(stored.email,null);assert.equal(stored.phone,who.phone);assert.ok(stored.phone_verified_at);assert.match(stored.password,/^\$argon2id\$/);
 const me=await okay('/auth/me',who);assert.equal(me.data.email,null);assert.equal(me.data.phoneVerified,true);assert.equal(me.data.phone,who.phone);
 const passwordLogin=await http('/auth/phone-login',null,'POST',{phone:who.phone,password});assert.equal(passwordLogin.status,201,JSON.stringify(passwordLogin.data));assert.ok(passwordLogin.cookie);
 const proof=await issue('login','sms',who.phone),codeLogin=await http('/auth/verify-login',null,'POST',{id:proof.issued.id,code:proof.sent.code});assert.equal(codeLogin.status,201,JSON.stringify(codeLogin.data));assert.ok(codeLogin.cookie);assert.equal(codeLogin.data.id,who.id);assert.equal((await http('/auth/verify-login',null,'POST',{id:proof.issued.id,code:proof.sent.code})).status,400);
 const raw=(await pool.query('SELECT code_hash,consumed_at FROM account_challenges WHERE id=$1',[proof.issued.id])).rows[0];assert.equal(raw.code_hash.length,64);assert.notEqual(raw.code_hash,proof.sent.code);assert.ok(raw.consumed_at);
});

test('验证邮箱注册保留原普通注册协议，未验证资料手机号不能登录或重置',async()=>{
 const destination='verified-'+randomUUID()+'@example.test',proof=await issue('register','email',destination),created=await http('/auth/verify-register',null,'POST',{id:proof.issued.id,code:proof.sent.code,name:'验证邮箱注册',password});assert.equal(created.status,201,JSON.stringify(created.data));users.push(created.data.id);assert.equal(created.data.email,destination);assert.equal(created.data.emailVerified,true);
 const who=await identity();await pool.query('UPDATE users SET phone=$2 WHERE id=$1',[who.id,testedPhones[1]]);assert.equal((await http('/auth/phone-login',null,'POST',{phone:testedPhones[1],password})).status,401);
 const code=await issue('reset','sms',testedPhones[1]);assert.equal((await http('/auth/recover',null,'POST',{id:code.issued.id,code:code.sent.code,newPassword:'Recovered-password-2026'})).status,400);assert.equal((await pool.query('SELECT session_version FROM users WHERE id=$1',[who.id])).rows[0].session_version,0);
});

test('五次错误和过期挑战不可用，注册验证码不能冒充登录验证码',async()=>{
 const proof=await issue('register','sms',testedPhones[2]),wrong=String((Number(proof.sent.code)+1)%1000000).padStart(6,'0');assert.equal((await http('/auth/verify-login',null,'POST',{id:proof.issued.id,code:proof.sent.code})).status,400);
 for(let n=0;n<5;n++)assert.equal((await http('/auth/verify-register',null,'POST',{id:proof.issued.id,code:wrong,name:'错误验证码',password})).status,400);
 const saved=(await pool.query('SELECT attempts,consumed_at FROM account_challenges WHERE id=$1',[proof.issued.id])).rows[0];assert.equal(saved.attempts,5);assert.ok(saved.consumed_at);
 const expired=await issue('register','sms',testedPhones[3]);await pool.query("UPDATE account_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.issued.id]);assert.equal((await http('/auth/verify-register',null,'POST',{id:expired.issued.id,code:expired.sent.code,name:'过期验证码',password})).status,400);
});

test('手机登录和找回均保留本地MFA，重置后旧会话与API密钥版本失效',async()=>{
 const who=await phoneUser(testedPhones[4]),setup=await okay('/auth/mfa/setup',who,'POST',{password});assert.ok(setup.data.otpauthUrl.includes(encodeURIComponent(who.phone)));
 const enabled=await okay('/auth/mfa/confirm',who,'POST',{code:totp(setup.data.secret)});who.cookie=enabled.cookie;
 assert.equal((await http('/auth/phone-login',null,'POST',{phone:who.phone,password})).status,401);
 const login=await issue('login','sms',who.phone);assert.equal((await http('/auth/verify-login',null,'POST',{id:login.issued.id,code:login.sent.code})).status,401);const logged=await http('/auth/verify-login',null,'POST',{id:login.issued.id,code:login.sent.code,recoveryCode:enabled.data.recoveryCodes[0]});assert.equal(logged.status,201);who.cookie=logged.cookie;
 const token='yz_'+randomBytes(32).toString('base64url'),key=(await pool.query("INSERT INTO api_keys(user_id,name,token_hash,prefix,permissions,session_version,expires_at) SELECT id,'恢复前密钥',$2,'test',ARRAY['GET /api/v1/auth/me'],session_version,now()+interval '1 day' FROM users WHERE id=$1 RETURNING id",[who.id,tokenHash(token)])).rows[0];apiKeys.push(key.id);assert.equal((await http('/auth/me',null,'GET',undefined,'Bearer '+token)).status,200);
 const reset=await issue('reset','sms',who.phone);assert.equal((await http('/auth/recover',null,'POST',{id:reset.issued.id,code:reset.sent.code,newPassword:'Recovered-phone-password-2026'})).status,401);
 const confirmed=await http('/auth/recover',null,'POST',{id:reset.issued.id,code:reset.sent.code,newPassword:'Recovered-phone-password-2026',recoveryCode:enabled.data.recoveryCodes[1]});assert.equal(confirmed.status,201,JSON.stringify(confirmed.data));assert.equal(confirmed.cookie,'');assert.equal((await http('/auth/me',who)).status,401);assert.equal((await http('/auth/me',null,'GET',undefined,'Bearer '+token)).status,401);
 assert.equal((await pool.query('SELECT enabled FROM account_security WHERE user_id=$1',[who.id])).rows[0].enabled,true);assert.equal((await http('/auth/phone-login',null,'POST',{phone:who.phone,password:'Recovered-phone-password-2026'})).status,401);
 assert.equal((await http('/auth/phone-login',null,'POST',{phone:who.phone,password:'Recovered-phone-password-2026',recoveryCode:enabled.data.recoveryCodes[2]})).status,201);
});

test('未验证邮箱仅是登录名，正确邮件OTP也不能恢复该账户',async()=>{
 const who=await identity(),row=(await pool.query('SELECT email,password,session_version FROM users WHERE id=$1',[who.id])).rows[0],proof=await issue('reset','email',row.email);
 const result=await http('/auth/recover',null,'POST',{id:proof.issued.id,code:proof.sent.code,newPassword:'An-unverified-email-reset-2026'});assert.equal(result.status,400);
 const current=(await pool.query('SELECT password,session_version,email_verified_at FROM users WHERE id=$1',[who.id])).rows[0];assert.equal(current.password,row.password);assert.equal(current.session_version,row.session_version);assert.equal(current.email_verified_at,null);assert.equal((await http('/auth/login',null,'POST',{email:row.email,password})).status,201);
});

test('同一重置验证码并发只有一笔修改，旧密码不能继续使用，审计链完整',async()=>{
 const who=await identity();await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[who.id]);const email=(await pool.query('SELECT email FROM users WHERE id=$1',[who.id])).rows[0].email,proof=await issue('reset','email',email),body={id:proof.issued.id,code:proof.sent.code,newPassword:'Recovered-email-password-2026'};
 const results=await Promise.all([http('/auth/recover',null,'POST',body),http('/auth/recover',null,'POST',body)]);assert.equal(results.filter(row=>row.status===201).length,1);assert.equal(results.filter(row=>row.status===400).length,1);assert.equal((await pool.query('SELECT session_version FROM users WHERE id=$1',[who.id])).rows[0].session_version,1);
 assert.equal((await http('/auth/login',null,'POST',{email,password})).status,401);assert.equal((await http('/auth/login',null,'POST',{email,password:body.newPassword})).status,201);const audit=await verifyAudit(pool,process.env.AUDIT_KEY!);assert.ok(audit.count>0);
});
