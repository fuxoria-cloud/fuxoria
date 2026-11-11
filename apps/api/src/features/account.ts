/* 账号：注册、双因素登录、资料、改密与会话撤销；密码只保存Argon2id摘要。
 * 调用：POST /api/v1/auth/register {email,password,name}；POST /auth/login {email,password,totp?}。
 * 改密：POST /auth/password {currentPassword,newPassword,totp?}；成功后所有旧会话失效。
 * 旧项目导入密码仅在AUTHCODE配置正确时验证一次，随后同事务升级并清除旧摘要。
 */
import { Body, Controller, Get, Post, Put, Req, Res, ConflictException, UnauthorizedException, HttpException } from '@nestjs/common'; // HTTP只承接明确的账号操作
import { hash, verify, argon2id } from 'argon2';                   // 登录后只使用强密码摘要
import { createHash, timingSafeEqual } from 'node:crypto';       // 旧摘要仅用于一次升级，比较不提前返回
import type { Response } from 'express';                        // Cookie由统一会话主体设置
import { z } from 'zod';                                        // 外部输入在这里整理一次
import { Public, tokenHash, type SessionRequest } from '../utils/access.js'; // 角色不接受浏览器自报
import { read } from '../utils/input.js';                        // 格式错误反馈到统一HTTP入口
import { pool, redis, transaction } from './store.js';           // 账号事实只有数据库一份
import { record } from './audit.js';                             // 安全变更与业务同时提交
import { start, revoke, clear } from './session.js';             // 所有Cookie与会话格式共用一处定义
import { checkPassword, checkFactor, factorComplete, factorFields, proofLimit, proofComplete } from './security.js'; // 密码与第二因素保持同一套验证
import { attachReferral } from './affiliate.js';                  // 推荐归因与注册事实使用同一事务

const email=z.string().trim().toLowerCase().email().max(254);    // 邮箱使用唯一规范化形式
const strongPassword=z.string().min(12,'密码至少12位').max(128); // 新口令保持强度与资源边界
const loginInput=z.object({email,password:z.string().min(1).max(128),...factorFields}).strict(); // 旧账号口令可短于12位，验证后升级摘要
const registerInput=z.object({email,password:strongPassword,name:z.string().trim().min(1).max(60),referralCode:z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional()}).strict(); // 新账号不能带角色或导入标识
const profileColumns='id,email,name,role,phone,phone_code AS "phoneCode",company,country,address,language,timezone,(to_jsonb(users)->>\'email_verified_at\') IS NOT NULL AS "emailVerified",(to_jsonb(users)->>\'phone_verified_at\') IS NOT NULL AS "phoneVerified",created_at AS "createdAt"'; // 对外资料不含摘要、密钥或内部备注
const proofInput=z.object({password:z.string().min(1).max(128),...factorFields}).strict(); // 会话操作也需要当前凭据

// --- 只构造允许公开的账号摘要 ---
function summary(user:Record<string,any>) {
  return {id:user.id,email:user.email,name:user.name,role:user.role}; // 密码摘要和凭据版本不会随登录响应外泄
}

