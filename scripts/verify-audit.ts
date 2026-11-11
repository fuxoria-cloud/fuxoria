/*
 * 审计验链：验证每笔 HMAC、前一锚点和签名原文对应的业务字段，不读取或输出任何密钥。
 * 调用：npm exec tsx scripts/verify-audit.ts；连接与密钥从受控环境或根 .env 读取。
 * 程序调用：await verifyAudit(connection, auditKey, expectedLastHash)。expectedLastHash 是独立保管的尾部锚点，可省略。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';             // 对实际签名原文字节验签
import { existsSync } from 'node:fs';                                // 容器可直接注入配置而不放环境文件
import { resolve } from 'node:path';                                // 区分 CLI 运行和被测试导入
import { pathToFileURL } from 'node:url';                             // ESM 入口判断不依赖当前目录
import { isDeepStrictEqual } from 'node:util';                        // JSONB 字段顺序变化不改变业务事实比较
import pg from 'pg';                                                // 只读连接数据库，不加载应用服务

/** @param connection 只读数据库连接。@param key 外置审计密钥。@param expectedLastHash 独立保管的尾部锚点。@returns 已核验数量和最终锚点。 */
export async function verifyAudit(connection: pg.Client | pg.Pool, key: string, expectedLastHash?: string) {
  let previousHash = '0'.repeat(64);                                // 首笔记录以公开零锚点开始
  let lastId = '0';                                                 // 以 ID 分页，不一次加载全站审计
  let count = 0;                                                    // 只统计已完整验证的记录
  let historicalCount = 0;                                          // 历史无原文记录需要单独交代
  for (;;) {
    const page = await connection.query('SELECT id::text,actor,action,target,details,previous_hash,hash,canonical_body FROM audit WHERE audit.id>$1 ORDER BY audit.id LIMIT 1000', [lastId]); // 私有字段不写日志
    if (!page.rowCount) break;                                      // 本次读取到链尾结束
    for (const row of page.rows) {
      if (row.previous_hash !== previousHash) throw new Error(`审计链在记录 ${row.id} 处断开`); // 漏记录、改链或乱序都不能通过
      const body = row.canonical_body ?? JSON.stringify({ actor: row.actor, action: row.action, target: row.target, details: row.details, previousHash: row.previous_hash }); // 历史格式只能尝试按原五字段恢复
      const expected = createHmac('sha256', key).update(body).digest('hex'); // Go 和 TS 都按数据库保存的实际原文验证
      const received = typeof row.hash === 'string' && /^[0-9a-f]{64}$/.test(row.hash) ? Buffer.from(row.hash, 'hex') : Buffer.alloc(0); // 数据库字段仍需通过读取边界
      if (received.length !== 32 || !timingSafeEqual(Buffer.from(expected, 'hex'), received)) {
        if (row.canonical_body === null) throw new Error(`历史审计记录 ${row.id} 缺少签名原文，恢复的五字段 JSON 无法通过 HMAC；JSONB 可能已重排 details 键，需要原始签名文本或旧导出核对`); // 不把不可恢复的字节顺序谎报成已验证
        throw new Error(`审计记录 ${row.id} 的 HMAC 无效`);            // 不打印密钥、原文和客户信息
      }
      let signed: Record<string, unknown>;                          // 签名内容还必须对应可查询的业务字段
      try { signed = JSON.parse(body); } catch { throw new Error(`审计记录 ${row.id} 的签名原文不是合法 JSON`); } // 原文损坏不能继续读链
      if (!isDeepStrictEqual(signed, { actor: row.actor, action: row.action, target: row.target, details: row.details, previousHash: row.previous_hash })) throw new Error(`审计记录 ${row.id} 的字段与签名原文不一致`); // 防止保留旧签名却改查询元数据
      if (row.canonical_body === null) historicalCount++;            // 恢复验证成功也保留历史格式的计数
      previousHash = row.hash;                                     // 下一笔必须接上这一笔的完整签名
      lastId = row.id;                                             // 分页依据数据库实际 ID，不假设没有序号间隙
      count++;                                                    // 只有签名和事实都一致才计入成功
    }
  }
  if (expectedLastHash && previousHash !== expectedLastHash) throw new Error('审计尾部与独立保管的锚点不一致'); // 独立锚点能发现数据库尾部被整体删除
  return { count, historicalCount, lastId, lastHash: previousHash };   // 返回锚点供部署方独立保管
}

// --- 命令行只读验链 ---
async function main() {
  const environment = new URL('../.env', import.meta.url);             // 配置路径固定到项目，不随启动目录改变
  if (existsSync(environment)) process.loadEnvFile(environment);       // 已注入变量优先，不要求环境文件存在
  if (!process.env.DATABASE_URL || !process.env.AUDIT_KEY || process.env.AUDIT_KEY.length < 32) throw new Error('请配置 DATABASE_URL 和至少32字符的 AUDIT_KEY'); // 配置错误不猜默认库
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); // 客户端不会修改任何审计记录
  await client.connect();                                           // 网络故障直接让验收失败
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // 分页读取固定快照，在线接链不会干扰这次检查
    const result = await verifyAudit(client, process.env.AUDIT_KEY, process.env.AUDIT_EXPECTED_HEAD); // 可与独立保存的尾部锚点比较
    await client.query('COMMIT');                                    // 正常结束只读快照
    console.log(JSON.stringify({ status: 'verified', ...result }));   // 只输出计数和公开的链锚点
  } finally {
    await client.end();                                              // 失败也会释放事务和连接
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; }); // 错误不附带连接字符串或密钥
}
