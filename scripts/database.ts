/* 数据库迁移：按文件名应用database/migrations；只执行未登记的脚本。
 * 调用：复制.env后在项目根目录运行 npm run db:migrate。
 * 每次迁移使用事务和全局锁；已执行文件被修改时停止，避免悄悄改变线上结构。
 */
import { existsSync } from 'node:fs';                              // 环境文件可由容器直接注入而省略
import { readFile, readdir } from 'node:fs/promises';                // 迁移文件就是变更来源
import { createHash } from 'node:crypto';                          // 固定已经执行过的SQL内容
import pg from 'pg';                                              // 不依赖外部psql程序

if (existsSync(new URL('../.env',import.meta.url))) process.loadEnvFile(new URL('../.env',import.meta.url)); // 工作目录变化也不会读错文件
const client=new pg.Client({connectionString:process.env.DATABASE_URL}); // 连接目标由部署环境提供
await client.connect();                                           // 不自动猜测生产连接
try {
  await client.query('SELECT pg_advisory_lock(812430)');            // 避免多个实例同时升级
  await client.query('CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())'); // 仅此表用于记账迁移
  const directory=new URL('../database/migrations/',import.meta.url); // 路径固定到代码位置
  for (const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort()) {
    const sql=await readFile(new URL(name,directory),'utf8');       // 文件顺序就是执行顺序
    const hash=createHash('sha256').update(sql).digest('hex');      // 同名文件只允许内容不变
    const prior=await client.query('SELECT hash FROM migrations WHERE name=$1',[name]); // 查询已登记版本
    if (prior.rowCount) {
      if (prior.rows[0].hash!==hash) throw new Error(`已执行的迁移内容发生变化：${name}`); // 只能新增迁移，不能改历史
      continue;                                                   // 重复运行不会重复建表
    }
    await client.query('BEGIN');                                  // 每个文件保持原子性
    await client.query(sql);                                      // SQL失败会在退出时回滚
    await client.query('INSERT INTO migrations(name,hash) VALUES($1,$2)',[name,hash]); // SQL和迁移记录一并提交
    await client.query('COMMIT');                                 // 成功后后续文件才可执行
    console.log(`已应用 ${name}`);                                // 只输出版本，不打印连接密码
  }
} finally {
  await client.end();                                             // 退出也释放迁移锁
}
