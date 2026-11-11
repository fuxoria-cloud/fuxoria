/*
 * 原系统导入：先验证完整快照、金额、状态、关系与映射，默认只生成不含个人信息的dryrun报告。
 * 预检：npm exec tsx scripts/import.ts -- --file /secure/source.ndjson --map /secure/mapping.json
 * 写入：IMPORT_DATABASE_URL=postgres://... npm exec tsx scripts/import.ts -- --file /secure/source.ndjson --map /secure/mapping.json --apply --target-empty --database yunzou_import
 * 只接受空业务库，可保留一个bootstrap管理员；不覆盖记录，不写原MySQL，不排开通任务，不把余额伪造成支付收入。
 */
import { createHash, randomBytes } from 'node:crypto';              // 快照完整性和确定性UUID各自有固定输入
import { createReadStream, existsSync, readFileSync } from 'node:fs';             // 按行读取，不把整个原库文件一次载入内存
import { readFile, lstat } from 'node:fs/promises';                 // 检查源文件权限和显式映射配置
import { createInterface } from 'node:readline';                    // NDJSON每行保留其原始字段
import { resolve } from 'node:path';                               // 输出与配置不会因启动目录混淆
import { pathToFileURL } from 'node:url';                           // 测试导入函数时不自动运行CLI
import { hash, argon2id } from 'argon2';                            // 旧密码不放进新版Argon2验证字段
import pg from 'pg';                                             // 新库写入使用参数和一个完整事务
import type { Manifest,SourceTable } from './export.js';                       // 导出与导入只有一个快照格式
import { record } from '../apps/api/src/features/audit.js';         // 与主业务使用同一审计签名和串行锁

export type SourceRow = Record<string, any>;                       // 原字段的实际结构由manifest和领域边界一起检查
export type Snapshot = { manifest: Manifest; rows: Map<string, SourceRow[]>; counts: Record<string, number>; hash: string }; // 不保留未映射表的大量行，仍完整核对其摘要和行数
export type Mapping = { currency?: 'CNY'; gateways?: Record<string, string>; providers?: Record<string, string>; externalIds?: Record<string, string>; ticketStatuses?: Record<string, 'open'|'answered'|'closed'>; countries?: Record<string, string>; unpaidDeadline?: string }; // 需要人决定的含义显式输入，不猜周期或商户
export type Problem = { table: string; legacyId?: string; reason: string }; // 报告不附邮箱、电话、密码或正文
export type ImportPlan = { sourceId: string; sourceKey: string; importId: string; snapshotHash: string; rows: Record<string, SourceRow[]>; ids: SourceRow[]; errors: Problem[]; summary: Record<string, unknown> }; // CLI只输出summary与errors
const supported = new Set(['client','admin','product','product_group','server','host','order','order_item','transaction','client_credit','addon_idcsmart_ticket','addon_idcsmart_ticket_reply','addon_idcsmart_ticket_status','addon_idcsmart_ticket_type','module_mf_cloud_host_link','module_mf_dcim_host_link','module_idcsmart_common_server_host_link']); // 查阅原字段后实现的核心范围
const baseline = new Map<string, Set<string>>(JSON.parse(readFileSync(new URL('../reference/inventory.json', import.meta.url),'utf8')).tables.map((table:any)=>[table.name.replace(/^idcsmart_/,''),new Set(table.columns.map((column:any)=>column.name))])); // 原182表的字段证据用于识别未实现的新字段
const namespace = Buffer.from('bd872f326b2b5f7e89eb6cb2d3eb8d17', 'hex'); // 狐岚云迁移的固定UUIDv5命名空间，永不按运行时间改变

