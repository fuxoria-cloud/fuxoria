/* 主动对账：管理员向原支付机构查单，验签结果完全匹配本地账单后复用唯一入账事务。
 * 调用：POST /api/v1/admin/invoices/:id/reconcile {}；多个支付尝试时传 {gateway:'wechat'}。
 * 流水：GET /api/v1/admin/receipts?page=1&limit=50，页长最多200。
 * 机构不支持验签查询时如实返回unsupported，不根据浏览器跳转或本地猜测补入账。
 */
import { Body, Controller, Get, Param, Post, Query, Req, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'; // HTTP只承接明确的管理员动作
import { z } from 'zod';                                          // 查单目标与分页都是外部输入
import type { PaymentResult } from '@fuxoria/payments';             // 支付机构的已验签结果
import { pool, transaction } from './store.js';                    // 本地账单金额只有数据库一份来源
import { payments } from './payment.js';                          // 查单只能使用已发现的原通道
import { settle } from './settlement.js';                          // 主动补偿和通知共用入账主线
import { record } from './audit.js';                              // 保留管理员或调度的查单结果
import { Roles, type SessionRequest } from '../utils/access.js';   // 普通客户不能读取所有支付流水
import { read, uuid } from '../utils/input.js';                    // 拒绝错误的业务标识

// --- 记录查单结果，不把机构HTTP调用放进数据库事务 ---
async function evidence(actor: string, id: string, gateway: string, status: string, details: object) {
  await transaction(connection=>record(connection,actor,'payment.reconcile',id,{gateway,providerStatus:status,...details})); // 不记录机构密钥或未脱敏正文
}

/** @param id 本地账单ID。@param actor 管理员或调度标识。@param gateway 可选的原支付通道。@returns 真实查询状态和是否已入账。 */
export async function reconcileInvoice(id: string, actor: string, gateway?: string) {
  read(uuid,id);                                                  // 调度调用也不能绕过本地UUID规则
  const found = await pool.query('SELECT i.*,p.gateway AS receipt_gateway FROM invoices i LEFT JOIN payment_receipts p ON p.invoice_id=i.id WHERE i.id=$1',[id]); // 本地成交价固定，不接受客户端金额
  if (!found.rowCount) throw new NotFoundException('账单不存在'); // 未知商户订单号不能补账
  const invoice = found.rows[0];                                 // 机构查询期间不持有资金锁
  if (invoice.import_id) {
    await evidence(actor,id,gateway ?? invoice.receipt_gateway ?? 'imported','historical_reference_required',{reason:'原商户订单号尚未核对，不能用新账单UUID查询旧支付'}); // 原系统临时支付单号不能根据新UUID推算
    return {invoiceId:id,gateway:gateway ?? invoice.receipt_gateway ?? 'imported',providerStatus:'historical_reference_required',settled:false,message:'历史账单需先核对原商户订单号，请从原支付商户后台核对；未向机构发出查询'}; // 不把订单未找到冒充历史支付真实状态
  }
  const attempts = await pool.query('SELECT gateway FROM payment_attempts WHERE invoice_id=$1 ORDER BY created_at,gateway',[id]); // 只认账单真实发起过的渠道
  const selected = gateway ?? invoice.receipt_gateway ?? (attempts.rowCount===1 ? attempts.rows[0].gateway : undefined); // 已收款账单优先查询原收款通道
  if (!selected) throw new ConflictException(attempts.rowCount ? '此账单尝试过多个渠道，请指定gateway后查询' : '此账单还没有发起支付'); // 不随机挑通道认账
  if (!attempts.rows.some(attempt=>attempt.gateway===selected)) throw new BadRequestException('此账单没有通过该渠道发起支付'); // 不给任意机构订单号碰撞本地账单的机会
  let result: PaymentResult;                                      // 机构错误与数据库错误分别处理
  try {
    const plugin = payments.get(selected);                        // 通道与原支付意图匹配
    if (!plugin.configured || !plugin.query || !(plugin.currencies??['CNY']).includes(invoice.currency)) throw Object.assign(new Error('此支付渠道没有已配置的验签查单接口，请从商户后台核对'),{status:501}); // 能力不足不伪造未付款
    result = await plugin.query({invoiceId:id});                  // 支付插件验证平台签名与收款身份
  } catch (error) {
    const failure = error as {status?:number;message?:string};     // 这里只包含机构查询边界的异常
    const message = (failure.message ?? '支付机构查询暂时不可用').replace(/[\u0000-\u001f]/g,' ').slice(0,500); // 不把超长机构响应塞进日志
    const providerStatus = failure.status===501 ? 'unsupported' : 'unverified'; // 未验证的结果不能改任何资金事实
    await evidence(actor,id,selected,providerStatus,{reason:message}); // 失败查询也可定位是谁触发
    return {invoiceId:id,gateway:selected,providerStatus,settled:false,message}; // 界面能明确区分能力不足与未付款
  }
  if (result.invoiceId!==id || result.amountCents!==invoice.amount_cents || result.currency!==invoice.currency) {
    await evidence(actor,id,selected,'mismatch',{expectedAmountCents:invoice.amount_cents,receivedInvoiceId:result.invoiceId,receivedAmountCents:result.amountCents,receivedCurrency:result.currency}); // 记录可核对的机构与本地差异
    throw new BadRequestException('机构查询的账单号、金额或币种与本地账单不一致'); // 即使签名有效也不代表可以入账
  }
  if (!result.paid) {
    await evidence(actor,id,selected,'not_paid',{transactionId:result.transactionId}); // 不把本地unpaid当作机构状态
    return {invoiceId:id,gateway:selected,providerStatus:'not_paid',settled:false}; // 已关闭或待付款均不会产生分录
  }
  if (!result.transactionId) throw new BadRequestException('机构查询的成功付款缺少交易号'); // 数据库唯一约束必须有真实机构流水
  await settle(selected,result);                                 // 收款锁、金额核对、借贷分录、审计和任务都走原事务
  await evidence(actor,id,selected,'paid',{transactionId:result.transactionId,amountCents:result.amountCents,currency:result.currency}); // 补偿来源单独留痕，不重复记账
  return {invoiceId:id,gateway:selected,providerStatus:'paid',settled:true}; // 资金提交后才向管理员显示完成
}

@Controller('admin') @Roles('admin')
export default class Reconciliation {
  /** @param query 分页和可选核对状态。@returns 已收款但资源无法续费的明确核对清单。 */
  @Get('billing-reviews') async reviews(@Query() query:unknown) {
    const input=read(z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),limit:z.coerce.number().int().min(1).max(200).default(50),status:z.enum(['open','resolved']).optional()}).strict(),query); // 管理员不能把无界清单一次读入浏览器
    const items=await pool.query(`SELECT b.id,b.invoice_id AS "invoiceId",i.number::text AS "invoiceNumber",i.user_id AS "userId",u.email,b.service_id AS "serviceId",s.name AS "serviceName",s.status AS "serviceStatus",b.reason,b.status,b.resolution,b.created_at AS "createdAt",b.resolved_at AS "resolvedAt",p.id AS "receiptId",p.gateway,p.amount_cents::text AS "amountCents",p.currency FROM billing_reviews b JOIN invoices i ON i.id=b.invoice_id JOIN users u ON u.id=i.user_id JOIN services s ON s.id=b.service_id JOIN payment_receipts p ON p.invoice_id=i.id WHERE ($1::text IS NULL OR b.status=$1) ORDER BY b.created_at DESC,b.id LIMIT $2 OFFSET $3`,[input.status ?? null,input.limit,(input.page-1)*input.limit]); // 现金事实与原资源同列，不能将核对当作已退款
    const count=await pool.query('SELECT count(*)::int AS total FROM billing_reviews WHERE ($1::text IS NULL OR status=$1)',[input.status ?? null]); // 全额退款真正成功后refund主体关闭此核对
    return {items:items.rows,total:count.rows[0].total,page:input.page,limit:input.limit}; // 不提供忽略资金事实的手工清空入口
  }

  /** @param id 本地账单。@param body 可选原支付通道。@returns 已验签的实际机构结果。 */
  @Post('invoices/:id/reconcile') reconcile(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    const input = read(z.object({gateway:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).optional()}).strict(),body ?? {}); // 不接受金额或是否已付款等自报字段
    return reconcileInvoice(id,request.user.id,input.gateway);     // 接口没有手工标记已付款开关
  }

  /** @param query 页码和页长。@returns 实际收款、成功退款和已占用可退额度。 */
  @Get('receipts') async receipts(@Query() query:unknown) {
    const input = read(z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),limit:z.coerce.number().int().min(1).max(200).default(50)}).strict(),query); // 限制一次读取的流水数量
    const items = await pool.query(`SELECT p.id,p.invoice_id AS "invoiceId",i.number::text AS "invoiceNumber",i.user_id AS "userId",u.email,p.gateway,p.transaction_id AS "transactionId",p.amount_cents::text AS "amountCents",p.currency,(SELECT decimals FROM currencies WHERE code=p.currency) AS "currencyDecimals",p.created_at AS "createdAt",COALESCE(r.succeeded,0)::text AS "refundedCents",COALESCE(r.reserved,0)::text AS "reservedCents",(p.amount_cents-COALESCE(r.reserved,0))::text AS "refundableCents" FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id JOIN users u ON u.id=i.user_id LEFT JOIN LATERAL (SELECT sum(amount_cents) FILTER(WHERE status='succeeded') AS succeeded,sum(amount_cents) FILTER(WHERE status NOT IN ('rejected','failed')) AS reserved FROM refunds WHERE receipt_id=p.id) r ON true ORDER BY p.created_at DESC,p.id LIMIT $1 OFFSET $2`,[input.limit,(input.page-1)*input.limit]); // 所有金额来自不可变收款和退款事实
    const count = await pool.query('SELECT count(*)::int AS total FROM payment_receipts'); // 分页总数不依赖客户端
    return {items:items.rows,total:count.rows[0].total,page:input.page,limit:input.limit}; // 明确区分已退款与仍待处理的占额
  }
}
