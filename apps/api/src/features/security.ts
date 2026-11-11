/* 双因素认证：密钥用外置TOTP_KEY加密，口令计数器和恢复码在事务内一次性消费。
 * 开启：POST /api/v1/auth/mfa/setup {password} 返回一次secret和otpauthUrl，再POST /auth/mfa/confirm {code:'123456'}。
 * 关闭/重置恢复码：POST /auth/mfa/disable 或 /auth/mfa/recovery {password,totp}，也可使用recoveryCode。
 * TOTP_KEY为独立随机32字节的64位hex，缺失时禁止新设置；已有MFA账号不能降级绕过。
 */
import { Body, Controller, Get, Post, Req, Res, ConflictException, ServiceUnavailableException, UnauthorizedException, HttpException, BadRequestException, ForbiddenException } from '@nestjs/common'; // 安全输入问题反馈到统一入口
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'; // 标准AES-GCM与密码学随机数
import { verify } from 'argon2';                                 // 当前密码只核对不可逆摘要
import { z } from 'zod';                                        // MFA与密码一起在外部边界整理
import type { Response } from 'express';                        // 成功变更安全设置后签发新会话
import type { PoolClient } from 'pg';                            // 防重放与审计必须处于同一事务
import { pool, redis, transaction } from './store.js';           // 账号安全事实持久化到PostgreSQL
import { record } from './audit.js';                             // 不把明文密钥或恢复码写入审计
import { start } from './session.js';                            // 使用变更后的固定会话版本
import { read } from '../utils/input.js';                        // 只在系统边界校验输入
import { tokenHash, type SessionRequest } from '../utils/access.js'; // 账号来自统一认证边界
import { base32, counter } from '../utils/otp.js';                // RFC口令算法与恒定时间比较

export const factorFields = {totp:z.string().trim().regex(/^\d{6}$/,'验证码需要6位数字').optional(),recoveryCode:z.string().trim().min(1).max(64).optional()}; // 登录、改密和退款共用一份证明格式
export type FactorProof = {totp?:string;recoveryCode?:string};     // 只允许选择一种第二因素

/** @param request 当前主账号请求。@param proof 当前密码与第二因素。@param scope 审计用途。@param role 可选的当前角色要求。 */
export async function verifyIdentity(request:SessionRequest,proof:FactorProof & {password:string},scope:string,role?:string) {
  if(request.apiKeyId || request.user.delegated || (request.actorId && request.actorId!==request.user.id))throw new ForbiddenException('此操作需要使用主账号确认'); // 委托权限不能替代本人签署与资金证明
  const limits=await proofLimit(request);
  await transaction(async connection=>{
    const current=await checkPassword(connection,request.user.id,proof.password);
    if(role && current.role!==role)throw new ForbiddenException('当前账号没有此操作权限');
    await checkFactor(connection,request.user.id,proof,scope);
  }); // 身份验证先提交，后续业务保持主体锁→审计锁顺序
  await proofComplete(limits);
}

/** @param request 已认证请求。@returns 本次限流键，成功提交后可清除连续失败计数。 */
export async function proofLimit(request:SessionRequest) {
  const keys=[`account-proof:user:${request.user.id}`,`account-proof:ip:${tokenHash(request.ip ?? '')}`]; // 同时限制账号和来源
  for (const key of keys) {
    const count=await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",{keys:[key],arguments:[]}); // 计数与失效原子执行
    if (Number(count)>10) throw new HttpException('安全验证尝试过于频繁，请10分钟后重试',429); // 失败校验不能重置计数
  }
  return keys;                                                 // 只有完整验证成功后调用方才删除
}

/** @param keys 本次proofLimit返回的键。 */
export async function proofComplete(keys:string[]) {
  await redis.del(keys);                                       // 当前密码与第二因素都成功后才重置失败计数
  const user=keys.find(key=>key.startsWith('account-proof:user:'))?.slice('account-proof:user:'.length); // 同一轮验证还可清除该账号的因素失败预算
  if (user) await factorComplete(user);                         // 必须在调用方事务提交后才清除
}

/** @param id 已完整通过第二因素并提交事务的账号。 */
export async function factorComplete(id:string) {
  await redis.del(`account-factor:${id}`);                       // 只重置成功校验的因素预算，不在密码正确时提前重置
}

