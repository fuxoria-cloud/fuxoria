/* 外币迁移期初：读取已核对的0600 JSON，默认预检；显式apply后写来源、负债双分录与审计。
 * 预检：node --env-file=.env --import tsx scripts/opening.ts --file /secure/opening.json
 * 写入：IMPORT_DATABASE_URL=postgres://... node --env-file=.env --import tsx scripts/opening.ts --file /secure/opening.json --apply --database yunzou
 * 输入：{sourceId,sourceKey,sourceHash,asOf,reason,balances:[{userId,currency,amountCents}]}，金额为该币种最小单位。
 * 仅可写入尚无钱包流水的同币种账户；重复相同源摘要返回原事实，不覆盖或合并旧余额。
 */
import 'reflect-metadata';
import {readFile,lstat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import pg from 'pg';
import {z} from 'zod';
import {record} from '../apps/api/src/features/audit.js';
const schema=z.object({sourceId:z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),sourceKey:z.string().regex(/^[0-9A-F]{16}$/),sourceHash:z.string().regex(/^[0-9a-f]{64}$/),asOf:z.string().datetime(),reason:z.string().trim().min(10).max(1000),balances:z.array(z.object({userId:z.uuid(),currency:z.string().regex(/^[A-Z]{3}$/),amountCents:z.string().regex(/^[1-9]\d{0,11}$/)}).strict()).min(1).max(5000)}).strict();
export async function importOpening(connection:pg.PoolClient,input:unknown,apply=false){const value=schema.parse(input),snapshotHash=createHash('sha256').update(JSON.stringify(value)).digest('hex');if(new Set(value.balances.map(row=>`${row.userId}:${row.currency}`)).size!==value.balances.length)throw new Error('同一来源的账号币种不能重复');
 await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`opening-import:${value.sourceId}`]);
 const prior=(await connection.query('SELECT id,snapshot_hash FROM imports WHERE source_id=$1',[value.sourceId])).rows[0];if(prior){if(prior.snapshot_hash!==snapshotHash)throw new Error('同一来源标识的摘要不同，不能重复迁入');return {id:prior.id,replayed:true,applied:true};}
 const totals=new Map<string,bigint>();for(const row of [...value.balances].sort((a,b)=>a.userId.localeCompare(b.userId)||a.currency.localeCompare(b.currency))){
  await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet:${row.userId}`]);
  if(!(await connection.query("SELECT 1 FROM users u WHERE id=$1 AND role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id)",[row.userId])).rowCount)throw new Error('期初记录存在非客户主账号');
  if(!(await connection.query('SELECT 1 FROM currencies WHERE code=$1 FOR SHARE',[row.currency])).rowCount)throw new Error('请先定义迁入币种与最小单位精度');
  if((await connection.query('SELECT 1 FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account=$1 AND t.currency=$2 LIMIT 1',[`wallet:${row.userId}`,row.currency])).rowCount)throw new Error('该账号已有此币种钱包流水，不能追加迁移期初');
  totals.set(row.currency,(totals.get(row.currency)||0n)+BigInt(row.amountCents));
 }
 const summary={rows:value.balances.length,sourceHash:value.sourceHash,asOf:value.asOf,totals:[...totals].map(([currency,total])=>({currency,amountCents:total.toString()}))};if(!apply)return {...summary,applied:false};
 const id=randomUUID();await connection.query('INSERT INTO imports(id,source_id,source_key,snapshot_hash,summary) VALUES($1,$2,$3,$4,$5)',[id,value.sourceId,value.sourceKey,snapshotHash,summary]);
 for(const row of value.balances){const source=randomUUID();await connection.query('INSERT INTO opening_balances(id,import_id,user_id,currency,amount_cents,created_at) VALUES($1,$2,$3,$4,$5,$6)',[source,id,row.userId,row.currency,row.amountCents,value.asOf]);const ledger=(await connection.query('INSERT INTO ledger_transactions(opening_balance_id,currency) VALUES($1,$2) RETURNING id',[source,row.currency])).rows[0];await connection.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,'migration:equity',$4)",[ledger.id,`wallet:${row.userId}`,(-BigInt(row.amountCents)).toString(),row.amountCents]);}
 await record(connection,'migration','wallet.opening_import',id,{...summary,sourceId:value.sourceId,snapshotHash,reason:value.reason});return {id,...summary,applied:true,replayed:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const {values}=parseArgs({options:{file:{type:'string'},apply:{type:'boolean',default:false},database:{type:'string'}}});if(!values.file)throw new Error('请通过--file指定已核对的私有期初文件');const path=resolve(values.file),info=await lstat(path);if(!info.isFile()||(info.mode&0o077)!==0||info.size>1024*1024)throw new Error('期初文件须为不超过1MiB的0600普通文件');const address=new URL(process.env.IMPORT_DATABASE_URL||process.env.DATABASE_URL!);if(values.apply&&(!values.database||decodeURIComponent(address.pathname.slice(1))!==values.database))throw new Error('写入时--database必须与连接目标数据库一致');const connection=new pg.Client({connectionString:address.href});await connection.connect();try{await connection.query('BEGIN');const result=await importOpening(connection,JSON.parse(await readFile(path,'utf8')),values.apply);await connection.query(values.apply?'COMMIT':'ROLLBACK');process.stdout.write(JSON.stringify(result)+'\n');}catch(error){await connection.query('ROLLBACK');throw error;}finally{await connection.end();}}
