/* 数据连接：集中保管PostgreSQL连接池、Redis连接和事务边界。
 * 调用：await connect(); await transaction(connection=>connection.query('SELECT 1'))。
 * 资金保存在PostgreSQL；Redis仅保存可过期的会话和限流数据。
 */
import pg from 'pg';                                                   // PostgreSQL参数化查询
import { createClient } from 'redis';                                  // 会话和限流使用Redis

export const pool = new pg.Pool({connectionString: process.env.DATABASE_URL, max: 20}); // 单进程连接上限
pool.on('error', error => console.error('PostgreSQL空闲连接故障', error.message)); // 故障连接由池移除，避免短暂断连变成无人接收的进程异常
export const redis = createClient({url: process.env.REDIS_URL});        // Redis不承担资金持久化
redis.on('error', error => console.error('Redis连接故障', error.message)); // 明确记录基础设施故障

/** @returns 数据存储就绪；失败时终止启动。 */
export async function connect(): Promise<void> {
  await pool.query('SELECT 1');                                        // 先确认账本数据库可用
  await redis.connect();                                               // 认证和限流必须可用才接收流量
}

/** @param run 一个完整业务事务。@returns 事务提交后的业务结果。 */
export async function transaction<T>(run: (connection: pg.PoolClient) => Promise<T>): Promise<T> {
  const connection = await pool.connect();                             // 同一事务始终使用同一连接
  try {
    await connection.query('BEGIN');                                   // 业务变更与审计共同提交
    await connection.query("SET LOCAL statement_timeout = '10s'");     // 限制异常查询持锁时间
    const result = await run(connection);                              // 主体在这里执行自己的步骤
    await connection.query('COMMIT');                                  // 成功后一次性可见
    return result;                                                    // 不在提交前回复成功
  } catch (error) {
    await connection.query('ROLLBACK');                                // 数据库边界统一处理回滚
    throw error;                                                      // 错误由HTTP入口统一回复
  } finally {
    connection.release();                                             // 无论成功失败都归还连接
  }
}

/** @returns 关闭连接，供测试与优雅退出使用。 */
export async function close(): Promise<void> {
  await redis.quit();                                                  // 停止接受新的会话操作
  await pool.end();                                                    // 等待已开始的事务结束
}
