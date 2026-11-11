/* 账号安全真实集成验证：随机临时PostgreSQL库+本地Redis，测试后仅清理本轮对象。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/security.integration.test.ts。
 * 测试使用临时TOTP_KEY和账号，生产入口没有测试验证码或跳过认证开关。
 */
import { UnauthorizedException } from '@nestjs/common';
import 'reflect-metadata';                                      // 与生产装饰器使用同一元数据
import test, { before, after } from 'node:test';                 // 管理测试数据库生命周期
import assert from 'node:assert/strict';                        // 检查真实会话版本、因子消费和审计
import { createHash, randomBytes, randomUUID } from 'node:crypto'; // 临时密钥和已知旧算法向量
import { readdir, readFile } from 'node:fs/promises';            // 运行实际迁移，不复制表结构
import { existsSync } from 'node:fs';                           // 可由环境直接注入测试连接
import pg from 'pg';                                           // 必须验证实际事务与CAS
import type { Response } from 'express';                       // 收集Cookie，不启动额外HTTP服务
import type { SessionRequest } from '../src/utils/access.js';   // 每个场景明确提供已认证账号

if (existsSync(new URL('../../../.env',import.meta.url))) process.loadEnvFile(new URL('../../../.env',import.meta.url)); // 固定到项目环境文件
const source=process.env.SECURITY_TEST_DATABASE_URL ?? process.env.DATABASE_URL; // 可以单独指定测试集群
if (!source || !['127.0.0.1','localhost','[::1]'].includes(new URL(source).hostname)) throw new Error('账号安全集成测试只允许本机PostgreSQL'); // 不操作远程生产数据库
const database=`yunzou_security_${randomUUID().replaceAll('-','')}`; // SQL标识只含随机十六进制
const admin=new pg.Client({connectionString:source});           // 只负责隔离建库和删库
const target=new URL(source); target.pathname=`/${database}`;  // 主体连接仅指向临时库
process.env.DATABASE_URL=target.href;                           // 在加载业务模块前确定连接
process.env.AUDIT_KEY=randomBytes(32).toString('hex');          // 不使用生产审计密钥
process.env.TOTP_KEY=randomBytes(32).toString('hex');           // 外置加密密钥只存在于本测试进程
const {pool,redis,transaction}=await import('../src/features/store.js'); // 使用真实数据主体
const Account=(await import('../src/features/account.js')).default; // 注册、登录、改密都使用生产代码
const {default:Security,checkFactor}=await import('../src/features/security.js'); // 第二因素消费与生命周期
const {Access,tokenHash}=await import('../src/utils/access.js'); // 验证实际会话版本边界
const {start}=await import('../src/features/session.js');       // 验证并发凭据更新后的固定版本签发
const {totp}=await import('../src/utils/otp.js');                // 用标准算法生成临时账号实际口令
const account=new Account(); const security=new Security();   // 只替代HTTP收发，不替代验证逻辑
const password='security-current-password-2026';               // 本轮临时账号口令
const createdUsers:{id:string,email:string,ip:string}[]=[];     // Redis清理仅限本轮自己的键
let created=false;                                             // 不删除未由本轮创建的数据库

