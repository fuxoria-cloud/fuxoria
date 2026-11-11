/* 首位管理员：读取环境中的邮箱和密码，创建或提升该账号；不内置默认密码。
 * 调用：BOOTSTRAP_EMAIL=you@example.com BOOTSTRAP_PASSWORD='12位以上密码' npm run bootstrap。
 * 已有账号只有同一密码核验通过才允许提升，避免通过邮箱抢占权限。
 */
import { existsSync } from 'node:fs';                              // 容器可直接注入变量
import { hash, verify, argon2id } from 'argon2';                     // 管理员使用与普通账号相同的强哈希
import pg from 'pg';                                              // 初始化不依赖正在运行的HTTP服务

if (existsSync(new URL('../.env',import.meta.url))) process.loadEnvFile(new URL('../.env',import.meta.url)); // 文件路径不随启动目录变化
const email=process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();      // 统一邮箱形式
const password=process.env.BOOTSTRAP_PASSWORD ?? '';                // 密码只读环境，不写入脚本
if (!email || !email.includes('@') || password.length<12) throw new Error('请提供管理员邮箱和至少12位的BOOTSTRAP_PASSWORD'); // 不生成弱默认账号
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}); // 数据库是唯一账号来源
try {
  const found=await pool.query('SELECT id,password FROM users WHERE email=$1',[email]); // 已有账号须确认拥有权
  if (found.rowCount && !await verify(found.rows[0].password,password)) throw new Error('此邮箱已有账号，密码核对失败'); // 不覆盖用户密码强行接管
  const digest=await hash(password,{type:argon2id});                // 只持久化不可逆摘要
  await pool.query("INSERT INTO users(email,name,password,role) VALUES($1,'管理员',$2,'admin') ON CONFLICT(email) DO UPDATE SET role='admin'",[email,digest]); // 管理权限只通过本机初始化赋予
  console.log('管理员已就绪');                                    // 不回显密码或摘要
} finally {
  await pool.end();                                               // 初始化完成后关闭连接
}