/** @param connection 账号事务。@param id 账号ID。@param password 当前明文密码。@returns 已加锁账号。 */
export async function checkPassword(connection:PoolClient,id:string,password:string) {
  const found=await connection.query('SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',[id]); // 所有MFA流程先锁账号，再锁安全记录
  if (!found.rowCount || !found.rows[0].password.startsWith('$argon2') || !await verify(found.rows[0].password,password)) throw new UnauthorizedException('当前密码不正确'); // 明文和摘要都不进入日志
  return found.rows[0];                                        // 登录完成旧摘要升级后才会有可用会话
}

/** @param connection 账号事务。@param id 账号ID。@param proof 当次TOTP或一次性恢复码。@param scope 此次验证的实际动作。 */
export async function checkFactor(connection:PoolClient,id:string,proof:FactorProof,scope:string) {
  await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[id]); // 与改密、启停MFA保持同一锁顺序
  const found=await connection.query('SELECT * FROM account_security WHERE user_id=$1 FOR UPDATE',[id]); // 串行消费同一账号的第二因素
  if (!found.rowCount || !found.rows[0].enabled) return;          // 未开启MFA的账号保持现有登录方式
  encryptionKey();                                             // 已启用MFA时缺外置密钥必须失败关闭，不能降级
  if (proof.totp && proof.recoveryCode) throw new BadRequestException('验证码和恢复码请选择一种'); // 避免不明确的身份意图
  await factorLimit(id);                                       // 不同安全接口共用TOTP猜测限额
  if (proof.recoveryCode) {
    const normalized=proof.recoveryCode.toLowerCase().replaceAll('-',''); // 允许按显示分组输入
    if (!/^[0-9a-f]{32}$/.test(normalized)) throw new UnauthorizedException('恢复码不正确或已使用'); // 格式错误也计入失败限额
    const digest=recoveryHash(id,normalized);                    // 恢复码只与当前账号匹配
    const available=await connection.query('SELECT id,hash FROM account_recovery_codes WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[id]); // 最多十个当前恢复码
    let matched:string|undefined;                               // 所有可用摘要都进行恒定时间比较
    for (const candidate of available.rows) if (timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(candidate.hash,'hex'))) matched=candidate.id; // 不提前返回暴露匹配位置
    if (!matched) throw new UnauthorizedException('恢复码不正确或已使用'); // 重放已使用的恢复码明确拒绝
    const used=await connection.query('UPDATE account_recovery_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id',[matched]); // 数据库CAS再防并发重复消费
    if (!used.rowCount) throw new UnauthorizedException('恢复码不正确或已使用'); // 只承认一次真实消费
    await record(connection,id,'account.recovery.use',id,{scope,codeId:matched}); // 只记录内部码ID，不记录明文或摘要
    return;                                                     // 审计与实际动作由调用方共同提交
  }
  if (!proof.totp) throw new UnauthorizedException('此账号已启用双因素认证，请输入验证码或恢复码'); // 密码正确也不能跳过第二因素
  const moving=counter(unseal(found.rows[0].secret_ciphertext,id,'active'),proof.totp,BigInt(found.rows[0].last_counter)); // 只接受比已消费计数器更新的窗口
  if (moving===null) throw new UnauthorizedException('验证码不正确或已使用，请等待新的验证码'); // 不重复接受同一个30秒周期
  const used=await connection.query('UPDATE account_security SET last_counter=$2,updated_at=now() WHERE user_id=$1 AND last_counter<$2 RETURNING user_id',[id,moving.toString()]); // 单调CAS防止同一口令并发重放
  if (!used.rowCount) throw new UnauthorizedException('此验证码已使用，请等待新的验证码'); // 不将竞争失败视作登录成功
  await record(connection,id,'account.factor.verify',id,{scope,counter:moving.toString()}); // 只记录消费事实，不保存口令
}

async function factorLimit(id:string) {
  const count=await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",{keys:[`account-factor:${id}`],arguments:[]}); // 登录、退款和安全设置共用失败预算
  if (Number(count)>10) throw new HttpException('双因素验证尝试过于频繁，请10分钟后重试',429); // 不因密码正确而重置错误口令计数
}