before(async()=>{
  await admin.connect();                                       // 连接本机隔离测试集群
  await admin.query(`CREATE DATABASE "${database}"`);           // 不改变开发业务库
  created=true;                                                // 后续清理只认这个随机库
  for (const file of (await readdir(new URL('../../../database/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()) {
    const connection=await pool.connect();                     // 同一个迁移始终在同一事务
    try { await connection.query('BEGIN'); await connection.query(await readFile(new URL(`../../../database/migrations/${file}`,import.meta.url),'utf8')); await connection.query('COMMIT'); } finally { connection.release(); } // 运行包括导入与钱包在内的完整迁移
  }
  await redis.connect();                                       // 限流和会话使用真实Redis
});

after(async()=>{
  if (redis.isOpen) {
    for (const user of createdUsers) await redis.del([`login:${tokenHash(user.ip)}`,`login:${tokenHash(user.email)}`,`account-proof:user:${user.id}`,`account-proof:ip:${tokenHash(user.ip)}`,`account-factor:${user.id}`,`refund-password:${user.id}:${tokenHash(user.ip)}`]); // 不清空共享Redis
    for (const key of sessions) await redis.del(`session:${key}`); // 清理本轮签发的短期会话
    await redis.quit();                                         // 只关闭当前测试客户端
  }
  await pool.end();                                             // 删库前关闭业务连接
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); // 只删除本轮临时数据库
  await admin.end();                                            // 归还建库连接
});

const sessions:string[]=[];                                    // 不把明文令牌写入输出
function response() {
  const capture:{token?:string,secure?:boolean,cleared:boolean}={cleared:false}; // 只保留当前测试需要的Cookie信息
  const http={cookie(_name:string,token:string,options:{secure:boolean}){capture.token=token;capture.secure=options.secure;sessions.push(tokenHash(token));},clearCookie(){capture.cleared=true;}} as unknown as Response; // 实际Cookie格式仍由生产Session构造
  return {http,capture};                                        // 不创建测试专用生产接口
}

async function fixture() {
  const address=`${randomUUID()}@example.test`;                  // 不与真实邮箱或其它测试共享限额
  const ip=`security-test:${randomUUID()}`;                      // 只用于当前测试的独立限流来源
  const reply=response();                                      // 捕获生产签发结果
  const input={email:address,password,name:'账号安全测试'};      // 正常注册输入
  const user=await account.register(input,{ip} as SessionRequest,reply.http); // 创建真实Argon2账号
  createdUsers.push({id:user.id,email:address,ip});               // 记录之后需要清理的键
  const request={user,ip,cookies:{yunzou_session:reply.capture.token},requestId:randomUUID(),headers:{origin:process.env.PUBLIC_ORIGIN},method:'GET',path:'/api/v1/auth/me'} as unknown as SessionRequest; // Access仍使用真实Cookie摘要
  return {user,request,token:reply.capture.token!,reply};         // 当前会话版本为0
}

async function enabled() {
  const data=await fixture();                                   // 注册正常账号
  const setup=await security.setup({password},data.request);    // 真实加密后只显示一次密钥
  const reply=response();                                      // 开启后签出新版本会话
  const confirmed=await security.confirm({code:totp(setup.secret)},data.request,reply.http); // 消费当前周期口令并发恢复码
  data.request.cookies.yunzou_session=reply.capture.token;       // 接下来使用开启MFA后的新Cookie
  return {...data,secret:setup.secret,codes:confirmed.recoveryCodes,newToken:reply.capture.token!}; // 明文仅保留在本测试进程
}

async function allowed(token:string) {
  const request={cookies:{yunzou_session:token},method:'GET',path:'/api/v1/auth/me',headers:{}} as SessionRequest; // 访问自己的只读资料
  const context={getHandler:()=>Account.prototype.me,getClass:()=>Account,switchToHttp:()=>({getRequest:()=>request})}; // 复用真实Access逻辑
  return new Access().canActivate(context as any);               // 不在测试中跳过会话版本判断
}

test('资料保存兼容仅姓名旧请求，拒绝角色与邮箱改写',async()=>{
  const data=await fixture();                                   // 普通客户账号
  const saved=await account.profile({name:'新名字',phone:'+86 13800000000',phoneCode:'86',company:'狐岚云测试',country:'cn',address:'测试地址',language:'zh-cn',timezone:'Asia/Shanghai'},data.request); // 保存完整资料
  assert.equal(saved.country,'CN');                             // 国家代码规范化
  assert.equal(saved.phoneVerified,false);                      // 没有短信服务就不伪造已验证状态
  const old=await account.profile({name:'只改名字'},data.request); // 兼容原接口只提交姓名
  assert.equal(old.phone,'+86 13800000000');                      // 不把未提交的资料重置成空
  await assert.rejects(account.profile({name:'无效',role:'admin'},data.request)); // 普通客户不能改变角色
  await assert.rejects(account.profile({name:'无效',email:'other@example.test'},data.request)); // 不提供未经验证的邮箱更换
  await assert.rejects(account.profile({name:'无效',timezone:'Imaginary/Timezone'},data.request)); // 时区在边界验证
});

test('TOTP密钥只以绑定账号的密文保存，开启后旧会话立即失效',async()=>{
  const data=await enabled();                                   // 使用真实setup与confirm
  const saved=(await pool.query('SELECT * FROM account_security WHERE user_id=$1',[data.user.id])).rows[0]; // 直接查看实际数据库内容
  assert.ok(saved.secret_ciphertext.startsWith('v1.'));         // 存储的是版本化AES-GCM密文
  assert.ok(!saved.secret_ciphertext.includes(data.secret));    // 没有明文共享密钥
  assert.equal(saved.pending_ciphertext,null);                  // 待确认密文已清除
  assert.equal(data.codes.length,10);                           // 生成十个强随机恢复码
  assert.equal(new Set(data.codes).size,10);                     // 本轮码互不重复
  const hashes=(await pool.query('SELECT hash FROM account_recovery_codes WHERE user_id=$1',[data.user.id])).rows; // 数据库只保留摘要
  assert.ok(hashes.every(row=>/^[0-9a-f]{64}$/.test(row.hash))); // 没有可逆恢复码
  await assert.rejects(allowed(data.token),error=>error instanceof UnauthorizedException&&error.getStatus()===401);    // 开启MFA前的Cookie不再有效
  assert.equal(await allowed(data.newToken),true);               // 当前浏览器的新版本仍可使用
  const status=await security.status(data.request);             // 普通状态查询
  assert.equal(status.enabled,true);                            // 展示真实启用状态
  assert.ok(!('secret' in status) && !('recoveryCodes' in status)); // GET不能重新取回明文
});

test('待确认密钥只返回一次，过期设置不能确认，缺TOTP_KEY明确拒绝',async()=>{
  const data=await fixture();                                   // 尚未启用MFA
  const key=process.env.TOTP_KEY; delete process.env.TOTP_KEY;   // 只在当前测试进程移除密钥
  try { await assert.rejects(security.setup({password},data.request),/TOTP_KEY/); } finally { process.env.TOTP_KEY=key; } // 不生成无法保管的共享密钥
  const setup=await security.setup({password},data.request);    // 正常创建待确认密文
  await assert.rejects(security.setup({password},data.request),/已有待确认设置/); // 不能重复读取同一密钥
  await pool.query("UPDATE account_security SET pending_until=now()-interval '1 second' WHERE user_id=$1",[data.user.id]); // 在隔离库设置真实过期状态
  await assert.rejects(security.confirm({code:totp(setup.secret)},data.request,response().http),/已过期/); // 过期密钥不能启用
  await security.cancel({password},data.request);                // 当前密码可取消未启用设置
  assert.equal((await security.status(data.request)).setupPending,false); // 下一次需重新setup
});

test('密码正确仍需第二因素，同一TOTP的并发登录只有一次成功',async()=>{
  const data=await enabled();                                   // confirm已消费当前周期
  await assert.rejects(account.login({email:data.user.email,password},data.request,response().http),/双因素认证/); // 密码单独不能签发会话
  const code=totp(data.secret,Date.now()/1000+30);                // 相邻未来周期在标准容忍范围内，且未被confirm消费
  const results=await Promise.allSettled([account.login({email:data.user.email,password,totp:code},data.request,response().http),account.login({email:data.user.email,password,totp:code},data.request,response().http)]); // 触发真实账号锁与计数器CAS竞争
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); // 一次性口令确实只消费一次
  const key=process.env.TOTP_KEY; delete process.env.TOTP_KEY;   // 模拟部署丢失外置解密密钥
  try { await assert.rejects(account.login({email:data.user.email,password,recoveryCode:data.codes[0]},data.request,response().http),/TOTP_KEY/); } finally { process.env.TOTP_KEY=key; } // 不能因为密钥丢失而降级为仅密码
});

test('恢复码并发只消费一次，关闭MFA必须当前密码和第二因素',async()=>{
  const data=await enabled();                                   // 获得一次显示的恢复码
  const proof={email:data.user.email,password,recoveryCode:data.codes[0]}; // 同一个恢复码同时提交
  const results=await Promise.allSettled([account.login(proof,data.request,response().http),account.login(proof,data.request,response().http)]); // 真实数据库CAS防止重复使用
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); // 只承认一次使用
  await assert.rejects(security.disable({password},data.request,response().http),/双因素认证/); // 知道密码不能直接移除MFA
  await assert.rejects(security.disable({password:'wrong-password',recoveryCode:data.codes[1]},data.request,response().http),/当前密码不正确/); // 恢复码不能单独重置账号
  const disabled=await security.disable({password,recoveryCode:data.codes[1]},data.request,response().http); // 两因素共同通过
  assert.equal(disabled.enabled,false);                         // 明确关闭后可以使用普通登录
  assert.equal((await security.status(data.request)).recoveryCodesRemaining,0); // 旧恢复码全部作废
});

