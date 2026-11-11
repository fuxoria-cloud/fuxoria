/*
 * 迁移验收：检查只读SQL、0600完整快照、严格预检、目标保护、原子回滚和期初负债分录。
 * 调用：npm exec tsx -- --test apps/api/tests/import.test.ts
 * 只读导出使用协议记录器核对SQL；新库导入使用真实PostgreSQL专用yunzou_import_test，结束后清理。
 */
import assert from 'node:assert/strict';                             // 按具体资金事实验证迁移
import test from 'node:test';                                       // 顺序管理专用数据库生命周期
import { createHash,randomBytes,randomUUID } from 'node:crypto';     // 夹具密码只属于隔离测试
import { existsSync } from 'node:fs'; // 环境可由外部注入
import { mkdtemp,readFile,writeFile,readdir,lstat,chmod,rm } from 'node:fs/promises'; // 临时源文件与权限检查
import { tmpdir } from 'node:os';                                   // 不把个人资料夹具放进代码目录
import { join } from 'node:path';                                   // 固定源码与迁移位置
import { fileURLToPath } from 'node:url';                            // ESM中的项目根目录
import { execFile } from 'node:child_process';                       // CLI也要验证默认不连接目标数据库
import { promisify } from 'node:util';                              // 把构建和CLI故障反馈给测试
import { verify } from 'argon2';                                   // 证明旧密码不被塞进Argon2字段
import pg from 'pg';                                               // 目标使用真实外键与延迟会计约束
import { exportSnapshot,type LegacyConnection } from '../../../scripts/export.js'; // 导出实现接受只读连接契约
import { loadSnapshot,planImport,applyImport,mappedId,type Mapping } from '../../../scripts/import.js'; // 使用真实导入流程
import { verifyAudit } from '../../../scripts/verify-audit.js';       // 导入与主业务共用审计验证

const root=fileURLToPath(new URL('../../../',import.meta.url));      // 测试可以从任意目录运行
const execute=promisify(execFile);                                 // 不通过shell拼接凭据
const instant=1704067200;                                         // 固定2024-01-01 UTC的来源时间
const digest='###'+createHash('md5').update(createHash('md5').update('old-authcodeold-password').digest('hex')).digest('hex'); // 仅用于夹具的原V10算法
const sourceRows:Record<string,Record<string,any>[]>={
 client:[{id:1,username:'旧客户',status:1,email:'old-customer@example.test',phone_code:86,phone:'18800000000',password:digest,credit:'12.34',company:'旧公司',country:'CHINA',address:'测试地址',language:'zh-cn',notes:'旧内部备注',client_notes:'客户备注',last_login_time:0,last_login_ip:'',create_time:instant,update_time:0,operate_password:''}],
 product_group:[{id:1,name:'原分组',parent_id:0}],
 product:[{id:1,name:'原月付商品',product_group_id:1,description:'原说明',stock_control:1,qty:9,pay_type:'recurring_prepayment',price:'19.99',cycle:'月',create_time:instant}],
 server:[{id:1,module:'mf_cloud'}],
 order:[{id:1,client_id:1,type:'new',status:'Paid',amount:'19.99',credit:'0.00',amount_unpaid:'0.00',refund_amount:'0.00',is_lock:0,is_recycle:0,notes:'原订单备注',create_time:instant,pay_time:instant+1,due_time:0}],
 order_item:[{id:1,order_id:1,client_id:1,host_id:1,product_id:1,type:'host',amount:'19.99'}],
 host:[{id:1,client_id:1,order_id:1,product_id:1,server_id:1,name:'原服务',status:'Active',billing_cycle:'recurring_prepayment',billing_cycle_name:'月',renew_amount:'17.99',due_time:1706745600,create_time:instant,notes:'原服务内部备注',client_notes:'原服务客户备注',suspend_type:'',suspend_reason:'',suspend_time:0}],
 module_mf_cloud_host_link:[{id:1,host_id:1,rel_id:8801}],
 transaction:[{id:1,order_id:1,client_id:1,amount:'19.99',gateway:'AliPayDmf',transaction_number:'original-provider-transaction',create_time:instant+1}],
 client_credit:[{id:1,type:'Recharge',amount:'12.34',credit:'12.34',order_id:0,host_id:0,client_id:1,notes:'原充值历史',create_time:instant}],
 addon_idcsmart_ticket_status:[{id:1,name:'待接单',status:0}],
 addon_idcsmart_ticket_type:[{id:1,name:'售后'}],
 addon_idcsmart_ticket:[{id:1,ticket_num:'OLD-1',client_id:1,title:'原工单',ticket_type_id:1,content:'原首条说明',status:1,attachment:'',notes:'原内部备注',admin_id:0,post_admin_id:0,create_time:instant,update_time:0}],
 addon_idcsmart_ticket_reply:[{id:1,ticket_id:1,type:'Client',rel_id:1,content:'原补充说明',attachment:'',create_time:instant+2}],
}; // 所有金额保持文本，源记录未伪造新收入或开通动作
const mapping:Mapping={currency:'CNY',gateways:{AliPayDmf:'alipay'},ticketStatuses:{'1':'open'}}; // 原语义需要显式确认

