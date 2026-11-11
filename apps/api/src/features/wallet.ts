/* 账户余额：读取真实负债分录，使用已有余额结清自己的账单。
 * 调用：GET /api/v1/wallet；POST /invoices/:id/pay-wallet，带本站Origin与会话。
 * 账单ID本身就是支付幂等键；不信任浏览器自报余额或应付金额。
 */
import { Controller,Get,Post,Param,Query,Req,ConflictException,NotFoundException } from '@nestjs/common'; // 余额沿用统一会话和CSRF边界
import { z } from 'zod';                                          // 记录分页只接受有界页码
import { pool,transaction } from './store.js';                    // 余额只从账本计算
import { assertInvoiceUncombined } from './combined.js';          // 合并子单不能独立重复付款
import { fulfill } from './settlement.js';                        // 已付款资源动作只有一个来源
import { record } from './audit.js';                              // 钱包支出与资金审计一起提交
import { captureCommission } from './affiliate.js';               // 真实业务余额支付同样按规则留存待释放佣金
import { renewalWindowSQL } from './catalogue.js';
import { captureSales } from './sales.js';                         // 员工销售与真实余额业务收款同事务计提
import { read,uuid } from '../utils/input.js';                     // 目标和分页在边界验证
import type { SessionRequest } from '../utils/access.js';          // 身份只来自认证边界

/** @param connection 数据库连接。@param userId 钱包归属。@returns 总余额、退款占额和实际可用金额。 */
export async function funds(connection:Pick<typeof pool,'query'>,userId:string,currency='CNY') {
  const found=await connection.query(`SELECT (SELECT decimals FROM currencies WHERE code=$2) AS "currencyDecimals",(-COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='wallet:'||$1::text AND t.currency=$2),0))::text AS balance,
    COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id WHERE r.user_id=$1::uuid AND r.currency=$2 AND o.kind='recharge' AND r.status NOT IN ('rejected','failed','succeeded')),0)::text AS held`,[userId,currency]); // 退款未知或待审批仍保留额度
  const row=found.rows[0];return {currencyDecimals:row.currencyDecimals,balanceCents:row.balance,heldCents:row.held,availableCents:(BigInt(row.balance)-BigInt(row.held)).toString()}; // 可用余额只做整数减法
}

@Controller()
export default class Wallet {
  /** @returns 当前余额，单位为分。 */
  @Get('wallet') async get(@Req() request:SessionRequest) {
    const currencies=(await pool.query('SELECT code FROM currencies WHERE active OR code IN(SELECT t.currency FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account=$1) ORDER BY code',[`wallet:${request.user.id}`])).rows;return {...await funds(pool,request.user.id),currency:'CNY',totals:await Promise.all(currencies.map(async row=>({...await funds(pool,request.user.id,row.code),currency:row.code})))}; // 总余额和冻结额度分开呈现

  }

  /** @param page 页码。@returns 可核对的余额变化明细。 */
  @Get('wallet/history') async history(@Query('page') page:unknown,@Req() request:SessionRequest) {
    const number=read(z.coerce.number().int().min(1).max(100000).default(1),page); // 防止无限制导出
    return (await pool.query(`SELECT e.id::text,(-e.amount_cents)::text AS "amountCents",t.id AS "transactionId",t.currency,(SELECT decimals FROM currencies WHERE code=t.currency) AS "currencyDecimals",t.created_at AS "createdAt",COALESCE(w.invoice_id,p.invoice_id,ref.invoice_id) AS "invoiceId",CASE WHEN t.refund_id IS NOT NULL THEN 'recharge_refund' WHEN p.id IS NOT NULL THEN 'recharge' WHEN w.id IS NOT NULL THEN 'payment' ELSE 'other' END AS kind,t.opening_balance_id AS "openingBalanceId" FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id LEFT JOIN payment_receipts p ON p.id=t.receipt_id LEFT JOIN refunds r ON r.id=t.refund_id LEFT JOIN payment_receipts ref ON ref.id=r.receipt_id WHERE e.account=$1 ORDER BY e.id DESC LIMIT 50 OFFSET $2`,[`wallet:${request.user.id}`,(number-1)*50])).rows; // 原记录只读，不允许覆盖历史
  }