test('恢复码重置撤销旧码，密码变更撤销旧会话且旧口令不能继续登录',async()=>{
  const data=await enabled();                                   // 先开启MFA
  const rotated=await security.recovery({password,recoveryCode:data.codes[0]},data.request,response().http); // 用一次旧恢复码授权重置
  await assert.rejects(account.login({email:data.user.email,password,recoveryCode:data.codes[1]},data.request,response().http),/已使用/); // 未使用旧码也已撤销
  const reply=response();                                      // 改密后签发新会话
  await account.password({currentPassword:password,newPassword:'a-new-strong-password',recoveryCode:rotated.recoveryCodes[0]},data.request,reply.http); // 当前密码与有效新恢复码共同授权
  await assert.rejects(allowed(data.newToken),error=>error instanceof UnauthorizedException&&error.getStatus()===401);  // MFA开启后的旧版本同样失效
  assert.equal(await allowed(reply.capture.token!),true);        // 新口令事务确定的新版本可访问
  await assert.rejects(account.login({email:data.user.email,password,recoveryCode:rotated.recoveryCodes[1]},data.request,response().http),/邮箱或密码/); // 原口令不可再用
  await account.login({email:data.user.email,password:'a-new-strong-password',recoveryCode:rotated.recoveryCodes[1]},data.request,response().http); // 新口令仍需有效第二因素
});

