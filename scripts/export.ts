/*
 * 原系统只读导出：在 MySQL 一致性只读快照内导出各表原字段、结构与行数，金额保持十进制文本。
 * 调用：LEGACY_DATABASE_URL='mysql://...' LEGACY_SOURCE_ID='old-site-01' npm exec tsx scripts/export.ts -- --out /secure/source.ndjson
 * 输出使用0600临时文件，成功后原子创建最终文件；已有文件不会被覆盖。AUTHCODE不从PHP配置读取。
 */
import { createHash, randomUUID } from 'node:crypto';                // 固定整份快照的完整性校验
import { open, link, unlink, mkdir, readFile } from 'node:fs/promises'; // 创建不可覆盖且只有本人可读的导出文件
import { dirname, resolve } from 'node:path';                       // 输出路径由调用方显式指定
import { pathToFileURL } from 'node:url';                            // 被测试导入时不会自动连接原数据库

export type LegacyConnection = { query(sql: string, parameters?: unknown[]): Promise<[any[], unknown]>; end?(): Promise<void> }; // 测试可检验真正发出的只读SQL
export type SourceTable = { name: string; logical: string; engine: string; columns: { name: string; type: string; nullable: boolean }[]; primary: string[] }; // 原字段定义随数据一起交付
export type Manifest = { type: 'manifest'; format: 'yunzou-zjmf-1'; source: { id: string; version: string; capturedAt: string; prefix: string }; tables: SourceTable[] }; // 数据来源只有一处定义

/** @param connection 原库只读账号连接。@param output 目标文件，必须不存在。@param sourceId 稳定原站点标识。@param prefix 原表前缀。@returns 不含个人数据的校验摘要。 */
export async function exportSnapshot(connection: LegacyConnection, output: string, sourceId: string, prefix = 'idcsmart_') {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(sourceId) || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(prefix)) throw new Error('请使用1至80位站点标识和有效表前缀'); // 不把用户输入拼成任意SQL标识符
  const quote = (value: string) => `\`${value.replaceAll('`', '``')}\``; // 表名和列名只来自information_schema
  const temporary = `${output}.part-${randomUUID()}`;              // 失败产物不冒充完整快照
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });   // 新建目录只有本人可访问
  const file = await open(temporary, 'wx', 0o600);                  // 不覆盖文件或跟随已有链接
  const hash = createHash('sha256');                              // footer之前的全部原始字节参与摘要
  const counts: Record<string, number> = Object.create(null);       // 不在终端打印表内数据
  let committed = false;                                          // 无论哪一步失败都清理未完成导出
  try {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ'); // 5.6+支持的会话隔离设置
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); // 数据库自身拒绝事务中的持久写入
    const [versions] = await connection.query('SELECT VERSION() AS version'); // 原数据库版本随快照记录
    const [tableRows] = await connection.query("SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"); // 不执行原PHP或应用钩子
    const tables: SourceTable[] = [];                              // 逐表收集实际结构，不假定线上只有安装包182表
    for (const table of tableRows.filter(table => String(table.name).startsWith(prefix))) {
      if (String(table.engine).toLowerCase() !== 'innodb') throw new Error(`表 ${table.name} 不是InnoDB，不能在此只读快照保证一致性`); // 不把不受事务保护的表混入金融快照
      const [columns] = await connection.query('SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_KEY AS keyKind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table.name]); // 字段名与类型都有来源证据
      tables.push({ name: table.name, logical: table.name.slice(prefix.length), engine: table.engine,
        columns: columns.map(column => ({ name: column.name, type: column.type, nullable: column.nullable === 'YES' })), primary: columns.filter(column => column.keyKind === 'PRI').map(column => column.name) }); // 主键用于稳定分页
    }
    if (!tables.length) throw new Error('指定表前缀没有找到原系统表'); // 空导出不能被误认为有效备份
    const manifest: Manifest = { type: 'manifest', format: 'yunzou-zjmf-1', source: { id: sourceId, version: String(versions[0].version), capturedAt: new Date().toISOString(), prefix }, tables }; // 不保存原连接URI或AUTHCODE
    const write = async (value: unknown) => { const line = `${JSON.stringify(value)}\n`; hash.update(line); await file.writeFile(line); }; // 摘要与磁盘写入使用完全相同字节
    await write(manifest);                                         // 第一行可以不读数据就检查来源与结构
    for (const table of tables) {
      let offset = 0;                                             // 无简单主键的旧关联表按快照内偏移分页
      let last: string | number | undefined;                      // 单主键表使用键集分页，避免大表偏移反复扫描
      counts[table.name] = 0;                                     // 空表也保留明确行数
      for (;;) {
        const simple = table.primary.length === 1;               // 复合主键保留原排序，不猜拼接比较语义
        const where = simple && last !== undefined ? ` WHERE ${quote(table.primary[0])}>?` : ''; // 只有参数值来自数据
        const order = table.primary.length ? ` ORDER BY ${table.primary.map(quote).join(',')}` : ''; // 同一快照内保持分页次序
        const parameters = simple ? (last === undefined ? [500] : [last, 500]) : [offset, 500]; // 一次只读取有限页
        const pagination = simple ? ' LIMIT ?' : ' LIMIT ?,?';     // 语法兼容MySQL5.6
        const [rows] = await connection.query(`SELECT * FROM ${quote(table.name)}${where}${order}${pagination}`, parameters); // 只执行SELECT，不更新旧库任何业务字段
        if (!rows.length) break;                                 // 读完本表后再移到下一张
        for (const row of rows) {
          const authcode = (value: string) => /^(legacy|system)?authcode$/i.test(value.replace(/[_-]/g,'')); // 原认证盐必须通过独立密钥配置传递
          if (Object.keys(row).some(authcode) || ['name','key','setting','config_name'].some(name=>typeof row[name]==='string' && authcode(row[name]))) throw new Error(`表 ${table.name} 包含AUTHCODE配置，请通过受控密钥流程单独处理`); // 不把旧认证盐写入数据导出
          await write({ type: 'row', table: table.name, row });      // 业务原字段完整保留，不执行原插件
        } // 所有原字段保留，未映射内容不会被静默剔除
        counts[table.name] += rows.length;                         // 统计以真正读到的快照行为准
        offset += rows.length;                                   // 仅无单主键路径使用偏移
        if (simple) last = rows.at(-1)![table.primary[0]];         // 下页从本页最后主键之后读取
      }
    }
    const snapshotHash = hash.digest('hex');                       // footer本身不参与自引用摘要
    await file.writeFile(`${JSON.stringify({ type: 'end', rows: counts, snapshotHash })}\n`); // 读到footer才说明快照完整
    await file.sync();                                            // 完整数据落盘后才创建最终文件名
    await file.close();                                           // 不把未关闭句柄交给后续导入
    await connection.query('ROLLBACK');                            // 只读事务退出，不发任何业务写入或提交
    await link(temporary, output);                                // 原子创建且拒绝覆盖现有文件
    committed = true;                                             // 最终文件此时才是完整导出
    return { sourceId, tables: tables.length, rows: Object.values(counts).reduce((sum, count) => sum + count, 0), snapshotHash }; // 摘要不含账号、金额明细或密码
  } finally {
    await file.close().catch(() => {});                            // 已关闭时不掩盖原来的导出错误
    if (!committed) await connection.query('ROLLBACK').catch(() => {}); // 断连或失败仍尽力释放快照
    await unlink(temporary).catch(() => {});                       // 只删本轮自己创建的临时文件
  }
}

