/* 会话：以固定凭据版本签发新令牌，旧版本由统一访问边界拒绝。
 * 调用：await start(user.id,user.session_version,response)；退出时 await revoke(cookieToken,response)。
 * Redis值为JSON {id:string,version:number}；明文令牌只通过HttpOnly Cookie交给浏览器。
 */
import { randomBytes } from 'node:crypto';                        // 使用256位不可预测的会话令牌
import { UnauthorizedException } from '@nestjs/common';          // 凭据版本已变化时要求重新认证
import type { Response } from 'express';                         // Cookie统一在这里设置
import { pool, redis } from './store.js';                        // 版本在PostgreSQL，短期会话在Redis
import { tokenHash } from '../utils/access.js';                  // Redis键只包含令牌摘要

/** @param id 已通过认证的账号。@param version 认证事务读取的凭据版本。@param response HTTP响应。 */
export async function start(id:string,version:number,response:Response) {
  const found = await pool.query('SELECT 1 FROM users WHERE id=$1 AND session_version=$2 AND NOT disabled',[id,version]); // 不把旧口令验证结果升级为新版本会话
  if (!found.rowCount) throw new UnauthorizedException('账号凭据已变化，请重新登录'); // 并发改密不会被稍后签发的会话绕过
  const token = randomBytes(32).toString('base64url');             // 每次成功认证都生成新令牌
  const ttl = Number(process.env.SESSION_TTL_SECONDS ?? 86400);    // 过期时间只有一个配置来源
  await redis.set(`session:${tokenHash(token)}`,JSON.stringify({id,version}),{EX:ttl}); // Access同时核对数据库版本
  response.cookie('yunzou_session',token,{httpOnly:true,secure:new URL(process.env.PUBLIC_ORIGIN!).protocol==='https:',sameSite:'lax',path:'/',maxAge:ttl*1000}); // HTTPS启用Secure，本机HTTP仍可开发
}

/** @param token 当前Cookie令牌。@param response HTTP响应。 */
export async function revoke(token:string,response:Response) {
  await redis.del(`session:${tokenHash(token)}`);                 // 先撤销服务端令牌
  clear(response);                                              // 再让浏览器移除Cookie
}

/** @param response HTTP响应。 */
export function clear(response:Response) {
  response.clearCookie('yunzou_session',{httpOnly:true,secure:new URL(process.env.PUBLIC_ORIGIN!).protocol==='https:',sameSite:'lax',path:'/'}); // 删除使用与签发一致的Cookie范围
}