test('旧###摘要仅在授权码正确时登录并升级，短旧口令不会喂入Argon2',async()=>{
  const data=await fixture();                                   // 先创建具有正常资料的账号
  const oldPassword='old6';                                    // 旧系统允许短于新注册要求的口令
  const sourceKey='1234ABCD5678EF90';                           // 与导入工具一致的16位大写十六进制来源键
  const authcode='temporary-import-authcode';                   // 只用于本隔离测试
  const inner=createHash('md5').update(authcode+oldPassword).digest('hex'); // 原系统真实第一层算法
  const legacy='###'+createHash('md5').update(inner).digest('hex'); // 原系统第二层算法
  await pool.query('UPDATE users SET legacy_password=$2,legacy_authcode_id=$3 WHERE id=$1',[data.user.id,legacy,sourceKey]); // 导入实际使用的字段
  const previous=process.env[`LEGACY_AUTHCODE_${sourceKey}`];    // 避免测试覆盖外部环境配置
  const fallback=process.env.LEGACY_AUTHCODE; delete process.env.LEGACY_AUTHCODE; // 本场景不允许全局授权码回退
  delete process.env[`LEGACY_AUTHCODE_${sourceKey}`];            // 缺失配置必须统一拒绝
  try {
    await assert.rejects(account.login({email:data.user.email,password:oldPassword},data.request,response().http),/邮箱或密码/); // 没有错误Argon2格式异常
    process.env[`LEGACY_AUTHCODE_${sourceKey}`]=authcode;        // 配置正确的来源授权码
    await account.login({email:data.user.email,password:oldPassword},data.request,response().http); // 正确旧口令升级一次
    const saved=(await pool.query('SELECT password,legacy_password,legacy_authcode_id,session_version FROM users WHERE id=$1',[data.user.id])).rows[0]; // 直接检查持久化结果
    assert.ok(saved.password.startsWith('$argon2id$'));          // 不再依赖MD5验证未来登录
    assert.equal(saved.legacy_password,null);                    // 清除弱旧摘要
    assert.equal(saved.legacy_authcode_id,null);                 // 清除旧来源授权码依赖
    assert.equal(saved.session_version,1);                      // 升级同时撤销旧版本会话
    delete process.env[`LEGACY_AUTHCODE_${sourceKey}`];          // 以后即使授权码移除也可用Argon2登录
    await account.login({email:data.user.email,password:oldPassword},data.request,response().http); // 保留用户原口令可用性
  } finally {
    if (previous===undefined) delete process.env[`LEGACY_AUTHCODE_${sourceKey}`]; else process.env[`LEGACY_AUTHCODE_${sourceKey}`]=previous; // 恢复本进程原配置
    if (fallback===undefined) delete process.env.LEGACY_AUTHCODE; else process.env.LEGACY_AUTHCODE=fallback; // 不改变其它来源行为
  }
});