/** @param source 稳定原站标识。@param entity 领域名称。@param legacyId 原主键。@returns 同源同实体同ID永远相同的UUIDv5。 */
export function mappedId(source: string, entity: string, legacyId: string) {
  const bytes = createHash('sha1').update(namespace).update(`${source}\0${entity}\0${legacyId}`).digest().subarray(0,16); // UUIDv5按命名空间和名称计算，不表示密码安全性
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128; // 固定UUIDv5版本和RFC变体
  const value = bytes.toString('hex');                            // 后续数据库只接收标准UUID
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`; // 不同实体不会因旧ID相同而碰撞
}

/** @param file 0600导出文件。@returns 已核对尾部摘要、结构和所有行数的快照。 */
export async function loadSnapshot(file: string): Promise<Snapshot> {
  const info = await lstat(file);                                 // 不跟随符号链接或读取管道
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('导出文件必须是普通文件且权限为0600或更严格'); // 个人资料与旧摘要不应公开可读
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity }); // 每次只解析一行
  const digest = createHash('sha256');                            // 重新核对footer之前的原始内容
  let manifest: Manifest | undefined;                            // 第一行必须确定来源
  let footer: { rows: Record<string, number>; snapshotHash: string } | undefined; // 缺footer视为中断导出
  const definitions=new Map<string,SourceTable>(); // 按表名查结构，不逐行扫描182表
  const rows = new Map<string, SourceRow[]>();                     // 只有已实现领域需要留在内存做关系核对
  const counts: Record<string, number> = Object.create(null);       // 未支持表也计数，不静默消失
  let total = 0;                                                 // 控制损坏文件或异常输入的解析规模
  for await (const line of input) {
    if (!line || line.length > 8*1024*1024 || footer) throw new Error('快照有空行、超长行或footer之后的额外内容'); // 截断或追加数据不能通过
    const value = JSON.parse(line);                               // 非法JSON让整个预检失败
    if (!manifest) {
      if (value.type !== 'manifest' || value.format !== 'yunzou-zjmf-1' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.source?.id) || !Array.isArray(value.tables)) throw new Error('快照manifest格式无效'); // 不能从任意JSON猜来源
      manifest = value;                                           // 来源只定义一次
      for (const table of manifest!.tables) {
        if (!table.name.startsWith(manifest!.source.prefix) || table.logical !== table.name.slice(manifest!.source.prefix.length) || Object.hasOwn(counts,table.name) || !Array.isArray(table.columns)) throw new Error('快照表定义重复或不符合原表前缀'); // 防止表名混淆
        definitions.set(table.name,table); // 结构索引只在manifest读取时建立一次
        counts[table.name] = 0;                                   // 包含空表在内的所有表都要和footer一致
        if (supported.has(table.logical)) rows.set(table.logical,[]); // 未支持的行不被悄悄导入JSONB充数
      }
    } else if (value.type === 'end') {
      footer = value;                                             // footer不参与自引用摘要
      continue;                                                   // 后面不允许有第二份快照
    } else {
      if (value.type !== 'row' || !Object.hasOwn(counts,value.table) || !value.row || typeof value.row !== 'object' || Array.isArray(value.row)) throw new Error('快照行没有对应表定义'); // 外部行必须绑定明确表
      const table = definitions.get(value.table)!; // 只使用manifest声明的结构
      if (Object.keys(value.row).sort().join('\0') !== table.columns.map(column=>column.name).sort().join('\0')) throw new Error(`表 ${table.name} 的行字段与manifest不一致`); // 字段缺失或悄悄新增都会停止
      counts[value.table]++; total++;                             // footer必须覆盖全部读到的行
      if (total > 2_000_000) throw new Error('快照超过两百万行，请分领域规划批次导入'); // 当前核心规划器有明确内存边界
      rows.get(table.logical)?.push(value.row);                    // 这里只保存已实现的领域，未实现表稍后明确阻断
    }
    digest.update(`${line}\n`);                                  // 与导出器使用同样的换行字节
  }
  if (manifest && (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(manifest.source.prefix) || !Number.isFinite(Date.parse(manifest.source.capturedAt)))) throw new Error('快照来源前缀或捕获时间无效'); // 来源元数据也是外部输入
  if (!manifest || !footer || digest.digest('hex') !== footer.snapshotHash) throw new Error('快照不完整或SHA-256校验失败'); // 不接受残缺或被改动的数据
  if (Object.keys(counts).sort().join('\0') !== Object.keys(footer.rows ?? {}).sort().join('\0') || Object.entries(counts).some(([name,count])=>footer!.rows[name]!==count)) throw new Error('快照各表行数与footer不一致'); // 行数不能只对总和
  return { manifest, rows, counts, hash: footer.snapshotHash };      // 完整性校验通过后才进入业务解释
}

// --- 原字段的金额、编号与时间边界 ---
function id(value: unknown) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,18}$/.test(String(value)) || (typeof value==='number' && !Number.isSafeInteger(value))) throw new Error('主键或关联ID无效'); // 大整数不能经过不精确Number
  return String(value);                                           // 新旧映射只用稳定文本
}
function text(value: unknown, maximum = 20_000) {
  if (value === null || value === undefined) return '';             // 原可空说明字段在新版使用空文本
  if (typeof value !== 'string' || value.length > maximum) throw new Error('文本字段超出新版长度或不是文本'); // 不截断用户资料
  return value;                                                  // 文本按原样保留，不执行HTML或代码
}
function cents(value: unknown, signed = false) {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d{0,9})(\.\d{1,2})?$/ : /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/).test(value)) throw new Error('金额必须为精确十进制文本，最多两位小数'); // 不接受浮点、指数或静默舍入
  const negative = value.startsWith('-');                         // 历史余额变动可以为负
  const [whole,fraction=''] = value.replace(/^-/,'').split('.');   // 分开处理元和小数
  return (BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')))*(negative?-1n:1n); // 所有核对都用整数分
}
function time(value: unknown, optional = false) {
  if ((value===0 || value==='0' || value===null || value===undefined) && optional) return null; // 旧零时间表示没有该日期
  if (!/^\d{1,11}$/.test(String(value)) || Number(value)<=0 || !Number.isSafeInteger(Number(value))) throw new Error('创建时间或业务时间缺失/无效'); // 不以当前时间冒充历史日期
  return new Date(Number(value)*1000).toISOString();               // 原Unix秒转换为同一UTC瞬间
}
function flag(value: unknown) { if (![0,1,'0','1'].includes(value as any)) throw new Error('布尔状态不是0或1'); return Number(value)===1; } // 未知状态不按真假值猜测

/** @param snapshot 完整原快照。@param mapping 人工确认的语义映射。@returns 可审查的核心导入计划，errors非空时不能写入。 */
export function planImport(snapshot: Snapshot, mapping: Mapping = {}): ImportPlan {
  if (!mapping || typeof mapping!=='object' || Array.isArray(mapping) || Object.keys(mapping).some(key=>!['currency','gateways','providers','externalIds','ticketStatuses','countries','unpaidDeadline'].includes(key)))throw new Error('语义映射配置包含未知字段或不是对象'); // 配置拼错不能被静默忽略
  for(const name of ['gateways','providers','externalIds','ticketStatuses','countries'] as const){const value=mapping[name];if(value!==undefined && (!value || typeof value!=='object' || Array.isArray(value) || Object.values(value).some(item=>typeof item!=='string')))throw new Error(`映射${name}必须是文本键值对象`);} // 配置错误在边界一次检查
  const sourceId = snapshot.manifest.source.id;                    // 稳定来源不随快照日期变化
  const plan: ImportPlan = { sourceId, sourceKey:createHash('sha256').update(sourceId).digest('hex').slice(0,16).toUpperCase(), importId:mappedId(sourceId,'import','root'), snapshotHash:snapshot.hash,
    rows:Object.fromEntries(['users','products','orders','invoices','services','renewals','payment_attempts','payment_receipts','opening_balances','ledger_transactions','ledger_entries','wallet_history','tickets','ticket_replies'].map(name=>[name,[]])), ids:[],errors:[],summary:{} }; // 目标只包含真正实现的标准表
  if(mapping.currency!=='CNY')plan.errors.push({table:'source',reason:'请明确核对原站币种并设置currency:CNY，其他币种需要独立会计映射'}); // 不从中文界面猜人民币
  const source = (name:string) => snapshot.rows.get(name) ?? [];     // manifest没提供的表保持为空，不伪造记录
  const grouped=(rows:SourceRow[],field:string)=>{const groups=new Map<string,SourceRow[]>();for(const row of rows){const key=String(row[field]);const group=groups.get(key)??[];group.push(row);groups.set(key,group);}return groups;}; // 关联只扫描一遍，避免批量迁移平方级查找
  const itemsByOrder=grouped(source('order_item'),'order_id');       // 订单明细按原订单归组
  const hostsByOrder=grouped(source('host'),'order_id');             // 首次服务按原订单归组
  const receiptsByOrder=grouped(source('transaction'),'order_id');  // 原支付证据按订单归组
  const creditsByClient=grouped(source('client_credit'),'client_id'); // 逐用户余额历史线性建立索引
  const linksByHost=grouped(['module_mf_cloud_host_link','module_mf_dcim_host_link','module_idcsmart_common_server_host_link'].flatMap(name=>source(name)),'host_id'); // 平台实例只整理一次
  const indexes = new Map<string,Map<string,SourceRow>>();          // 所有关联使用原ID查找，再一次转换新ID
  for (const [name,rows] of snapshot.rows) {
    const index = new Map<string,SourceRow>();                     // 每类旧主键有自己的命名空间
    for (const row of rows) {
      if (!Object.hasOwn(row,'id')) continue;                     // 纯关联表在各自领域处理
      try { const key=id(row.id); if(index.has(key)) throw new Error('原主键重复'); index.set(key,row); }
      catch(error) { plan.errors.push({table:name,reason:(error as Error).message}); } // 只暴露结构问题，不输出资料
    }
    indexes.set(name,index);                                     // 后续内部调用信任已读到的索引
  }
  const lookup = (table:string,value:unknown) => { const row=indexes.get(table)?.get(id(value));if(!row)throw new Error(`关联的${table}记录不存在`);return row; }; // 外键缺口不能靠造记录弥补
  const mapped = (entity:string,value:unknown) => mappedId(sourceId,entity,id(value)); // UUID转换使用同一来源和规则
  const add = (table:string,entity:string,legacyId:string,row:SourceRow) => { plan.rows[table].push(row);plan.ids.push({entity,legacy_id:legacyId,new_id:row.id}); }; // 一条源记录有明确的新ID证据
  const run = (table:string,callback:(row:SourceRow)=>void) => { for(const row of source(table)){ try{callback(row);}catch(error){plan.errors.push({table,legacyId:String(row.id ?? ''),reason:(error as Error).message});} } }; // 收集可定位的错误后一次报告
  const emails = new Set<string>();                               // 新系统邮箱唯一，不能合并两个历史账号
  for(const table of snapshot.manifest.tables) {
    if(!supported.has(table.logical) && snapshot.counts[table.name]>0)plan.errors.push({table:table.name,reason:`${snapshot.counts[table.name]}行尚无业务映射，保留在源快照；禁止apply以免漏迁`}); // 未实现的业务不能被跳过
    if(supported.has(table.logical)){const unknown=table.columns.filter(column=>!baseline.get(table.logical)?.has(column.name)).map(column=>column.name);if(unknown.length)plan.errors.push({table:table.name,reason:`源表存在未映射字段：${unknown.join(',')}`});} // 升级或定制新增字段必须先解释含义
  } // 其他182表范围不冒充已移植

  // --- 用户资料、普通权限与不可直接登录的历史员工作者 ---
  for(const table of ['client','admin']) run(table,row=>{
    const email=text(row.email,254).trim().toLowerCase();           // 保留真实身份，不能生成假邮箱替换缺失信息
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || emails.has(email))throw new Error('邮箱缺失、无效或与另一账号重复，需先人工核对'); // 手机单独登录账号不能被静默变成邮箱账号
    emails.add(email);                                            // 每个已确认邮箱只接受一次
    const digest=text(row.password,255);                          // 不把旧摘要送给Argon2.verify
    if(table==='client' && !/^###[0-9a-f]{32}$/.test(digest))throw new Error('旧密码算法不受支持，需要先安排已验证身份的密码重置'); // Zkeys和未知摘要不猜算法
    const country=text(row.country,100);                          // 原版可能以CHINA等名称保存国家
    const normalizedCountry=(mapping.countries?.[country] ?? (country==='CHINA'?'CN':country)).toUpperCase(); // CHINA在原安装包中明确使用
    if(normalizedCountry && !/^[A-Z]{2}$/.test(normalizedCountry))throw new Error('国家字段需要显式映射到ISO两字母代码'); // 不丢掉原国家字段
    add('users',table,id(row.id),{id:mapped(table,row.id),email,name:text(row.username ?? row.nickname ?? row.name,60).trim(),role:table==='admin'?'support':'customer',disabled:table==='admin'?true:!flag(row.status),
      password:null,legacy_password:table==='client'?digest:null,legacy_authcode_id:table==='client'?plan.sourceKey:null,import_id:plan.importId,legacy_id:id(row.id),
      phone_code:String(row.phone_code ?? ''),phone:text(row.phone,30),company:text(row.company,120),country:normalizedCountry,address:text(row.address,500),language:text(row.language,100)||'zh-cn',notes:text(row.notes),client_notes:text(row.client_notes),
      last_login_at:time(row.last_login_time,true),last_login_ip:text(row.last_login_ip,100),created_at:time(row.create_time),updated_at:time(row.update_time,true)}); // 员工只作停用作者，不自动继承后台权限
    if(!plan.rows.users.at(-1)!.name)throw new Error('账号名称为空'); // 不生成没有来源的显示名
    if(table==='client' && text(row.operate_password,255))throw new Error('原账号有操作密码，新版尚无相同语义映射，不能忽略'); // 资金二次认证不被悄悄降级
    if(table==='client') cents(row.credit);                        // 非负期初余额需完整精度
  });

  // --- 商品只在确认月付预付价格后导入，先保持下架 ---
  run('product',row=>{
    if(row.pay_type!=='recurring_prepayment' || !['月','月付','month','monthly'].includes(row.cycle))throw new Error('商品不是可确认的自然月预付计价，不能把显示价猜成真实月付价'); // 非月付和模块复杂计价必须另做映射
    const price=cents(row.price);if(price<=0n)throw new Error('免费或零价商品需要对应计费实现'); // 当前核心价格约束不能伪造一分钱
    if(Number(row.product_group_id)>0)lookup('product_group',row.product_group_id); // 不接受丢失的商品分组关系
    const provider=mapping.providers?.[id(row.id)] ?? 'manual';if(!/^[a-z][a-z0-9_-]{0,39}$/.test(provider))throw new Error('商品供应商映射标识无效'); // 供应商仅来自人工确认映射
    const stock=flag(row.stock_control)?Number(row.qty):null;        // 未启用库存控制时保持无限库存
    if(stock!==null && (!Number.isSafeInteger(stock)||stock<0))throw new Error('库存无效'); // 不截断或修正旧库存
    add('products','product',id(row.id),{id:mapped('product',row.id),name:text(row.name,100),description:text(row.description,5000),price_cents:price.toString(),currency:'CNY',stock,provider,active:false,import_id:plan.importId,legacy_id:id(row.id),legacy_group_id:row.product_group_id?String(row.product_group_id):null,legacy_pay_type:row.pay_type,legacy_cycle:row.cycle,created_at:time(row.create_time)}); // 既有资源不会因迁移自动开通，新订购先保持关闭
  });

  // --- 单商品单资源订单与账单；多子项、抵扣、退款和回收状态明确阻断 ---
  run('order',row=>{
    lookup('client',row.client_id);                                // 不生成孤立订单
    const items=itemsByOrder.get(id(row.id))??[]; // 原购物车可能有多个子项
    if(items.length!==1)throw new Error('本映射只支持单商品单资源订单，多子项需专门计价与拆分验收'); // 不随意取第一项丢其余商品
    const item=items[0];lookup('product',item.product_id);lookup('host',item.host_id); // 每个子项都必须能追到真实资源
    if(item.type!=='host' && item.type!=='renew')throw new Error('订单子项关联类型未映射'); // 人工差价或升降级不能当正常资源
    if(row.type==='new' && (hostsByOrder.get(id(row.id))??[]).length!==1)throw new Error('首次订单必须有唯一原资源'); // 不生成没有来源的服务关系           // 商品关联来自原子项而非猜测
    if(id(item.client_id)!==id(row.client_id) || cents(item.amount)!==cents(row.amount))throw new Error('订单子项账号或金额不一致'); // 确认应付总额有完整明细
    if(!['new','renew'].includes(row.type) || !['Paid','Unpaid'].includes(row.status))throw new Error('订单类型或状态没有对应实现'); // 升降级和人工调整不是普通新购
    if(cents(row.credit)!==0n || cents(row.refund_amount)!==0n || flag(row.is_lock) || flag(row.is_recycle))throw new Error('订单有余额抵扣、退款、锁定或回收状态，需要完整状态迁移'); // 不把进行中的资金流程变成普通订单
    const amount=cents(row.amount);if(amount<=0n)throw new Error('零金额订单未映射'); // 保持财务边界
    if(cents(row.amount_unpaid)!==(row.status==='Paid'?0n:amount))throw new Error('订单未付金额与状态不一致'); // 部分付款不能冒充全额已付
    const created=time(row.create_time)!;                          // 所有历史时间来自原记录
    const due=time(row.due_time,true) ?? (row.status==='Paid'?created:mapping.unpaidDeadline); // 无截止时间的未付款单必须人工明确策略
    if(!due || !Number.isFinite(Date.parse(due)))throw new Error('未付款订单没有明确截止时间，请提供unpaidDeadline策略'); // 不把过去创建时间强当新付款期限
    add('orders','order',id(row.id),{id:mapped('order',row.id),user_id:mapped('client',row.client_id),product_id:mapped('product',item.product_id),idempotency_key:`import-${id(row.id)}`,request_hash:createHash('sha256').update(JSON.stringify(row)).digest('hex'),amount_cents:amount.toString(),currency:'CNY',kind:row.type,status:row.status==='Paid'?'paid':'unpaid',notes:text(row.notes),created_at:created,import_id:plan.importId,legacy_id:id(row.id)}); // 成交快照和原ID都保留
    add('invoices','invoice',id(row.id),{id:mapped('invoice',row.id),order_id:mapped('order',row.id),user_id:mapped('client',row.client_id),amount_cents:amount.toString(),currency:'CNY',status:row.status==='Paid'?'paid':'unpaid',due_at:due,paid_at:row.status==='Paid'?time(row.pay_time):null,created_at:created,import_id:plan.importId,legacy_id:id(row.id)}); // 不用新生成的收款冒充原历史付款
    if(row.type==='renew') { lookup('host',item.host_id);plan.rows.renewals.push({order_id:mapped('order',row.id),service_id:mapped('host',item.host_id)}); } // 续费关联已有资源，不复制第二个服务
  });

  run('order_item',row=>{lookup('order',row.order_id);lookup('client',row.client_id);lookup('product',row.product_id);lookup('host',row.host_id);}); // 孤立子项不能因只从订单遍历而被遗漏

  // --- 已有资源保持真实状态和外部ID，不写jobs ---
  run('host',row=>{
    const order=lookup('order',row.order_id);lookup('client',row.client_id);lookup('product',row.product_id); // 核对所有业务归属
    const firstItems=itemsByOrder.get(id(order.id))??[]; // 资源和订单子项需要双向一致
    if(firstItems.length!==1 || String(firstItems[0].host_id)!==id(row.id) || String(firstItems[0].product_id)!==id(row.product_id))throw new Error('资源与首单子项的商品或实例关联不一致'); // 不把客户资源挂到另一商品
    if(order.type!=='new' || id(order.client_id)!==id(row.client_id))throw new Error('资源首单或客户归属不一致'); // 不能把续费单错当首次开通
    if(row.billing_cycle!=='recurring_prepayment' || !['月','月付','month','monthly'].includes(row.billing_cycle_name))throw new Error('已有服务计费周期不是已确认的月付预付'); // 不把季/年周期改成一个月
    const states:Record<string,string>={Unpaid:'pending',Active:'active',Suspended:'suspended',Deleted:'cancelled',Failed:'failed'}; // 每个支持的状态都写明对应意义
    if((row.is_delete!==undefined && flag(row.is_delete) && row.status!=='Deleted') || text(row.downstream_info) || Number(row.downstream_host_id)>0 || (row.ratio_renew!==undefined && flag(row.ratio_renew)))throw new Error('资源有软删除、上下游或比例续费状态，需要相应业务映射'); // 不剥离会改变生命周期和价格的状态
    const status=states[row.status];if(!status)throw new Error('服务状态未映射，Pending开通中任务需单独恢复'); // 不丢掉在途开通状态
    if(['Active','Suspended'].includes(row.status) && order.status!=='Paid')throw new Error('已开通资源的首单没有全额支付事实'); // 安装示例或异常数据不能直接认账
    const server=Number(row.server_id)>0?lookup('server',row.server_id):null; // 平台身份和实例ID必须一起核对
    const links=linksByHost.get(id(row.id))??[]; // 使用真实平台关联表
    const external=mapping.externalIds?.[id(row.id)] ?? (links.length===1 && Number(links[0].rel_id)>0?String(links[0].rel_id):null); // 无法确定的资源必须人工给出真实ID
    if(['active','suspended'].includes(status) && !external)throw new Error('已有资源缺少可核对的外部实例ID，请提供externalIds映射'); // 不拿显示名伪造平台ID
    const renewed=cents(row.renew_amount);if(renewed<=0n)throw new Error('服务续费合同价无效'); // 老客户价格不能随商品显示价改变
    add('services','host',id(row.id),{id:mapped('host',row.id),user_id:mapped('client',row.client_id),product_id:mapped('product',row.product_id),order_id:mapped('order',row.order_id),name:text(row.name,100),status,billing_currency:'CNY',billing_period:'month',billing_months:1,billing_seconds:0,due_at:time(row.due_time,true),external_id:external,created_at:time(row.create_time),import_id:plan.importId,legacy_id:id(row.id),legacy_server_id:String(row.server_id),legacy_module:server?.module ?? '',renew_amount_cents:renewed.toString(),notes:text(row.notes),client_notes:text(row.client_notes),suspend_type:text(row.suspend_type,50),suspend_reason:text(row.suspend_reason,1000),suspended_at:time(row.suspend_time,true)}); // 迁移不触发任何平台动作
  });

  // --- 有原渠道流水且全额核对的历史收款进入正常账本，余额只走期初负债 ---
  run('transaction',row=>{
    const order=lookup('order',row.order_id);lookup('client',row.client_id); // 充值无订单或拆分收款还需对应业务映射
    const peers=receiptsByOrder.get(id(order.id))??[]; // 当前每账单只允许一笔完整收款
    if(order.status!=='Paid' || peers.length!==1 || id(row.client_id)!==id(order.client_id) || cents(row.amount)!==cents(order.amount))throw new Error('历史收款不是可核对的单笔全额已付订单'); // 不把多次部分付款或退款挤成一笔假流水
    const gateway=mapping.gateways?.[text(row.gateway,50)];          // 原渠道名称到新插件必须显式绑定
    if(!gateway || !/^[a-z][a-z0-9_-]{0,39}$/.test(gateway) || !text(row.transaction_number,100))throw new Error('历史支付渠道未映射或原交易号缺失'); // 不伪造渠道和交易号
    const receipt=mapped('transaction',row.id),invoice=mapped('invoice',row.order_id),ledger=mapped('receipt-ledger',row.id),created=time(row.create_time); // 保留每笔真实来源
    plan.rows.payment_attempts.push({invoice_id:invoice,gateway,created_at:created}); // 这条来源是导入的历史渠道事实
    add('payment_receipts','transaction',id(row.id),{id:receipt,invoice_id:invoice,gateway,transaction_id:row.transaction_number,amount_cents:cents(row.amount).toString(),currency:'CNY',created_at:created,import_id:plan.importId,legacy_id:id(row.id),legacy_gateway:row.gateway}); // 历史收入不重复调用支付回调
    plan.rows.ledger_transactions.push({id:ledger,receipt_id:receipt,currency:'CNY',created_at:created}); // 一条实际收款只记一次会计事务
    plan.rows.ledger_entries.push({transaction_id:ledger,account:`cash:${gateway}`,amount_cents:cents(row.amount).toString(),created_at:created},{transaction_id:ledger,account:`income:${mapped('client',row.client_id)}`,amount_cents:(-cents(row.amount)).toString(),created_at:created}); // 原现金收入有对应的平衡分录
  });
  for(const order of source('order')) if(order.status==='Paid' && (receiptsByOrder.get(String(order.id))??[]).length!==1)plan.errors.push({table:'order',legacyId:String(order.id),reason:'已付订单缺少唯一可核对的原收款流水，不能伪造收入'}); // Paid标记本身不等于资金证据
  run('client_credit',row=>{
    lookup('client',row.client_id);                                // 历史余额变更和期初余额分开保存
    if(!['Artificial','Recharge','Applied','Overpayment','Underpayment','Refund'].includes(row.type))throw new Error('余额变更类型未映射'); // 不猜资金动作含义
    if(Number(row.order_id)>0)lookup('order',row.order_id);if(Number(row.host_id)>0)lookup('host',row.host_id); // 关联为0才表示原来无关联
    add('wallet_history','client_credit',id(row.id),{id:mapped('client_credit',row.id),import_id:plan.importId,legacy_id:id(row.id),user_id:mapped('client',row.client_id),kind:row.type,amount_cents:cents(row.amount,true).toString(),balance_after_cents:cents(row.credit,true).toString(),order_id:Number(row.order_id)>0?mapped('order',row.order_id):null,service_id:Number(row.host_id)>0?mapped('host',row.host_id):null,notes:text(row.notes),created_at:time(row.create_time)}); // 历史资料不再次重放到钱包
  });
  run('client',row=>{
    const histories=[...(creditsByClient.get(id(row.id))??[])].sort((left,right)=>Number(left.create_time)-Number(right.create_time) || Number(left.id)-Number(right.id)); // 同时刻按旧ID核对顺序
    for(let position=1;position<histories.length;position++)if(cents(histories[position-1].credit,true)+cents(histories[position].amount,true)!==cents(histories[position].credit,true))throw new Error('余额历史前后不连续'); // 不从异常流水推断可用余额
    const balance=cents(row.credit);if(histories.length && cents(histories.at(-1)!.credit,true)!==balance)throw new Error('最终历史余额与账号余额不一致'); // 逐用户对账而非只对全站总额
    if(balance===0n)return;                                       // 零余额无需伪造一笔会计交易
    const opening=mapped('opening',row.id),ledger=mapped('opening-ledger',row.id),created=snapshot.manifest.source.capturedAt; // 期初事实绑定这份快照
    plan.rows.opening_balances.push({id:opening,import_id:plan.importId,user_id:mapped('client',row.id),currency:'CNY',amount_cents:balance.toString(),created_at:created}); // 正余额事实单独保管
    plan.rows.ledger_transactions.push({id:ledger,opening_balance_id:opening,currency:'CNY',created_at:created}); // 独立来源，不伪造成付款收入
    plan.rows.ledger_entries.push({transaction_id:ledger,account:`wallet:${mapped('client',row.id)}`,amount_cents:(-balance).toString(),created_at:created},{transaction_id:ledger,account:'migration:equity',amount_cents:balance.toString(),created_at:created}); // 钱包是公司负债贷方，客户可用余额为负sum
  });

  // --- 工单正文与作者使用正常业务表，附件与自定义状态不静默丢弃 ---
  run('addon_idcsmart_ticket',row=>{
    lookup('client',row.client_id);lookup('addon_idcsmart_ticket_status',row.status); // 工单归属与状态都有来源
    if(Number(row.ticket_type_id)>0)lookup('addon_idcsmart_ticket_type',row.ticket_type_id); // 工单分类关系保留原ID且先核实存在
    const status=mapping.ticketStatuses?.[String(row.status)];if(!status || !['open','answered','closed'].includes(status))throw new Error('工单状态需要明确映射'); // 不用同名或数字猜结束状态
    if(text(row.attachment))throw new Error('工单有附件，须先完成受控文件迁移映射'); // 不能只搬标题却丢客户上传文件
    add('tickets','ticket',id(row.id),{id:mapped('ticket',row.id),user_id:mapped('client',row.client_id),subject:text(row.title,160),priority:'normal',status,created_at:time(row.create_time),updated_at:time(row.update_time,true) ?? time(row.create_time),import_id:plan.importId,legacy_id:id(row.id),legacy_number:text(row.ticket_num,128),legacy_type_id:String(row.ticket_type_id),notes:text(row.notes),assigned_user_id:Number(row.admin_id)>0?(lookup('admin',row.admin_id),mapped('admin',row.admin_id)):null}); // 原工单号与内部备注明确保留
    const author=Number(row.post_admin_id)>0?(lookup('admin',row.post_admin_id),mapped('admin',row.post_admin_id)):mapped('client',row.client_id); // 后台代开不能伪造成客户本人
    plan.rows.ticket_replies.push({id:mapped('ticket-initial',row.id),ticket_id:mapped('ticket',row.id),user_id:author,message:text(row.content),created_at:time(row.create_time),import_id:plan.importId,legacy_id:`initial:${id(row.id)}`}); // 原首条正文转为正常首条回复
  });
  run('addon_idcsmart_ticket_reply',row=>{
    lookup('addon_idcsmart_ticket',row.ticket_id);if(text(row.attachment))throw new Error('工单回复附件尚无文件映射'); // 回复中的附件同样不能丢失
    if(!['Client','Admin'].includes(row.type))throw new Error('工单回复作者类型未知'); // 作者权限不能猜
    const table=row.type==='Client'?'client':'admin';lookup(table,row.rel_id); // 保留真正作者，不用管理员顶替
    add('ticket_replies','ticket-reply',id(row.id),{id:mapped('ticket-reply',row.id),ticket_id:mapped('ticket',row.ticket_id),user_id:mapped(table,row.rel_id),message:text(row.content),created_at:time(row.create_time),import_id:plan.importId,legacy_id:id(row.id)}); // 前台可以读到完整迁移的会话内容
  });
  const transactions=new Set<string>(); // 迁移前就发现目标渠道流水号唯一冲突
  for(const receipt of plan.rows.payment_receipts){const key=`${receipt.gateway}\0${receipt.transaction_id}`;if(transactions.has(key))plan.errors.push({table:'transaction',legacyId:receipt.legacy_id,reason:'多个源记录映射到同渠道同交易号'});transactions.add(key);} // 不等写入一半才发现资金主键冲突
  plan.summary={sourceId,sourceKey:plan.sourceKey,snapshotHash:snapshot.hash,sourceTables:snapshot.manifest.tables.length,sourceRows:Object.values(snapshot.counts).reduce((sum,count)=>sum+count,0),mappedRows:Object.fromEntries(Object.entries(plan.rows).map(([name,rows])=>[name,rows.length])),openingBalanceCents:plan.rows.opening_balances.reduce((sum,row)=>sum+BigInt(row.amount_cents),0n).toString(),errors:plan.errors.length,automaticProvisioningJobs:0,productsInitiallyHidden:true}; // 不输出任何个人字段和密码摘要
  return plan;                                                    // errors非空时写入函数也会拒绝
}

/** @param plan 通过预检的计划。@param address 专用新库URI。@param targetName 显式确认的数据库名。@param protectedAddress 现dev连接，禁止作为迁移目标。@returns 原子提交的计数摘要。 */
export async function applyImport(plan: ImportPlan,address:string,targetName:string,protectedAddress?:string) {
  if(plan.errors.length)throw new Error('预检存在阻断错误，禁止apply'); // CLI开关不能绕过资金或状态问题
  const target=new URL(address);if(!targetName || decodeURIComponent(target.pathname.slice(1))!==targetName || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(targetName))throw new Error('目标库名与--database不一致'); // 需要精确确认新库
  if(protectedAddress){const protected_=new URL(protectedAddress);if(decodeURIComponent(target.pathname)===decodeURIComponent(protected_.pathname))throw new Error('禁止将当前dev数据库作为迁移目标');} // 不读取、更不覆盖dev业务数据
  if(!process.env.AUDIT_KEY || process.env.AUDIT_KEY.length<32)throw new Error('请提供新库使用的AUDIT_KEY'); // 审计失败不能留下半个导入
  const pool=new pg.Pool({connectionString:address,max:1});const client=await pool.connect(); // 只有显式apply才接触目标库
  try{
    if((await client.query('SELECT current_database() AS name')).rows[0].name!==targetName)throw new Error('实际连接库与--database不一致'); // URI参数也不能把连接转到另一个库
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');       // 空库检查与全部插入处于同一事务
    await client.query("SET LOCAL lock_timeout='5s'");             // 目标仍有工作负载时不无限持锁等待
    await client.query('SELECT pg_advisory_xact_lock(812440)');     // 同库只允许一个导入者
    const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map(row=>row.tablename as string); // 检查真实目标所有业务表
    const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;     // 表名只来自数据库目录或内部计划
    if(!tables.includes('imports') || !tables.includes('opening_balances'))throw new Error('请先在新库执行完整迁移'); // 不边猜结构边写入
    await client.query(`LOCK TABLE ${tables.map(quote).join(',')} IN ACCESS EXCLUSIVE MODE`); // 阻止检查后并发写入破坏空库假设
    for(const table of tables){
      const migrationDefaults:Record<string,string>={
        affiliate_settings:`id=true AND enabled=false AND initial_rule='{"kind":"percent","value":"1000"}'::jsonb AND renewal_rule='{"kind":"percent","value":"1000"}'::jsonb AND reorder_rule='{"kind":"percent","value":"1000"}'::jsonb AND hold_days=30 AND minimum_withdraw_cents=10000`,
        currencies:`code='CNY' AND name='人民币' AND symbol='¥' AND decimals=2 AND rate_numerator=1 AND rate_denominator=1 AND active AND is_default`
      }; // 仅接受完整迁移自身的精确初始配置；修改后的设置与其他币种仍算已有业务
      if(table==='migrations')continue;                           // 结构版本登记不是业务数据
      const count=Number((await client.query(`SELECT count(*)::text AS count FROM ${quote(table)}`)).rows[0].count); // 只核对数量，不读取客户内容
      if(migrationDefaults[table]&&count===1&&(await client.query(`SELECT 1 FROM ${quote(table)} WHERE ${migrationDefaults[table]}`)).rowCount===1)continue;
      if(table==='users') {const admins=(await client.query("SELECT count(*)::int AS count FROM users WHERE role='admin' AND import_id IS NULL")).rows[0].count;if(count!==admins||count>1)throw new Error('目标用户表不是空库或单一bootstrap管理员');continue;} // 不合并现有客户
      if(count!==0)throw new Error(`目标表${table}已有业务记录，禁止覆盖或追加迁移`); // articles、refunds、余额等都不能被漏检
    }
    const bootstrap=await client.query('SELECT email FROM users'); // 只确认邮箱冲突，不覆盖管理员
    if(bootstrap.rows.some(row=>plan.rows.users.some(user=>user.email===row.email)))throw new Error('原账号邮箱与bootstrap管理员冲突'); // 不能靠ON CONFLICT抢占权限
    const insert=async(table:string,row:SourceRow)=>{const names=Object.keys(row);await client.query(`INSERT INTO ${quote(table)}(${names.map(quote).join(',')}) VALUES(${names.map((_,index)=>`$${index+1}`).join(',')})`,names.map(name=>row[name]));}; // 列名由内部领域计划决定，值全部参数化
    await insert('imports',{id:plan.importId,source_id:plan.sourceId,source_key:plan.sourceKey,snapshot_hash:plan.snapshotHash,summary:plan.summary}); // 同源、同快照不会重复导入
    for(const user of plan.rows.users)await insert('users',{...user,password:await hash(randomBytes(32).toString('base64url'),{type:argon2id})}); // 新摘要无已知明文，旧密码走专用兼容分支
    for(const table of ['products','orders','invoices','services','renewals','payment_attempts','payment_receipts','opening_balances','ledger_transactions','ledger_entries','wallet_history','tickets','ticket_replies'])for(const row of plan.rows[table])await insert(table,row); // 外键顺序直接可读，无后台钩子或队列魔法
    for(const row of plan.ids)await insert('import_ids',{import_id:plan.importId,...row}); // 每个转换后的ID都可追回旧记录
    await record(client,'migration','import.complete',plan.importId,plan.summary); // 资金与导入事实进入同一不可变审计链
    await client.query('COMMIT');                                  // 延迟双分录和期初约束都通过才算成功
    return plan.summary;                                          // 只返回不含个人数据的摘要
  }catch(error){await client.query('ROLLBACK');throw error;}         // 任一行失败撤销整轮，不留下部分客户或余额
  finally{client.release();await pool.end();}                                     // 退出释放所有表锁和连接
}

// --- 命令行预检默认不连接任何数据库 ---
async function main(){
  const environment=new URL('../.env',import.meta.url);if(existsSync(environment))process.loadEnvFile(environment); // 只用新库专用IMPORT_DATABASE_URL，根连接仅用于禁止dev目标
  const arguments_=process.argv.slice(2).filter(value=>value!=='--'); // 兼容npm exec的参数分隔符
  const options:Record<string,string|boolean>={};                    // 没有隐式apply或默认目标库
  for(let index=0;index<arguments_.length;index++){
    const name=arguments_[index];if(['--apply','--target-empty'].includes(name)){options[name]=true;continue;} // 两个写入断言都要显式出现
    if(!['--file','--map','--database'].includes(name)||!arguments_[index+1]||arguments_[index+1].startsWith('--'))throw new Error('用法：tsx scripts/import.ts --file snapshot.ndjson [--map mapping.json] [--apply --target-empty --database NEW_DB]'); // 未知参数不能被忽略
    options[name]=arguments_[++index];                             // 输入路径不插入shell命令
  }
  if(typeof options['--file']!=='string')throw new Error('请提供--file导出快照'); // 不猜原系统目录
  const snapshot=await loadSnapshot(resolve(options['--file']));    // 完整性检查优先于任何数据库访问
  const mapping=typeof options['--map']==='string'?JSON.parse(await readFile(resolve(options['--map']),'utf8')):{}; // 语义映射可审查，不携带密钥
  const plan=planImport(snapshot,mapping);                          // 默认只生成可定位的预检报告
  if(!options['--apply']){console.log(JSON.stringify({mode:'dryrun',...plan.summary,problems:plan.errors},null,2));if(plan.errors.length)process.exitCode=2;return;} // dryrun即使配置了URI也不连接目标
  if(!options['--target-empty']||typeof options['--database']!=='string'||!process.env.IMPORT_DATABASE_URL)throw new Error('apply还需要--target-empty、精确--database和单独IMPORT_DATABASE_URL'); // 不以一次模糊开关误写线上
  console.log(JSON.stringify({mode:'applied',...await applyImport(plan,process.env.IMPORT_DATABASE_URL,options['--database'],process.env.DATABASE_URL)})); // 最终只输出已提交摘要
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;}); // 被测试导入不执行CLI