function encryptionKey() {
  if (!/^[0-9a-f]{64}$/i.test(process.env.TOTP_KEY ?? '')) throw new ServiceUnavailableException('尚未配置有效TOTP_KEY，请管理员配置独立的32字节随机密钥'); // 不使用默认密钥或审计密钥代替
  return Buffer.from(process.env.TOTP_KEY!,'hex');               // AES-256需要正好32字节
}

function seal(secret:string,id:string,purpose:'active'|'pending') {
  const nonce=randomBytes(12);                                  // GCM每次使用独立96位随机数
  const cipher=createCipheriv('aes-256-gcm',encryptionKey(),nonce); // 密钥只从进程环境读取
  cipher.setAAD(Buffer.from(`yunzou:totp:v1:${id}:${purpose}`));  // 密文绑定账号和用途，不能跨行替换
  const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]); // 只保存密文
  return ['v1',nonce.toString('base64url'),encrypted.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.'); // 版本、随机数与认证标签一起保管
}

function unseal(value:string,id:string,purpose:'active'|'pending') {
  const key=encryptionKey();                                    // 配置缺失先明确失败
  try {
    const [version,nonce,encrypted,tag]=value.split('.');         // 读取本项目固定的密文格式
    if (version!=='v1' || !nonce || !encrypted || !tag) throw new Error('密文格式无效'); // 损坏的数据不能继续认证
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'base64url')); // 使用外置解密密钥
    decipher.setAAD(Buffer.from(`yunzou:totp:v1:${id}:${purpose}`)); // 复核账号与用途绑定
    decipher.setAuthTag(Buffer.from(tag,'base64url'));           // 必须通过GCM完整性认证
    return Buffer.concat([decipher.update(Buffer.from(encrypted,'base64url')),decipher.final()]).toString('utf8'); // 完整性失败不会输出半段明文
  } catch { throw new ServiceUnavailableException('双因素密钥无法验证，请联系管理员核对外置密钥与备份'); } // 不把密钥或密码学内部错误暴露出去
}

function recoveryHash(id:string,code:string) {
  return createHash('sha256').update(`${id}:${code}`).digest('hex'); // 128位随机恢复码无需保存可逆内容
}