test('复制TOTP密文到另一账号无法通过认证，事务回滚不消费恢复码',async()=>{
  const first=await enabled();                                 // 原账号及其绑定密文
  const second=await enabled();                                // 第二个独立账号
  const cipher=(await pool.query('SELECT secret_ciphertext FROM account_security WHERE user_id=$1',[first.user.id])).rows[0].secret_ciphertext; // 获取加密数据库内容，无法解密
  await pool.query('UPDATE account_security SET secret_ciphertext=$2 WHERE user_id=$1',[second.user.id,cipher]); // 模拟仅有数据库写权限的跨行替换
  await assert.rejects(transaction(connection=>checkFactor(connection,second.user.id,{totp:totp(first.secret,Date.now()/1000+30)},'test.copy')),/无法验证/); // AES-GCM AAD绑定账号，不能跨账号复制
  await assert.rejects(transaction(async connection=>{await checkFactor(connection,first.user.id,{recoveryCode:first.codes[0]},'test.rollback');throw new Error('测试后续业务回滚');}),/后续业务回滚/); // 因素消费和后续安全动作同事务
  await transaction(connection=>checkFactor(connection,first.user.id,{recoveryCode:first.codes[0]},'test.after.rollback')); // 回滚后该恢复码仍可正确消费一次
});

test('会话撤销及签发固定版本，不能用旧认证结果获得并发改密后的版本',async()=>{
  const data=await fixture();                                   // 未启用MFA的普通账号
  const reply=response();                                      // 注销其它会话时保留当前新会话
  await account.sessions({password},data.request,reply.http);   // 同事务增加版本并审计
  await assert.rejects(allowed(data.token),error=>error instanceof UnauthorizedException&&error.getStatus()===401);    // 老令牌立即失效
  assert.equal(await allowed(reply.capture.token!),true);        // 当前新会话可用
  await assert.rejects(start(data.user.id,0,response().http),/凭据已变化/); // 旧认证时点不能自动读取新版本签发
  const exit=response();                                       // 注销全部设备的响应
  await account.logoutAll({password},data.request,exit.http);   // 再次增加版本并清Cookie
  assert.equal(exit.capture.cleared,true);                       // 这次明确不签新Cookie
  await assert.rejects(allowed(reply.capture.token!),error=>error instanceof UnauthorizedException&&error.getStatus()===401); // 刚才的新会话也已被全部撤销
});
