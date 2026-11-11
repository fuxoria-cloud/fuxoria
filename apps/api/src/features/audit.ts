/* 审计：将资金和权限相关动作追加到HMAC哈希链，和业务处于同一事务。
 * 调用：await record(connection,'user-id','order.create',orderId,{amountCents:'990'})。
 * AUDIT_KEY必须与数据库分开保管；数据库管理员仍有删库能力，需要独立备份审计锚点。
 */
import { createHmac } from 'node:crypto';                              // 用外置密钥保护审计内容
import type { PoolClient } from 'pg';                                  // 审计必须使用调用方的事务连接

/** @param connection 业务事务连接。@param actor 操作者。@param action 动作。@param target 对象。@param details 已脱敏的业务事实。 */
export async function record(connection: PoolClient, actor: string, action: string, target: string, details: object): Promise<void> {
  await connection.query("SELECT pg_advisory_xact_lock(812431)");       // 按顺序接链，避免并发形成分叉
  const previous = await connection.query('SELECT hash FROM audit ORDER BY id DESC LIMIT 1'); // 找到上一笔锚点
  const previousHash = previous.rows[0]?.hash ?? '0'.repeat(64);         // 第一笔使用公开的零锚点
  const body = JSON.stringify({actor, action, target, details, previousHash}); // 签署固定顺序的业务内容
  const hash = createHmac('sha256', process.env.AUDIT_KEY!).update(body).digest('hex'); // 不把密钥写入数据库
  await connection.query('INSERT INTO audit(actor,action,target,details,previous_hash,hash,canonical_body) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [actor, action, target, details, previousHash, hash, body]);         // 保存签署原文，Go与TS可独立验链
}