  /** @param id 自己的未付账单。@returns 已结清账单以及剩余余额。 */
  @Post('invoices/:id/pay-wallet') async pay(@Param('id') id:string,@Req() request:SessionRequest,automatic?:{serviceId:string;dueAt:string}) {
    read(uuid,id);                                                 // 不允许用金额或其它对象替代账单ID
    return transaction(async connection=>{
      const found=await connection.query('SELECT order_id FROM invoices WHERE id=$1 AND user_id=$2',[id,request.user.id]); // 查询与支付始终限定本人
      if (!found.rowCount) throw new NotFoundException('账单不存在'); // 不暴露其它账号的账单
      await connection.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[found.rows[0].order_id]); // 与外部回调、取消保持同样锁顺序
      const locked=await connection.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[id]); // 同一账单只有一种支付先胜出
      await assertInvoiceUncombined(connection,id); // 合并归属已在同一账单锁下核对
      const invoice=locked.rows[0];                                // 锁定后重新读取付款状态
      const prior=await connection.query('SELECT w.id,t.id AS ledger_id,(SELECT count(*)::int FROM ledger_entries WHERE transaction_id=t.id) AS entry_count FROM wallet_payments w LEFT JOIN ledger_transactions t ON t.wallet_payment_id=w.id WHERE w.invoice_id=$1',[id]); // 幂等成功以匹配的真实会计事务为准
      if (prior.rowCount) {
        if (invoice.status!=='paid' || !prior.rows[0].ledger_id || prior.rows[0].entry_count!==2) throw new ConflictException('这张账单的余额记录需要核对，请联系服务商'); // 孤立支付标记不能伪装成已付款
        return {ok:true,invoiceId:id,status:'paid'};                 // 完整入账重试不会再次扣除钱包
      }
      if(automatic) {
        const authorized=await connection.query(`SELECT id FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 AND auto_renew AND due_at=$3::timestamptz AND termination_requested_at IS NULL AND billing_period NOT IN ('ontrial','onetime') AND (billing_months>0 OR billing_seconds>0) AND due_at<=now()+make_interval(secs=>${renewalWindowSQL()}) FOR UPDATE`,[automatic.serviceId,request.user.id,automatic.dueAt]); // 扣款事务内重查本人授权，转移/关闭后不能继续扣旧钱包
        if(!(await connection.query('SELECT id FROM users WHERE id=$1 AND NOT disabled FOR SHARE',[request.user.id])).rowCount)throw new ConflictException('账号已停用，自动续费授权不可用'); // 扣款事务持有账号共享锁，停用提交后不能继续花旧钱包
        if(!authorized.rowCount)throw new ConflictException('自动续费授权或到期日已变化'); // 只留下可人工核对的未付账单
      }
      const purchase=(await connection.query('SELECT kind FROM orders WHERE id=$1',[invoice.order_id])).rows[0]; // 还款冲销应收，充值不可自循环
      if(purchase.kind==='credit_repayment')await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${request.user.id}`]); // 和信用借用使用同一客户锁
      if(purchase.kind==='recharge')throw new ConflictException('充值请使用支付机构付款，不能用余额给自己充值'); // 负债不能自循环增加
      if (invoice.status!=='unpaid') throw new ConflictException('此账单当前无需付款'); // 已付或取消账单不再扣款
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet:${request.user.id}`]); // 钱包独立串行，不阻塞持服务锁的续费对账号外键的核对
      const available=await funds(connection,request.user.id,invoice.currency); // 持锁后读取可用金额
      if (BigInt(available.availableCents)<BigInt(invoice.amount_cents)) throw new ConflictException('账户余额不足，请选择其它支付方式'); // 不透支、不收取部分款项
      const payment=await connection.query('INSERT INTO wallet_payments(invoice_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4) RETURNING id',[id,request.user.id,invoice.amount_cents,invoice.currency]); // 账单唯一约束保证付款幂等
      const ledger=await connection.query('INSERT INTO ledger_transactions(wallet_payment_id,currency) VALUES($1,$2) RETURNING id',[payment.rows[0].id,invoice.currency]); // 钱包支付不伪装成支付机构现金收款
      await connection.query('INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',[ledger.rows[0].id,`wallet:${request.user.id}`,invoice.amount_cents,`${purchase.kind==='credit_repayment'?'receivable':'income'}:${request.user.id}`,(-BigInt(invoice.amount_cents)).toString()]); // 客户负债减少，收入增加，借贷仍平衡
      await connection.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1",[id]); // 账单状态与钱一同提交
      await connection.query("UPDATE orders SET status='paid' WHERE id=$1",[invoice.order_id]); // 不提前向资源进程发布成功
      await fulfill(connection,invoice,false);                     // 无法交付的旧续费会原子回滚钱包扣款
      await captureCommission(connection,invoice.id);               // 佣金不由浏览器自报
      await captureSales(connection,invoice.id);
      await record(connection,request.actorId??request.user.id,'wallet.pay',id,{walletPaymentId:payment.rows[0].id,amountCents:invoice.amount_cents,currency:invoice.currency}); // 能从钱包明细追到原账单
      return {ok:true,invoiceId:id,status:'paid',balanceCents:(BigInt(available.balanceCents)-BigInt(invoice.amount_cents)).toString()}; // 余额只经过整数减法
    });
  }
}