// --- 命令行连接原MySQL，只读账号与TLS配置由环境提供 ---
async function main() {
  const arguments_ = process.argv.slice(2);                        // CLI不通过隐含工作目录猜输出文件
  const position = arguments_.indexOf('--out');                    // 导出文件必须显式给出
  if (position < 0 || !arguments_[position + 1] || arguments_.some((value, index) => index !== position && index !== position + 1 && value !== '--')) throw new Error('用法：tsx scripts/export.ts --out /secure/source.ndjson'); // 不接受拼错后被忽略的选项
  if (!process.env.LEGACY_DATABASE_URL || !process.env.LEGACY_SOURCE_ID) throw new Error('请配置LEGACY_DATABASE_URL和稳定的LEGACY_SOURCE_ID'); // 不复用新系统DATABASE_URL去碰原库
  const address = new URL(process.env.LEGACY_DATABASE_URL);          // 旧凭据只保留在内存
  if (address.protocol !== 'mysql:' || address.search || address.hash) throw new Error('LEGACY_DATABASE_URL须为mysql://用户:密码@主机:端口/库名，不附加查询参数'); // URI不会被当作SQL参数
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname); // 本机可经SSH隧道访问旧版本数据库
  const tls = process.env.LEGACY_MYSQL_TLS ?? (local ? 'disabled' : 'required'); // 远程默认校验证书
  if (!['required', 'disabled'].includes(tls)) throw new Error('LEGACY_MYSQL_TLS仅允许required或disabled'); // 不默默跳过TLS验证
  const packageName = 'mysql2/promise';                             // 只有真正导出时才需要安装MySQL驱动
  const mysql = await import(packageName);                          // 默认dryrun导入不连接MySQL
  const connection = await mysql.createConnection({ host: address.hostname, port: Number(address.port || 3306), user: decodeURIComponent(address.username), password: decodeURIComponent(address.password), database: decodeURIComponent(address.pathname.slice(1)),
    supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true, multipleStatements: false,
    ssl: tls === 'required' ? { rejectUnauthorized: true, ...(process.env.LEGACY_MYSQL_CA ? { ca: await readFile(process.env.LEGACY_MYSQL_CA, 'utf8') } : {}) } : undefined }); // DECIMAL与大整数不经过Number丢精度
  try { console.log(JSON.stringify(await exportSnapshot(connection, resolve(arguments_[position + 1]), process.env.LEGACY_SOURCE_ID, process.env.LEGACY_TABLE_PREFIX ?? 'idcsmart_'))); } // 只输出摘要
  finally { await connection.end(); }                              // 成功失败都关闭原库连接
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; }); // 被测试导入不会自动执行CLI
