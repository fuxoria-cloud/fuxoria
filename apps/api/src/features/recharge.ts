/* 余额充值：生成没有商品/资源的充值账单，真实支付收款后记公司钱包负债。
 * 调用：POST /wallet/recharges {amountCents:'10000'} + Idempotency-Key；之后走已有真实收银台。
 * 钱包不能给自己充值；退款仍走原支付机构，并先占用可用余额。
 */
import { currencyCode,currencyDefinition } from './currency.js';
import { payments } from './payment.js';
import { Body,Controller,Get,Post,Headers,Req,ConflictException } from '@nestjs/common'; // 正常账单和充值账单共用收银台
import { createHash } from 'node:crypto';                         // 幂等键绑定实际金额
import { z } from 'zod';                                         // 用户提交整数分
import { pool,transaction } from './store.js';                    // 充值单与审计同时保存
import { record } from './audit.js';                             // 不把生成账单当成已充值
import { read,money } from '../utils/input.js';                  // 共用整数分边界
import type { SessionRequest } from '../utils/access.js';         // 不允许替其他客户创建充值

@Controller('wallet/recharges')
export default class Recharge {
 /** @returns 本账号充值历史，状态来自真实账单。 */
 @Get() async list(@Req() request:SessionRequest) {
  return (await pool.query('SELECT o.id,i.id AS "invoiceId",o.amount_cents::text AS "amountCents",o.currency,o.status,o.created_at AS "createdAt",i.paid_at AS "paidAt" FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.kind=\'recharge\' ORDER BY o.created_at DESC LIMIT 100',[request.user.id])).rows; // 只有实际已付才增加余额
 }
 /** @returns 新账单或相同提交的原账单。 */
 @Post() async create(@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest) {
  const input=read(z.object({currency:currencyCode.default('CNY'),amountCents:money.refine(value=>BigInt(value)>=100n&&BigInt(value)<=100000000n,'充值金额须在1元至100万元之间')}).strict(),body);const token=read(z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),key); // 交易金额不使用浮点
  const fingerprint=createHash('sha256').update('recharge:'+input.amountCents+(input.currency==='CNY'?'':':'+input.currency)).digest('hex'); // 和其他订单共用幂等命名空间
  return transaction(async connection=>{
   await currencyDefinition(connection,input.currency,true);if(input.currency!=='CNY'&&!payments?.list().some(item=>item.configured&&item.currencies.includes(input.currency)))throw new ConflictException('当前没有配置支持该币种的充值渠道');
   await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${request.user.id}:${token}`]); // 重试串行核对
   const prior=await connection.query('SELECT o.id,o.request_hash,i.id AS "invoiceId",o.amount_cents::text AS "amountCents",o.currency,o.status FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.idempotency_key=$2',[request.user.id,token]); // 相同键不能用于另一次充值
   if(prior.rowCount){if(prior.rows[0].request_hash!==fingerprint)throw new ConflictException('此提交标识已用于其他订单');const {request_hash,...saved}=prior.rows[0];return saved;} // 不重复创建负债
   const order=(await connection.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,kind,items_explicit,currency) VALUES($1,NULL,$2,$3,$4,'recharge',true,$5) RETURNING id,status",[request.user.id,token,fingerprint,input.amountCents,input.currency])).rows[0]; // 没有虚构商品
   await connection.query("INSERT INTO order_items(order_id,product_id,product_name,quantity,period,billing_months,unit_price_cents,original_unit_price_cents,amount_cents) VALUES($1,NULL,'账户余额充值',1,'onetime',0,$2,$2,$2)",[order.id,input.amountCents]); // 保留实际成交金额快照
   const invoice=(await connection.query('INSERT INTO invoices(order_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4) RETURNING id',[order.id,request.user.id,input.amountCents,input.currency])).rows[0]; // 只有支付成功才增加钱包
   await record(connection,request.actorId??request.user.id,'wallet.recharge_created',order.id,{invoiceId:invoice.id,amountCents:input.amountCents,currency:input.currency});return {...order,invoiceId:invoice.id,amountCents:input.amountCents,currency:input.currency}; // 财务状态仍未付
  });
 }
}