// --- 协议记录器只允许已声明的只读SQL，模拟源MySQL5.6返回形状 ---
function legacy(rows=sourceRows){
 const calls:string[]=[];                                        // 验证没有向原库发送写业务SQL
 const connection:LegacyConnection={async query(sql,parameters=[]){
  calls.push(sql);                                               // 参数不记录，避免形成资料日志
  if(sql.startsWith('SET ')||sql.startsWith('START ')||sql==='ROLLBACK')return [[],[]]; // 只读事务与会话设置
  if(sql==='SELECT VERSION() AS version')return [[{version:'5.6.51'}],[]]; // 验证兼容SQL而不是依赖8.0专有功能
  if(sql.includes('information_schema.TABLES'))return [Object.keys(rows).sort().map(name=>({name:`idcsmart_${name}`,engine:'InnoDB'})),[]]; // 表结构和行数据一致
  if(sql.includes('information_schema.COLUMNS')){const table=String(parameters[0]).replace(/^idcsmart_/,'');return [Object.keys(rows[table][0]??{}).map(name=>({name,type:typeof rows[table][0][name]==='number'?'int(11)':'varchar(255)',nullable:'YES',keyKind:name==='id'?'PRI':''})),[]];} // 保留所有原字段
  const table=/SELECT \* FROM `idcsmart_([^`]+)`/.exec(sql)?.[1];
  if(table){const all=rows[table];return [(sql.includes(' WHERE ')?all.filter(row=>BigInt(row.id)>BigInt(String(parameters[0]))):all).slice(0,500),[]];} // 真实执行键集分页形状
  throw new Error('导出发送了未声明SQL');                           // 任何意外SQL都不能静默通过
 }};
 return {connection,calls};                                       // 不提供任何持久写方法
}

test('原系统迁移：完整性、严格预检、只写空库与会计对账',{timeout:120_000},async context=>{
 const directory=await mkdtemp(join(tmpdir(),'yunzou-import-'));     // 个人资料夹具只在本轮临时目录
 const file=join(directory,'source.ndjson');                        // 导出器负责创建0600文件
 let admin:pg.Client|undefined,pool:pg.Pool|undefined,created=false; // 清理只针对本轮资源
 const oldAudit=process.env.AUDIT_KEY;                              // 不改写根环境文件
 try{
  const protocol=legacy();const exported=await exportSnapshot(protocol.connection,file,'old-site-01'); // 实际生成格式与尾部摘要
  const snapshot=await loadSnapshot(file);                         // 用真实解析器读回并核对每行
  await context.test('导出只读SQL、金额文本、0600和完整快照校验',async()=>{
   assert.ok(protocol.calls.some(sql=>sql.includes('CONSISTENT SNAPSHOT, READ ONLY'))); // 数据库事务自身限制写入
   assert.ok(protocol.calls.every(sql=>!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i.test(sql))); // 不给旧库任何业务变更
   assert.equal((await lstat(file)).mode&0o777,0o600);               // 个人信息不公开可读
   assert.equal(exported.snapshotHash,snapshot.hash);               // 导出器与导入器摘要一致
   assert.equal(snapshot.rows.get('transaction')![0].amount,'19.99'); // 货币不经过浮点
   const damaged=join(directory,'damaged.ndjson');                  // 损坏副本不影响原文件
   await writeFile(damaged,(await readFile(file,'utf8')).replace('19.99','19.98'),{mode:0o600}); // 不重算footer模拟传输损坏
   await assert.rejects(loadSnapshot(damaged),/SHA-256/);            // 文件被改后不能导入
   await chmod(damaged,0o644);await assert.rejects(loadSnapshot(damaged),/权限/); // 边界文件权限也要合格
   await assert.rejects(exportSnapshot(legacy().connection,file,'old-site-01'),/EEXIST/); // 原有导出不会被覆盖
   const privateFile=join(directory,'must-not-contain-authcode.ndjson'); // AUTHCODE必须独立转交，不混入数据快照
   await assert.rejects(exportSnapshot(legacy({...sourceRows,configuration:[{id:1,name:'AUTHCODE',value:'test-only-salt'}]}).connection,privateFile,'old-site-01'),/AUTHCODE/); // 检出后撤销整个导出
   await assert.rejects(lstat(privateFile),/ENOENT/);                // 不留下看似完整的含盐文件
  });
  const plan=planImport(snapshot,mapping);                          // 核对正常核心数据能形成真实目标行
  await context.test('确定性ID、原状态、合同价和期初负债都有明确来源',async()=>{
   assert.deepEqual(plan.errors,[]);                               // 没有靠忽略错误来生成计划
   assert.equal(mappedId('old-site-01','client','1'),plan.rows.users[0].id); // 可跨快照追溯同一原用户
   assert.notEqual(mappedId('another-source','client','1'),plan.rows.users[0].id); // 不同站点同旧ID不碰撞
   assert.equal(plan.rows.services[0].external_id,'8801');           // 保留真正原平台实例ID
   assert.equal(plan.rows.services[0].renew_amount_cents,'1799');    // 不以商品显示价覆盖历史合同价
   assert.equal(plan.rows.products[0].active,false);                // 迁移不会立即售卖旧供应商商品
   assert.equal(plan.rows.users[0].country,'CN');                   // 明确原安装包CHINA到ISO2的转换
   const wallet=plan.rows.ledger_entries.find(row=>row.account.startsWith('wallet:'))!; // 查看专用期初负债分录
   assert.equal(wallet.amount_cents,'-1234');                       // 客户余额对应公司贷方负债
   assert.equal(plan.rows.payment_receipts.length,1);               // 余额不被伪造成另一笔收款
   assert.equal(plan.summary.automaticProvisioningJobs,0);          // 既有资源不排开通任务
  });
  await context.test('未知状态、周期、金额、关系和非空未映射表都阻断',async()=>{
   const changed=structuredClone(snapshot);changed.rows.get('host')![0].status='Pending'; // 开通中的外部工作不能被省略
   assert.ok(planImport(changed,mapping).errors.some(error=>error.reason.includes('状态未映射'))); // 原状态不被猜成active
   const cycle=structuredClone(snapshot);cycle.rows.get('host')![0].billing_cycle_name='季'; // 非月周期需要不同计价主体
   assert.ok(planImport(cycle,mapping).errors.some(error=>error.reason.includes('计费周期'))); // 不把季度变成一个月
   const decimal=structuredClone(snapshot);decimal.rows.get('transaction')![0].amount=19.99; // JS浮点是错误导出形状
   assert.ok(planImport(decimal,mapping).errors.some(error=>error.reason.includes('精确十进制文本'))); // 不静默转换浮点
   const orphan=structuredClone(snapshot);orphan.rows.get('order_item')!.push({...orphan.rows.get('order_item')![0],id:2,order_id:999}); // 孤立子项也需被扫描
   assert.ok(planImport(orphan,mapping).errors.some(error=>error.table==='order_item')); // 不只从主单遍历掩盖丢数据
   const unsupported=structuredClone(snapshot);unsupported.manifest.tables.push({name:'idcsmart_unported_addon',logical:'unported_addon',engine:'InnoDB',columns:[],primary:[]});unsupported.counts.idcsmart_unported_addon=1; // 没实现的业务不能塞JSONB冒充完成
   assert.ok(planImport(unsupported,mapping).errors.some(error=>error.reason.includes('尚无业务映射'))); // 默认阻止apply
   const fields=structuredClone(snapshot);fields.manifest.tables.find(table=>table.logical==='client')!.columns.push({name:'unmapped_security_state',type:'int',nullable:false}); // 模拟源升级新增安全字段
   assert.ok(planImport(fields,mapping).errors.some(error=>error.reason.includes('未映射字段'))); // 不把新字段默默丢掉
   assert.ok(planImport(snapshot,{}).errors.length>0);              // 商户、币种与状态不使用隐藏猜测
   await assert.rejects(applyImport(plan,'postgres://test@127.0.0.1:1/yunzou','yunzou','postgres://dev@localhost:5432/yunzou'),/dev数据库/); // DNS别名也不能绕过目标库名保护
  });
  await context.test('CLI默认dryrun不连接IMPORT_DATABASE_URL，apply缺断言不写入',async()=>{
   const mapFile=join(directory,'mapping.json');await writeFile(mapFile,JSON.stringify(mapping),{mode:0o600}); // 审查的语义映射不含密钥
   const environment={...process.env,IMPORT_DATABASE_URL:'postgres://test@127.0.0.1:1/unreachable'}; // 真连目标就会失败
   const result=await execute(process.execPath,['--import','tsx',join(root,'scripts/import.ts'),'--file',file,'--map',mapFile],{cwd:root,env:environment,timeout:30_000}); // 用用户实际CLI入口验收
   assert.equal(JSON.parse(result.stdout).mode,'dryrun');            // 无apply即使有URI也保持离线
   await assert.rejects(execute(process.execPath,['--import','tsx',join(root,'scripts/import.ts'),'--file',file,'--map',mapFile,'--apply'],{cwd:root,env:environment,timeout:30_000}),/target-empty/); // 不接受模糊写入开关
  });

  // --- 真实目标库：先证明晚期错误会全量回滚，再验证成功导入与余额守恒 ---
  if(existsSync(join(root,'.env')))process.loadEnvFile(join(root,'.env')); // 只借用本机PostgreSQL实例地址
  assert.ok(process.env.DATABASE_URL,'需要PostgreSQL实例运行真实导入验收'); // 缺基础设施不能假报通过
  const address=new URL(process.env.DATABASE_URL!);address.pathname='/postgres';admin=new pg.Client({connectionString:address.href});await admin.connect(); // 管理连接不进入dev业务库
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(812444) AS locked')).rows[0].locked,true); // 并行运行不能互删测试库
  await admin.query('DROP DATABASE IF EXISTS yunzou_import_test WITH (FORCE)');await admin.query('CREATE DATABASE yunzou_import_test');created=true; // 只操作明确预留测试库
  address.pathname='/yunzou_import_test';pool=new pg.Pool({connectionString:address.href}); // 所有目标写入只到独立库
  for(const name of (await readdir(join(root,'database/migrations'))).filter(name=>name.endsWith('.sql')).sort())await pool.query(await readFile(join(root,'database/migrations',name),'utf8')); // 新旧迁移的真实约束同时参与
  process.env.AUDIT_KEY=randomBytes(32).toString('hex');              // 目标审计只使用本轮随机测试密钥
  await pool.query("INSERT INTO users(email,name,password,role)VALUES('bootstrap@example.test','初始管理员','not-used-for-login','admin')"); // 明确允许保留的唯一bootstrap主体
  await context.test('完整迁移的精确默认配置可保留，修改设置或币种仍拒绝导入',async()=>{
   await pool!.query('UPDATE affiliate_settings SET enabled=true');await assert.rejects(applyImport(plan,address.href,'yunzou_import_test',process.env.DATABASE_URL),/affiliate_settings.*已有业务记录/);await pool!.query('UPDATE affiliate_settings SET enabled=false');
   await pool!.query("UPDATE currencies SET name='已配置人民币' WHERE code='CNY'");await assert.rejects(applyImport(plan,address.href,'yunzou_import_test',process.env.DATABASE_URL),/currencies.*已有业务记录/);await pool!.query("UPDATE currencies SET name='人民币' WHERE code='CNY'");
  });
  await context.test('晚期外键错误全部回滚，空库之外拒绝再导入',async()=>{
   const broken=structuredClone(plan);broken.rows.ticket_replies.at(-1)!.user_id=randomUUID(); // 错误放在所有资金插入之后
   await assert.rejects(applyImport(broken,address.href,'yunzou_import_test',process.env.DATABASE_URL),/foreign key/); // 真数据库会拒绝孤立作者
   assert.equal((await pool!.query('SELECT count(*)::int AS count FROM imports')).rows[0].count,0); // 不留半个迁移记录
   assert.equal((await pool!.query('SELECT count(*)::int AS count FROM ledger_entries')).rows[0].count,0); // 资金也完整回滚
   assert.equal((await pool!.query('SELECT count(*)::int AS count FROM users')).rows[0].count,1); // 初始管理员保持原样
   await applyImport(plan,address.href,'yunzou_import_test',process.env.DATABASE_URL); // 正常路径原子写入
   await assert.rejects(applyImport(plan,address.href,'yunzou_import_test',process.env.DATABASE_URL),/已有业务记录|不是空库/); // 再运行不能双入账或覆盖客户
  });
  await context.test('真实原流水、期初余额、作者和legacy凭据完整落库且不触发开通',async()=>{
   const user=(await pool!.query("SELECT * FROM users WHERE role='customer'")).rows[0]; // 正常业务用户而不是整表JSON档案
   assert.equal(user.legacy_password,digest);assert.equal(user.legacy_authcode_id,plan.sourceKey); // 原摘要只在专用兼容字段
   assert.ok(user.password.startsWith('$argon2id$'));assert.equal(await verify(user.password,'old-password'),false); // 占位新摘要没有已知旧明文
   const money=(await pool!.query("SELECT (SELECT -sum(amount_cents)::bigint FROM ledger_entries WHERE account=$1)::text AS wallet,(SELECT sum(amount_cents)::bigint FROM ledger_entries)::text AS total,(SELECT count(*)::int FROM payment_receipts) AS receipts,(SELECT count(*)::int FROM opening_balances) AS openings,(SELECT count(*)::int FROM jobs) AS jobs",[`wallet:${user.id}`])).rows[0]; // 同时核对全部资金来源
   assert.deepEqual(money,{wallet:'1234',total:'0',receipts:1,openings:1,jobs:0}); // 不伪造余额收入，不重复开通
   assert.equal((await pool!.query('SELECT count(*)::int AS count FROM ticket_replies')).rows[0].count,2); // 首条内容与后续回复都保留
   const contract=(await pool!.query('SELECT renew_amount_cents::text AS price,billing_currency,billing_period,billing_months,billing_seconds FROM services')).rows[0];assert.equal(contract.price,'1799');assert.deepEqual({currency:contract.billing_currency,period:contract.billing_period,months:contract.billing_months,seconds:contract.billing_seconds},{currency:'CNY',period:'month',months:1,seconds:0}); // 老合同价没有涨成1999
   assert.equal((await verifyAudit(pool!,process.env.AUDIT_KEY!)).count,1); // 导入事实能被标准CLI验链
   await assert.rejects(pool!.query("UPDATE opening_balances SET amount_cents=1"),/只能追加/); // 期初事实不可改写
   await assert.rejects(pool!.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) SELECT id,'wallet:forged',1 FROM ledger_transactions WHERE opening_balance_id IS NOT NULL"),/平衡|精确对应/); // 追加分录也不能改变期初余额事实
  });
 }finally{
  if(pool)await pool.end();if(created&&admin)await admin.query('DROP DATABASE yunzou_import_test WITH (FORCE)');if(admin)await admin.end(); // 即使断言失败也删专用库与连接
  if(oldAudit===undefined)delete process.env.AUDIT_KEY;else process.env.AUDIT_KEY=oldAudit; // 恢复测试进程自身环境
  await rm(directory,{recursive:true,force:true});                  // 清理含资料的临时快照和映射
 }
});
