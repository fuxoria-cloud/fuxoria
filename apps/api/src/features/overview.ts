/* 工作台：聚合当前客户的服务、账单和工单，展示最近真实数据。
 * 调用：GET /api/v1/overview，浏览器必须带会话Cookie。
 */
import { funds } from './wallet.js';
import { Controller, Get, Req } from '@nestjs/common';             // 只读业务入口
import { pool } from './store.js';                                 // 不另存可漂移的统计余额
import { serviceColumns } from './service.js';                     // 总览与服务列表共用付款和在途操作语义
import type { SessionRequest } from '../utils/access.js';           // 身份由统一边界提供

@Controller('overview')
export default class Overview {
  /** @returns 账号级汇总和最近记录。 */
  @Get() async get(@Req() request:SessionRequest) {
    const values=[request.user.id];                                // 所有查询固定到当前账号
    const [totals,invoices,services,balance]=await Promise.all([
      pool.query("SELECT (SELECT count(*)::int FROM services WHERE COALESCE(current_owner_id,user_id)=$1 AND status NOT IN ('cancelled','failed')) AS \"serviceCount\",(SELECT count(*)::int FROM invoices WHERE user_id=$1 AND status='unpaid') AS \"unpaidCount\",(SELECT count(*)::int FROM tickets WHERE user_id=$1 AND status!='closed') AS \"ticketCount\"",values), // 统计直接从事实表计算
      pool.query('SELECT id,number::text,amount_cents::text AS "amountCents",currency,(SELECT decimals FROM currencies WHERE code=currency) AS "currencyDecimals",status,due_at AS "dueAt",created_at AS "createdAt" FROM invoices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',values), // 最近账单用于快速继续付款
      pool.query(`SELECT ${serviceColumns} FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE COALESCE(s.current_owner_id,s.user_id)=$1 ORDER BY s.created_at DESC LIMIT 5`,values), // 未付款不能在总览里被误写成正在开通
      pool.query("SELECT t.currency,(-COALESCE(sum(e.amount_cents),0))::text AS amount FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='wallet:'||$1::text GROUP BY t.currency ORDER BY t.currency",values) // 用户余额是公司负债，贷方分录取负号展示
    ]);
    return {...totals.rows[0],balanceCents:balance.rows.find(row=>row.currency==='CNY')?.amount??'0',currency:'CNY',totals:await Promise.all(balance.rows.map(async row=>{const available=await funds(pool,request.user.id,row.currency);return {currency:row.currency,currencyDecimals:available.currencyDecimals,walletCents:available.balanceCents,heldCents:available.heldCents,availableCents:available.availableCents};})),recentInvoices:invoices.rows,recentServices:services.rows}; // 余额由账本事实计算，不维护另一份可漂移的数字
  }
}