async function replaceRecovery(connection:PoolClient,id:string) {
  await connection.query('UPDATE account_recovery_codes SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[id]); // 保留已消费历史，作废旧的未用码
  const codes=Array.from({length:10},()=>randomBytes(16).toString('hex')); // 每个码有128位随机强度
  await connection.query('INSERT INTO account_recovery_codes(user_id,hash) SELECT $1,unnest($2::text[])',[id,codes.map(code=>recoveryHash(id,code))]); // 数据库只写摘要
  return codes.map(code=>code.match(/.{4}/g)!.join('-'));        // 分组后交给用户保存，仅此一次
}

@Controller('auth')
export default class Security {
  /** @returns MFA启用状态、待确认状态和剩余恢复码数量，不返回任何密钥。 */
  @Get('security') async status(@Req() request:SessionRequest) {
    const found=await pool.query('SELECT enabled,(pending_until>now()) AS pending,(SELECT count(*)::int FROM account_recovery_codes WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL) AS remaining FROM account_security WHERE user_id=$1',[request.user.id]); // 所有安全状态来自本账号
    return {enabled:found.rows[0]?.enabled ?? false,setupPending:found.rows[0]?.pending ?? false,recoveryCodesRemaining:found.rows[0]?.remaining ?? 0,totpAvailable:/^[0-9a-f]{64}$/i.test(process.env.TOTP_KEY ?? '')}; // 没配置外置密钥时界面可明确说明
  }

  /** @param body 当前密码。@returns 仅本次返回的新密钥与认证器导入地址。 */
  @Post('mfa/setup') async setup(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({password:z.string().min(1).max(128)}).strict(),body); // 开启前必须重新确认当前密码
    const limits=await proofLimit(request);                      // 失败密码不清除计数
    encryptionKey();                                             // 未配置时503，不生成无法保管的密钥
    const result=await transaction(async connection=>{
      const user=await checkPassword(connection,request.user.id,input.password); // 先锁账号再读取MFA状态
      const current=await connection.query('SELECT * FROM account_security WHERE user_id=$1 FOR UPDATE',[user.id]); // 密钥设置只允许一份有效待确认记录
      if (current.rows[0]?.enabled) throw new ConflictException('双因素认证已开启，重置前需先验证并关闭'); // 密码不能直接替换已启用的第二因素
      if (current.rows[0]?.pending_until && new Date(current.rows[0].pending_until)>new Date()) throw new ConflictException('已有待确认设置，请使用已显示的密钥确认，或取消后重新开始'); // 不重复泄露待确认密钥
      const secret=base32(randomBytes(20));                      // RFC建议至少160位共享密钥
      const saved=await connection.query('INSERT INTO account_security(user_id,pending_ciphertext,pending_until) VALUES($1,$2,now()+interval \'10 minutes\') ON CONFLICT(user_id) DO UPDATE SET pending_ciphertext=EXCLUDED.pending_ciphertext,pending_until=EXCLUDED.pending_until,updated_at=now() RETURNING pending_until',[user.id,seal(secret,user.id,'pending')]); // 数据库只保存认证加密后的密文
      const uri=new URL(`otpauth://totp/${encodeURIComponent(`狐岚云:${user.email || user.phone || user.id}`)}`); // 无需向第三方发送账号或密钥
      uri.search=new URLSearchParams({secret,issuer:'狐岚云',algorithm:'SHA1',digits:'6',period:'30'}).toString(); // 与服务端固定参数一致
      await record(connection,user.id,'account.mfa.setup',user.id,{}); // 审计不含密钥与URI
      return {secret,otpauthUrl:uri.href,expiresAt:saved.rows[0].pending_until}; // 密钥只从这一次响应离开服务端
    });
    await proofComplete(limits);                                 // 只有完整验证并提交才重置密码失败计数
    return result;                                               // GET状态永远不能重新读取secret
  }

  /** @param body 新认证器生成的6位验证码。@returns 一次显示的恢复码并更新当前会话。 */
  @Post('mfa/confirm') async confirm(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(z.object({code:z.string().trim().regex(/^\d{6}$/)}).strict(),body); // 明确校验口令位数
    const limits=await proofLimit(request);                      // 未确认密钥也限制口令猜测
    const result=await transaction(async connection=>{
      await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[request.user.id]); // 与登录和改密统一锁顺序
      const found=await connection.query('SELECT * FROM account_security WHERE user_id=$1 FOR UPDATE',[request.user.id]); // 确认后旧待设置记录不能再用
      const pending=found.rows[0];                               // 只读取本账号的密文
      if (!pending || pending.enabled || !pending.pending_until || new Date(pending.pending_until)<=new Date()) throw new ConflictException('待确认设置不存在或已过期，请重新开始'); // 不使用过期密钥启用MFA
      await factorLimit(request.user.id);                        // 多个入口共用第二因素猜测预算
      const secret=unseal(pending.pending_ciphertext,request.user.id,'pending'); // 完整性通过后才验证认证器
      const moving=counter(secret,input.code,-1n);               // 容忍前后一个30秒周期
      if (moving===null) throw new UnauthorizedException('验证码不正确，请核对认证器与设备时间'); // 错误校验保留限流计数
      await connection.query('UPDATE account_security SET enabled=true,secret_ciphertext=$2,pending_ciphertext=NULL,pending_until=NULL,last_counter=$3,enabled_at=now(),updated_at=now() WHERE user_id=$1',[request.user.id,seal(secret,request.user.id,'active'),moving.toString()]); // 启用时就消费本次口令，防止立刻重放登录
      const recoveryCodes=await replaceRecovery(connection,request.user.id); // 只保存恢复码摘要
      const user=await connection.query('UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version',[request.user.id]); // 开启MFA立即撤销全部旧会话
      await record(connection,request.user.id,'account.mfa.enable',request.user.id,{recoveryCodeCount:recoveryCodes.length}); // 与MFA和会话版本共同提交
      return {recoveryCodes,version:user.rows[0].session_version}; // 版本只给签发环节使用
    });
    await proofComplete(limits);                                 // 只清除成功确认的连续失败计数
    await start(request.user.id,result.version,response);         // 当前客户端拿到新版本会话
    return {enabled:true,recoveryCodes:result.recoveryCodes};      // 恢复码只在此次成功确认时显示
  }

  /** @param body 当前密码。@returns 已取消尚未启用的设置。 */
  @Post('mfa/cancel') async cancel(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({password:z.string().min(1).max(128)}).strict(),body); // 不让失窃会话随意干扰设置
    const limits=await proofLimit(request);                      // 与其它安全校验共用失败限额
    await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.password); // 先确认当前密码
      await connection.query('UPDATE account_security SET pending_ciphertext=NULL,pending_until=NULL,updated_at=now() WHERE user_id=$1 AND NOT enabled',[request.user.id]); // 只清除未启用的待确认密钥
      await record(connection,request.user.id,'account.mfa.cancel',request.user.id,{}); // 不删除已启用认证因素
    });
    await proofComplete(limits);                                 // 失败请求不会运行到此处
    return {ok:true};                                            // 可以重新开始一次新的设置
  }

  /** @param body 当前密码与当次TOTP或恢复码。@returns MFA已关闭并替换当前会话。 */
  @Post('mfa/disable') async disable(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(z.object({password:z.string().min(1).max(128),...factorFields}).strict(),body); // 密码不能单独关闭已启用的MFA
    const limits=await proofLimit(request);                      // 错误因素不重置计数
    const version=await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.password); // 当前密码与第二因素在同一账号事务验证
      await checkFactor(connection,request.user.id,input,'mfa.disable'); // TOTP计数器或恢复码只消费一次
      await connection.query('UPDATE account_security SET enabled=false,secret_ciphertext=NULL,pending_ciphertext=NULL,pending_until=NULL,last_counter=-1,enabled_at=NULL,updated_at=now() WHERE user_id=$1',[request.user.id]); // 关闭后不保留可恢复的旧共享密钥
      await connection.query('UPDATE account_recovery_codes SET revoked_at=now() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[request.user.id]); // 旧未使用恢复码全部作废
      const saved=await connection.query('UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version',[request.user.id]); // 安全设置变更撤销全部旧会话
      await record(connection,request.user.id,'account.mfa.disable',request.user.id,{}); // 审计与因素撤销共同提交
      return saved.rows[0].session_version as number;             // 新会话使用本次事务确定的版本
    });
    await proofComplete(limits);                                 // 只清除完整成功验证的失败计数
    await start(request.user.id,version,response);                // 当前客户端保留新版本会话
    return {enabled:false};                                      // 不返回旧密钥
  }

  /** @param body 当前密码与当次TOTP或恢复码。@returns 一次显示的新恢复码。 */
  @Post('mfa/recovery') async recovery(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(z.object({password:z.string().min(1).max(128),...factorFields}).strict(),body); // 重置恢复能力需要两个因素
    const limits=await proofLimit(request);                      // 不让失窃会话批量猜恢复码
    const result=await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.password); // 先锁账号并核对当前密码
      const current=await connection.query('SELECT enabled FROM account_security WHERE user_id=$1 FOR UPDATE',[request.user.id]); // 未开启MFA时不能发放恢复码
      if (!current.rows[0]?.enabled) throw new ConflictException('请先开启双因素认证'); // 不创建没有绑定因素的恢复码
      await checkFactor(connection,request.user.id,input,'mfa.recovery.reset'); // 原恢复码即使参与此次验证也只能使用一次
      const recoveryCodes=await replaceRecovery(connection,request.user.id); // 作废旧码并生成独立的新随机码
      const user=await connection.query('UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version',[request.user.id]); // 恢复能力变化撤销旧会话
      await record(connection,request.user.id,'account.recovery.reset',request.user.id,{recoveryCodeCount:recoveryCodes.length}); // 不把恢复码内容写入审计
      return {recoveryCodes,version:user.rows[0].session_version}; // 只在本次响应中提供新码
    });
    await proofComplete(limits);                                 // 不因部分验证成功而提前清零
    await start(request.user.id,result.version,response);         // 新会话绑定提交后的凭据版本
    return {recoveryCodes:result.recoveryCodes};                   // 刷新页面不会再显示这些明文
  }
}
