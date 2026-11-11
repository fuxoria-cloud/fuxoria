/* 信用额度：管理员授信，主账号用信用结清业务账单，到账后才冲销应收款。
 * 调用：GET /credit；POST /invoices/:id/pay-credit {password,...第二因素}；POST /credit/repayments + Idempotency-Key。
 * 充值和还款单不能使用信用；到期欠款会阻止继续借用，既有债务在停用授信后仍可偿还。
 */
import { currencyCode,currencyDefinition } from './currency.js';
import { Body,Controller,Get,Post,Put,Headers,Param,Query,Req,ConflictException,NotFoundException,type OnModuleInit,type OnModuleDestroy } from '@nestjs/common'; // HTTP和月度账单共用相同主体
import { createHash } from 'node:crypto';                          // 还款指纹不能换一组债务
import { z } from 'zod';                                         // 授信金额和账期只接受有界输入
import type { PoolClient } from 'pg';                            // 同一事务内核对额度和付款
import { pool,transaction } from './store.js';                    // 应收款、资源交付和审计共同提交
import { assertInvoiceUncombined } from './combined.js';          // 合并子单不能独立重复付款
import { fulfill } from './settlement.js';                        // 借用额度也不能复活已终止资源
import { record } from './audit.js';                             // 授信变化和借用事实可追溯
import { verifyIdentity,factorFields } from './security.js';      // 借款和授信要求本人复核
import { notify } from './notification.js';                      // 月结单使用站内通知
import { Roles,type SessionRequest } from '../utils/access.js';   // 客户只能查看自己的债务
import { read,uuid,price } from '../utils/input.js';              // 金额按整数分传输

const columns='a.currency,(SELECT decimals FROM currencies WHERE code=a.currency) AS "currencyDecimals",a.user_id AS "userId",a.enabled,a.limit_cents::text AS "limitCents",a.billing_day AS "billingDay",a.repayment_days AS "repaymentDays",a.note'; // 授信不是可提现余额
/** @param connection 数据库连接。@param userId 客户。@returns 当前真实应收款和额度。 */
async function balance(connection:Pick<typeof pool,'query'>,userId:string,currency='CNY') {
 const found=await connection.query(`SELECT ${columns},COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='receivable:'||a.user_id::text AND t.currency=a.currency),0)::text AS "usedCents" FROM credit_accounts a WHERE a.user_id=$1 AND a.currency=$2`,[userId,currency]); // 额度使用只从实际账本读取
 if(!found.rowCount)return {userId,currency,enabled:false,limitCents:'0',usedCents:'0',availableCents:'0',billingDay:1,repaymentDays:15,note:''}; // 未授信客户没有隐含额度
 const row=found.rows[0];return {...row,availableCents:(BigInt(row.limitCents)-BigInt(row.usedCents)).toString()}; // 不使用浮点相减
}
const unbilledPayment="NOT EXISTS(SELECT 1 FROM credit_repayment_items i JOIN orders o ON o.id=i.order_id WHERE i.payment_id=p.id AND o.status<>'cancelled')"; // 候选和锁后明细共用同一未归集事实
/** @param connection 已持有客户信用锁。@param userId 客户。@returns 未开还款单的信用占用。 */
async function unbilled(connection:PoolClient,userId:string,dueOnly=false,at=new Date(),currency='CNY') {
 return (await connection.query(`SELECT p.id,p.amount_cents::text,p.due_at,p.currency FROM credit_payments p WHERE p.user_id=$1 AND p.currency=$4 AND (NOT $2::boolean OR p.bill_at<=$3::timestamptz) AND ${unbilledPayment} ORDER BY p.due_at,p.id FOR UPDATE OF p`,[userId,dueOnly,at,currency])).rows; // 取消的未付款还款单释放待归集债务
}
/** @param connection 已持有信用锁。@param userId 客户。@param lines 未归集债务。@param key 已验证幂等键。@returns 实际还款账单。 */
async function repayment(connection:PoolClient,userId:string,lines:Record<string,any>[],key:string) {
 const currency=lines[0]!.currency;if(lines.some(line=>line.currency!==currency))throw new ConflictException('不同币种债务不能合并还款');
 const total=lines.reduce((sum,line)=>sum+BigInt(line.amount_cents),0n).toString(),fingerprint=createHash('sha256').update(lines.map(line=>line.id).sort().join(',')).digest('hex'); // 按真实欠款汇总，不接受自报金额
 const order=(await connection.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,kind,items_explicit,currency) VALUES($1,NULL,$2,$3,$4,'credit_repayment',true,$5) RETURNING id,status",[userId,key,'credit-repay:'+fingerprint,total,currency])).rows[0]; // 债务归集不会再次计收入
 await connection.query("INSERT INTO order_items(order_id,product_id,product_name,quantity,period,billing_months,unit_price_cents,original_unit_price_cents,amount_cents) VALUES($1,NULL,'信用额度还款',1,'onetime',0,$2,$2,$2)",[order.id,total]); // 账单有完整金额快照
 const invoice=(await connection.query('INSERT INTO invoices(order_id,user_id,amount_cents,due_at,currency) VALUES($1,$2,$3,$4,$5) RETURNING id',[order.id,userId,total,lines[0]!.due_at,currency])).rows[0]; // 到期日沿用最早合同债务
 await connection.query('INSERT INTO credit_repayments(order_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4)',[order.id,userId,total,currency]); // 父子金额由延迟约束复核
 for(const line of lines)await connection.query('INSERT INTO credit_repayment_items(order_id,payment_id,amount_cents) VALUES($1,$2,$3)',[order.id,line.id,line.amount_cents]); // 一笔占用只归入一个有效还款单
 await record(connection,userId,'credit.repayment_created',order.id,{invoiceId:invoice.id,amountCents:total,currency,paymentIds:lines.map(line=>line.id)});return {...order,invoiceId:invoice.id,amountCents:total,currency}; // 生成还款单不提前释放额度
}

