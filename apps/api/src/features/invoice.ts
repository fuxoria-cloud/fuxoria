/* 账单：客户只能读取自己的应付记录；结算金额来自订单快照。
 * 调用：GET /api/v1/invoices；GET /api/v1/invoices/:id。
 */
import { Controller, Get, Param, Req, NotFoundException } from '@nestjs/common'; // 业务入口负责范围限制
import { pool } from './store.js';                                 // 账单只从数据库读取
import { orderItems } from './order.js';                           // 同一处读取真实成交项，避免商品改价后账单跟着变化
import { read, uuid } from '../utils/input.js';                     // 验证账单ID
import type { SessionRequest } from '../utils/access.js';           // 使用已认证的客户ID

export const invoiceColumns=`i.id,i.number::text,i.order_id AS "orderId",i.amount_cents::text AS "amountCents",i.currency,(SELECT decimals FROM currencies WHERE code=i.currency) AS "currencyDecimals",i.status,i.due_at AS "dueAt",i.paid_at AS "paidAt",i.created_at AS "createdAt",COALESCE(p.name,'账户余额充值') AS "productName",o.kind,COALESCE((SELECT enabled FROM credit_accounts WHERE user_id=i.user_id AND currency=i.currency),false) AND o.kind IN ('new','renew','upgrade') AS "creditEligible",EXISTS(SELECT 1 FROM credit_payments WHERE invoice_id=i.id) AS "paidWithCredit",(o.kind<>'credit_repayment' AND EXISTS(SELECT 1 FROM payment_receipts WHERE invoice_id=i.id)) AS refundable,(SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=i.id AND locked) AS "combinedParentId",(SELECT count(*)::int FROM combined_invoice_items WHERE parent_invoice_id=i.id) AS "combinedCount",
  (i.status='unpaid' AND NOT EXISTS(SELECT 1 FROM combined_invoice_items WHERE invoice_id=i.id AND locked) AND (o.kind<>'renew' OR (s.status IN ('active','suspended') AND s.termination_requested_at IS NULL AND COALESCE(s.current_owner_id,s.user_id)=i.user_id))) AS payable,
  CASE WHEN EXISTS(SELECT 1 FROM combined_invoice_items WHERE invoice_id=i.id AND locked) THEN '此账单已合并，请打开合并父账单付款或核对退款' WHEN o.kind='renew' AND (s.status NOT IN ('active','suspended') OR s.termination_requested_at IS NOT NULL OR COALESCE(s.current_owner_id,s.user_id)<>i.user_id) THEN '此服务已终止或正在终止，请联系服务商核对这张续费账单' ELSE NULL END AS "paymentMessage",
  CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_build_object('id',b.id,'reason',b.reason,'status',b.status,'resolution',b.resolution,'createdAt',b.created_at,'resolvedAt',b.resolved_at) END AS "billingReview"`; // 账单状态与资源是否仍能交付分别表达
const source='FROM invoices i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.id=o.product_id LEFT JOIN renewals r ON r.order_id=o.id LEFT JOIN services s ON s.id=r.service_id LEFT JOIN billing_reviews b ON b.invoice_id=i.id'; // 续费只关联原资源，不从当前商品推测是否可交付

/** @param rows 已限制当前账号的账单。@returns 带完整成交明细的账单。 */
async function details(rows:Record<string,any>[]) {
  const items=await orderItems(pool,rows.map(row=>row.orderId));    // 一次查询全部行，列表不产生逐单查询
  const combined=await pool.query('SELECT x.parent_invoice_id AS parent,i.id,i.number::text,i.amount_cents::text AS "amountCents",i.status FROM combined_invoice_items x JOIN invoices i ON i.id=x.invoice_id WHERE x.parent_invoice_id=ANY($1::uuid[]) ORDER BY x.parent_invoice_id,x.position',[rows.map(row=>row.id)]); // 一次读取合并父单的全部原始账单
  return rows.map(row=>({...row,combinedItems:combined.rows.filter(item=>item.parent===row.id).map(({parent,...item})=>item),productName:items.get(row.orderId)?.[0]?.productName ?? row.productName,items:items.get(row.orderId) ?? [],itemCount:(items.get(row.orderId) ?? []).reduce((sum,item)=>sum+item.quantity,0)})); // 旧接口首件名称保留兼容，多项数量明确返回
}

@Controller('invoices')
export default class Invoice {
  /** @returns 当前账号最近的账单。 */
  @Get() async list(@Req() request:SessionRequest) {
    return details((await pool.query(`SELECT ${invoiceColumns} ${source} WHERE i.user_id=$1 ORDER BY i.created_at DESC LIMIT 100`,[request.user.id])).rows); // 不向公共缓存发送私有账单
  }

  /** @param id 账单ID。@returns 当前客户的账单详情。 */
  @Get(':id') async get(@Param('id') id:string,@Req() request:SessionRequest) {
    const result=await pool.query(`SELECT ${invoiceColumns} ${source} WHERE i.id=$1 AND i.user_id=$2`,[read(uuid,id),request.user.id]); // 所有权是查询条件的一部分
    if (!result.rowCount) throw new NotFoundException('账单不存在'); // 跨账号访问统一视为不存在
    return (await details(result.rows))[0];                        // 金额始终以字符串分传输
  }
}