// --- 核对已保存的旧项目摘要 ---
function legacyPassword(user:Record<string,any>,password:string) {
  if (!/^###[0-9a-f]{32}$/.test(user.legacy_password ?? '')) return false; // 未知旧算法不猜测兼容
  const source=/^[0-9A-F]{16}$/.test(user.legacy_authcode_id ?? '') ? process.env[`LEGACY_AUTHCODE_${user.legacy_authcode_id}`] : undefined; // 来源只决定一项授权码配置名
  const authcode=source ?? process.env.LEGACY_AUTHCODE;           // 单源部署可使用统一AUTHCODE变量
  if (!authcode) return false;                                  // 未配置授权码统一拒绝登录，不把旧摘要喂给Argon2
  const inner=createHash('md5').update(authcode+password).digest('hex'); // 原idcsmart_password先对授权码与口令做MD5
  const expected='###'+createHash('md5').update(inner).digest('hex'); // 原算法再次对十六进制摘要做MD5
  return timingSafeEqual(Buffer.from(expected),Buffer.from(user.legacy_password)); // 已确认两边都是35字节
}

@Controller('auth')
export default class Account {
  /** @param body 邮箱、密码和姓名。@returns 普通客户摘要与安全Cookie。 */
  @Public() @Post('register') async register(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(registerInput,body);                         // 注册不接收MFA或管理员自报字段
    await this.limit(request.ip ?? '',input.email);              // 先限制成本再计算摘要
    const digest=await hash(input.password,{type:argon2id});      // 新口令不经过旧项目算法
    const user=await transaction(async connection=>{
      const found=await connection.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING *',[input.email,input.name,digest]); // 角色只用数据库普通客户默认值
      if (!found.rowCount) throw new ConflictException('这个邮箱已注册，请直接登录'); // 不覆盖已有账号
      await attachReferral(connection,found.rows[0].id,input.referralCode); // 归因失败不会留下半注册账号
      await record(connection,found.rows[0].id,'account.register',found.rows[0].id,{}); // 注册与审计共同提交
      return found.rows[0];                                      // 内部版本供固定版本签发会话
    });
    await start(user.id,user.session_version,response);           // 防止并发安全变更后签出错误版本
    return summary(user);                                        // 不返回任何凭据摘要
  }

  /** @param body 邮箱、当前口令、可选TOTP或恢复码。@returns 全部因素验证后的账号摘要。 */
  @Public() @Post('login') async login(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(loginInput,body);                            // 老口令只放宽登录长度，不放宽注册或改密
    await this.limit(request.ip ?? '',input.email);              // 密码正确但MFA失败仍继续占限额
    const user=await transaction(async connection=>{
      const found=await connection.query('SELECT * FROM users WHERE email=$1 AND NOT disabled FOR UPDATE',[input.email]); // 同一账号认证与改密保持串行
      const current=found.rows[0];                               // 不从客户端获取角色或来源授权码
      let valid=false;                                           // 验证失败统一反馈401
      if (current?.legacy_password) valid=legacyPassword(current,input.password); // 老摘要只按已知原算法核对
      else if (current?.password.startsWith('$argon2')) valid=await verify(current.password,input.password); // 不将###摘要交给Argon2解析
      else await hash(input.password,{type:argon2id});            // 不存在的账号也完成一次摘要成本，减少枚举差异
      if (!current || !valid) throw new UnauthorizedException('邮箱或密码不正确'); // 授权码缺失也不泄漏导入来源
      await checkFactor(connection,current.id,input,'account.login'); // 启用MFA后密码单独不能签发会话
      let saved=current;                                         // 只有全部因素通过才允许升级凭据
      if (current.legacy_password) {
        const digest=await hash(input.password,{type:argon2id}); // 正确旧口令立即升级为Argon2id
        const upgraded=await connection.query('UPDATE users SET password=$2,legacy_password=NULL,legacy_authcode_id=NULL,session_version=session_version+1 WHERE id=$1 RETURNING *',[current.id,digest]); // 旧摘要和授权码来源同时清除
        saved=upgraded.rows[0];                                  // 本次会话使用升级后的版本
        await record(connection,current.id,'account.password.upgrade',current.id,{from:'idcsmart-legacy'}); // 审计不含旧摘要与AUTHCODE
      }
      await connection.query('UPDATE users SET last_login_at=now(),last_login_ip=$2,updated_at=now() WHERE id=$1',[saved.id,(request.ip ?? '').slice(0,80)]); // 保存当前真实登录时间，不记录口令
      await record(connection,saved.id,'account.login',saved.id,{}); // 因素消费和登录事实同事务提交
      return saved;                                              // 凭据版本固定在认证时点
    });
    await factorComplete(user.id);                               // 全部因素验证成功后才清因素失败预算
    await start(user.id,user.session_version,response);           // 不读取更高版本来包装旧验证结果
    return summary(user);                                        // 不把MFA密钥放进登录响应
  }

  /** @returns 当前已认证的账号摘要。 */
  @Get('me') me(@Req() request:SessionRequest) { return request.user; } // 权限与会话版本已经由Access核对

  /** @returns 当前账号完整可编辑资料。 */
  @Get('profile') async details(@Req() request:SessionRequest) {
    const found=await pool.query(`SELECT ${profileColumns} FROM users WHERE id=$1`,[request.user.id]); // 不返回管理员内部备注
    return found.rows[0];                 // 验证状态来自已成功消费的真实发送挑战
  }

  /** @param body 姓名和可选个人资料。@returns 保存后的资料。 */
  @Put('profile') async profile(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({name:z.string().trim().min(1).max(60),phone:z.string().trim().max(30).regex(/^[+\d ()-]*$/).optional(),phoneCode:z.string().trim().max(10).regex(/^\+?\d*$/).optional(),company:z.string().trim().max(120).optional(),country:z.string().trim().toUpperCase().regex(/^([A-Z]{2})?$/).optional(),address:z.string().trim().max(500).optional(),language:z.enum(['zh-cn','en-us']).optional(),timezone:z.string().trim().min(1).max(64).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'时区名称无效').optional()}).strict(),body); // 邮箱和角色不能从资料接口改写
    return transaction(async connection=>{
      const current=(await connection.query("SELECT phone,(to_jsonb(u)->>'phone_verified_at') IS NOT NULL AS verified FROM users u WHERE id=$1 FOR UPDATE",[request.user.id])).rows[0]; // 已验证绑定只能通过验证码与本人证明更换
      if(current.verified && input.phone!==undefined){if(input.phone.replace(/[ ()-]/g,'')!==current.phone)throw new ConflictException('已验证手机号请通过安全资料验证流程更换');input.phone=current.phone;} // 同号格式调整不能破坏全局规范化唯一性
      const result=await connection.query(`UPDATE users SET name=$2,phone=COALESCE($3,phone),phone_code=COALESCE($4,phone_code),company=COALESCE($5,company),country=COALESCE($6,country),address=COALESCE($7,address),language=COALESCE($8,language),timezone=COALESCE($9,timezone),updated_at=now() WHERE id=$1 RETURNING ${profileColumns}`,[request.user.id,input.name,input.phone ?? null,input.phoneCode ?? null,input.company ?? null,input.country ?? null,input.address ?? null,input.language ?? null,input.timezone ?? null]); // 老客户端只提交name时保留其余资料
      await record(connection,request.user.id,'account.profile',request.user.id,{fields:Object.keys(input)}); // 审计记录改过哪些字段，不复制地址或手机号
      return result.rows[0];              // 资料与审计同时可见
    });
  }

  /** @returns 当前会话已撤销。 */
  @Post('logout') async logout(@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    await revoke(request.cookies.yunzou_session,response);         // 先使Redis令牌失效再移除浏览器Cookie
    await transaction(connection=>record(connection,request.user.id,'account.logout',request.user.id,{})); // 不记录令牌正文
    return {ok:true};                                             // 其它设备保持原有会话
  }

  /** @param body 当前密码、新密码和当次第二因素。@returns 已改密，当前客户端持有新版本会话。 */
  @Post('password') async password(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(z.object({currentPassword:z.string().min(1).max(128),newPassword:strongPassword,...factorFields}).strict(),body); // 不通过邮箱或假验证码重置口令
    const limits=await proofLimit(request);                      // 错误旧密码或MFA都保留失败次数
    const version=await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.currentPassword); // 当前会话不代替当前密码验证
      await checkFactor(connection,request.user.id,input,'account.password.change'); // 启用MFA后改密也需要第二因素
      const digest=await hash(input.newPassword,{type:argon2id}); // 新口令使用Argon2id
      const saved=await connection.query('UPDATE users SET password=$2,legacy_password=NULL,legacy_authcode_id=NULL,session_version=session_version+1,updated_at=now() WHERE id=$1 RETURNING session_version',[request.user.id,digest]); // 一个版本增量撤销全部旧会话
      await record(connection,request.user.id,'account.password.change',request.user.id,{}); // 口令与审计在同一事务提交
      return saved.rows[0].session_version as number;             // 新版本来源只有这次数据库变更
    });
    await proofComplete(limits);                                 // 只在所有验证与事务成功后重置
    await start(request.user.id,version,response);                // 当前浏览器拿到新的固定版本Cookie
    return {ok:true};                                             // 不返回密码、摘要或历史令牌
  }

  /** @param body 当前密码及第二因素。@returns 其它旧会话失效，当前客户端换新会话。 */
  @Post('sessions/revoke') async sessions(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(proofInput,body);                            // 被盗会话不能单独注销全部其它设备
    const limits=await proofLimit(request);                      // 当前密码与因素均受连续失败限制
    const version=await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.password); // 明确由账号拥有者发起
      await checkFactor(connection,request.user.id,input,'account.sessions.revoke'); // 已开启MFA时同时验证
      const saved=await connection.query('UPDATE users SET session_version=session_version+1 WHERE id=$1 RETURNING session_version',[request.user.id]); // 所有旧版本令牌立即失效
      await record(connection,request.user.id,'account.sessions.revoke',request.user.id,{}); // 撤销与版本一起提交
      return saved.rows[0].session_version as number;             // 不扫描整个Redis键空间
    });
    await proofComplete(limits);                                 // 验证失败绝不清零
    await start(request.user.id,version,response);                // 保留当前客户端的新会话
    return {ok:true};                                             // 原Cookie同样已经失效
  }

  /** @param body 当前密码及第二因素。@returns 包含本机在内的全部旧会话失效。 */
  @Post('logout-all') async logoutAll(@Body() body:unknown,@Req() request:SessionRequest,@Res({passthrough:true}) response:Response) {
    const input=read(proofInput,body);                            // 注销所有设备需明确凭据
    const limits=await proofLimit(request);                      // 防止被盗会话反复猜密码
    await transaction(async connection=>{
      await checkPassword(connection,request.user.id,input.password); // 当前会话不是安全变更的唯一凭据
      await checkFactor(connection,request.user.id,input,'account.logout.all'); // 第二因素消费与版本变更原子完成
      await connection.query('UPDATE users SET session_version=session_version+1 WHERE id=$1',[request.user.id]); // 所有已签发版本立即无效
      await record(connection,request.user.id,'account.logout.all',request.user.id,{}); // 不删除历史审计
    });
    await proofComplete(limits);                                 // 完整成功后才清除失败计数
    clear(response);                                             // 这条操作明确不再签发新会话
    return {ok:true};                                             // 下一次访问需要重新登录
  }

  private async limit(ip:string,address:string) {
    for (const value of [ip,address]) {
      const key=`login:${tokenHash(value)}`;                     // 不在Redis键中保存明文邮箱
      const count=await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",{keys:[key],arguments:[]}); // 原子设置限流过期
      if (Number(count)>20) throw new HttpException('尝试过于频繁，请10分钟后再试',429); // 密码或MFA失败都不能绕过预算
    }
  }
}