@Controller()
export default class Credit implements OnModuleInit,OnModuleDestroy {
 private timer?:ReturnType<typeof setInterval>;private running=false; // 每个实例有界运行，数据库锁负责跨实例幂等
 onModuleInit(){this.timer=setInterval(()=>void this.run().catch(error=>console.error(JSON.stringify({feature:'credit',error:error instanceof Error?error.message:'月结失败'}))),60000);this.timer.unref();} // 只生成账单，不自动扣外部支付账户
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}       // 停机后不再发起下一批
 @Get('credit') async get(@Req() request:SessionRequest,@Query('currency') raw?:string){const code=read(currencyCode.default('CNY'),raw),rows=(await pool.query('SELECT currency FROM credit_accounts WHERE user_id=$1 ORDER BY currency',[request.user.id])).rows;return {...await balance(pool,request.user.id,code),totals:await Promise.all(rows.map(row=>balance(pool,request.user.id,row.currency)))};} // 公司授信和钱包余额分开读取
 @Get('credit/history') async history(@Req() request:SessionRequest) {
  return (await pool.query('SELECT p.id,p.currency,(SELECT decimals FROM currencies WHERE code=p.currency) AS "currencyDecimals",p.invoice_id AS "invoiceId",p.amount_cents::text AS "amountCents",p.bill_at AS "billAt",p.due_at AS "dueAt",p.created_at AS "createdAt",i.id AS "repaymentInvoiceId",i.status AS "repaymentStatus" FROM credit_payments p LEFT JOIN credit_repayment_items r ON r.payment_id=p.id LEFT JOIN invoices i ON i.order_id=r.order_id AND i.status<>\'cancelled\' WHERE p.user_id=$1 ORDER BY p.created_at DESC LIMIT 200',[request.user.id])).rows; // 原业务账单和还款账单均可核对
 }
 @Roles('admin') @Get('admin/credit') async all(){return (await pool.query(`SELECT ${columns},u.email,COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='receivable:'||a.user_id::text AND t.currency=a.currency),0)::text AS "usedCents" FROM credit_accounts a JOIN users u ON u.id=a.user_id ORDER BY a.updated_at DESC LIMIT 200`)).rows;} // 不暴露密码或证件
 @Roles('admin') @Put('admin/credit/:id') async grant(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const input=read(z.object({currency:currencyCode.default('CNY'),enabled:z.boolean(),limitCents:price.refine(value=>BigInt(value)<=100000000000n),billingDay:z.number().int().min(1).max(28),repaymentDays:z.number().int().min(1).max(90),note:z.string().trim().min(1).max(1000),password:z.string().min(1).max(128),...factorFields}).strict(),body); // 授信必须有明确操作说明
  await verifyIdentity(request,input,'credit.grant','admin');return transaction(async connection=>{
   await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${id}`]); // 与借用额度使用同一个客户锁
   if(!(await connection.query("SELECT 1 FROM users u WHERE id=$1 AND NOT disabled AND role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id)",[id])).rowCount)throw new NotFoundException('客户主账号不存在'); // 子账号不能独立授信
   await currencyDefinition(connection,input.currency);const current=await balance(connection,id,input.currency);if(BigInt(input.limitCents)<BigInt(current.usedCents))throw new ConflictException('额度不能低于实际未还应收款'); // 停用仍保留原债权
   await connection.query('INSERT INTO credit_accounts(user_id,enabled,limit_cents,billing_day,repayment_days,note,currency) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,currency) DO UPDATE SET enabled=EXCLUDED.enabled,limit_cents=EXCLUDED.limit_cents,billing_day=EXCLUDED.billing_day,repayment_days=EXCLUDED.repayment_days,note=EXCLUDED.note,updated_at=now()',[id,input.enabled,input.limitCents,input.billingDay,input.repaymentDays,input.note,input.currency]); // 不覆盖既有借款的账期快照
   await record(connection,request.actorId??request.user.id,'credit.grant',id,{currency:input.currency,enabled:input.enabled,limitCents:input.limitCents,billingDay:input.billingDay,repaymentDays:input.repaymentDays,note:input.note});return balance(connection,id,input.currency); // 返回实际额度
  });
 }
 @Post('invoices/:id/pay-credit') async pay(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const proof=read(z.object({password:z.string().min(1).max(128),...factorFields}).strict(),body);await verifyIdentity(request,proof,'credit.pay'); // 主账号本人确认借款
  return transaction(async connection=>{
   const target=(await connection.query('SELECT order_id FROM invoices WHERE id=$1 AND user_id=$2',[id,request.user.id])).rows[0];if(!target)throw new NotFoundException('账单不存在'); // 不暴露其他客户欠款
   await connection.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[target.order_id]);const invoice=(await connection.query('SELECT i.*,o.kind FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=$1 FOR UPDATE OF i',[id])).rows[0]; // 与余额/现金使用相同订单账单锁
   await assertInvoiceUncombined(connection,id); // 信用付款不能越过合并父单
   if((await connection.query('SELECT id FROM credit_payments WHERE invoice_id=$1',[id])).rowCount)return {ok:true,invoiceId:id,status:'paid'}; // 完整资金记录重试不再借用
   if(invoice.status!=='unpaid'||!['new','renew','upgrade'].includes(invoice.kind))throw new ConflictException('信用只能支付尚未结清的业务账单'); // 禁止借款充值或借款还款
   await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${request.user.id}`]);const account=await balance(connection,request.user.id,invoice.currency); // 同一客户并发不能挤占同一额度
   if(!account.enabled||BigInt(account.availableCents)<BigInt(invoice.amount_cents))throw new ConflictException('信用未启用或可用额度不足'); // 授信不是透支承诺
   const overdue=await connection.query("SELECT 1 FROM credit_payments p WHERE p.user_id=$1 AND p.due_at<now() AND NOT EXISTS(SELECT 1 FROM credit_repayment_items r JOIN invoices i ON i.order_id=r.order_id WHERE r.payment_id=p.id AND i.status='paid') LIMIT 1",[request.user.id]);if(overdue.rowCount)throw new ConflictException('请先结清已到期的信用欠款'); // 到期欠款不得继续借用
   const payment=(await connection.query("INSERT INTO credit_payments(invoice_id,user_id,amount_cents,currency,bill_at,due_at) SELECT $1,$2,$3,$4,bill,bill+make_interval(days=>$6::int) FROM (SELECT date_trunc('month',now())+CASE WHEN extract(day FROM now())>=$5::int THEN interval '1 month' ELSE interval '0 month' END+make_interval(days=>$5::int-1) AS bill) d RETURNING id",[id,request.user.id,invoice.amount_cents,invoice.currency,account.billingDay,account.repaymentDays])).rows[0]; // 每次付款保存当时账期
   const ledger=(await connection.query('INSERT INTO ledger_transactions(credit_payment_id,currency) VALUES($1,$2) RETURNING id',[payment.id,invoice.currency])).rows[0];await connection.query('INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',[ledger.id,`receivable:${request.user.id}`,invoice.amount_cents,`income:${request.user.id}`,(-BigInt(invoice.amount_cents)).toString()]); // 应收款增加而不是增加钱包或现金
   await connection.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1",[id]);await connection.query("UPDATE orders SET status='paid' WHERE id=$1",[invoice.order_id]);await fulfill(connection,invoice,false); // 无法实际交付则整笔信用借用回滚
   await record(connection,request.actorId??request.user.id,'credit.pay',id,{creditPaymentId:payment.id,amountCents:invoice.amount_cents});return {ok:true,invoiceId:id,status:'paid'}; // 供应商任务和应收款同事务
  });
 }
 @Post('credit/repayments') async prepay(@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest) {
  const input=read(z.object({currency:currencyCode.default('CNY')}).strict(),body);const token=read(z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),key); // 提前结清全部尚未归集占用，不自报债务金额
  return transaction(async connection=>{
   await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${request.user.id}:${token}`]);await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${request.user.id}`]); // 幂等键与客户信用锁统一顺序
   const prior=(await connection.query('SELECT o.id,o.kind,o.currency,i.id AS "invoiceId",o.amount_cents::text AS "amountCents",o.status FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.idempotency_key=$2',[request.user.id,token])).rows[0];if(prior){if(prior.kind!=='credit_repayment'||prior.currency!==input.currency)throw new ConflictException('提交标识已用于其他订单');return prior;} // 超时重试返回原账单
   const lines=await unbilled(connection,request.user.id,false,new Date(),input.currency);if(!lines.length)throw new ConflictException('没有未归集的信用占用，请查看已有还款账单');return repayment(connection,request.user.id,lines,token); // 已有还款单不会重复开票
  });
 }
 /** @returns 本轮实际生成的月结账单数量。 */
 async run(at=new Date()):Promise<number> {
  if(this.running)return 0;this.running=true;let count=0;          // 进程内不堆叠，客户锁保证多进程一致
  try {
   const customers=await pool.query(`SELECT DISTINCT p.user_id,p.currency FROM credit_payments p WHERE p.bill_at<=$1::timestamptz AND ${unbilledPayment} ORDER BY p.user_id,p.currency LIMIT 50`,[at]); // 有界轮询到期事实
   for(const row of customers.rows)await transaction(async connection=>{
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${row.user_id}`]);const lines=await unbilled(connection,row.user_id,true,at,row.currency);if(!lines.length)return; // 已被其他节点归集则跳过
    const token='credit_cycle_'+createHash('sha256').update(lines.map(line=>line.id).join(',')).digest('hex');const order=await repayment(connection,row.user_id,lines,token);await notify(connection,row.user_id,'信用还款账单已生成','请在约定还款日前结清账单；实际到账后才恢复可用额度。',`/console/invoices/${order.invoiceId}`);count++; // 自动只出账单，不能凭空结清
   });return count;
  } finally {this.running=false;}                               // 失败后下一轮仍可按原事实恢复
 }
}
