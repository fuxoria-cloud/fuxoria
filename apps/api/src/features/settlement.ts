/* 入账：验签后的支付结果在同一事务内结清账单、写双分录、写审计并投递开通任务。
 * 调用：await settle('wechat', verifiedResult)。外部通知只能经payment.ts验签后到这里。
 * 每张账单只允许一个成功收款；同渠道同交易号的重复通知返回原结果。
 */
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common'; // 明确区分错误通知和系统故障
import type { PaymentResult } from '@fuxoria/payments';             // 只接收插件完成验签后的结果
import type { PoolClient } from 'pg';                             // 交付动作复用调用方的资金事务
import { transaction } from './store.js';                         // 支付事实只落在PostgreSQL
import { fulfillCombined } from './combined.js';                 // 父单只收一次钱，子单同事务交付
import { fulfillUpgrade } from './upgrade.js';                   // 配置变更也只在真实任务完成后生效
import { record } from './audit.js';                              // 资金变更携带完整审计链
import { captureCommission } from './affiliate.js';               // 真实业务账单付款时冻结推荐规则
import { captureSales } from './sales.js';                        // 员工销售按同一真实资金来源冻结独立币种佣金

/** @param gateway 已验签支付插件名。@param result 已验签且身份校验通过的通知。@returns 入账成功。 */
export async function settle(gateway:string,result:PaymentResult):Promise<{ok:boolean}> {
  if (!result.paid) throw new BadRequestException('支付尚未成功');   // 未成功交易不产生资金分录
  return transaction(async connection=>{
    const invoiceResult=await connection.query('SELECT i.* FROM invoices i WHERE i.id=$1',[result.invoiceId]); // 先找到所属订单以保持锁顺序一致
    if (!invoiceResult.rowCount) throw new NotFoundException('账单不存在'); // 不接受未知商户单号
    await connection.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[invoiceResult.rows[0].order_id]); // 与订单取消使用相同锁顺序
    const locked=await connection.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[result.invoiceId]); // 串行处理同账单的所有通知
    const invoice=locked.rows[0];                                 // 重新读取锁定后的账单状态
    const receipt=await connection.query('SELECT * FROM payment_receipts WHERE invoice_id=$1',[invoice.id]); // 重试只承认原来那一笔支付
    if (receipt.rowCount) {
      const saved=receipt.rows[0];                                // 同交易、同金额才是合法重放
      if (saved.gateway!==gateway || saved.transaction_id!==result.transactionId || saved.amount_cents!==result.amountCents || saved.currency!==result.currency) throw new ConflictException('此账单已由另一笔交易结清');
      return {ok:true};                                          // 不再追加分录或开通任务
    }
    if (invoice.status!=='unpaid') throw new ConflictException('此账单当前不能收款，请人工核对原路退款'); // 不将已取消订单自动复活
    if (invoice.amount_cents!==result.amountCents || invoice.currency!==result.currency) throw new BadRequestException('支付金额或币种与账单不一致'); // 验签不等于金额正确
    const attempt=await connection.query('SELECT 1 FROM payment_attempts WHERE invoice_id=$1 AND gateway=$2',[invoice.id,gateway]); // 防止其它商户订单号碰撞
    if (!attempt.rowCount) throw new BadRequestException('此账单未通过该渠道发起支付'); // 禁止跨支付方式认账
    const saved=await connection.query('INSERT INTO payment_receipts(invoice_id,gateway,transaction_id,amount_cents,currency) VALUES($1,$2,$3,$4,$5) RETURNING id',[invoice.id,gateway,result.transactionId,result.amountCents,result.currency]); // 渠道交易号唯一约束阻止跨账单重用
    const purchase=(await connection.query('SELECT kind FROM orders WHERE id=$1',[invoice.order_id])).rows[0]; // 充值收款形成客户负债，业务收款才计收入
    if(purchase.kind==='credit_repayment')await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`credit:${invoice.user_id}`]); // 实际还款与授信占用串行
    const ledger=await connection.query('INSERT INTO ledger_transactions(receipt_id,currency) VALUES($1,$2) RETURNING id',[saved.rows[0].id,result.currency]); // 一笔收款对应一笔会计事务
    await connection.query('INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',[ledger.rows[0].id,`cash:${gateway}`,result.amountCents,`${purchase.kind==='recharge'?'wallet':purchase.kind==='credit_repayment'?'receivable':'income'}:${invoice.user_id}`,(-BigInt(result.amountCents)).toString()]); // 借贷以整数分相抵，数据库延迟约束复核
    await connection.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1",[invoice.id]); // 收款、账单与分录一起提交
    await connection.query("UPDATE orders SET status='paid' WHERE id=$1",[invoice.order_id]); // 订单状态不会早于入账完成
    await fulfill(connection,invoice);                           // 外部支付与余额支付共用同一交付步骤
    await captureCommission(connection,invoice.id);               // 充值/非业务账单不会计佣
    await captureSales(connection,invoice.id);
    await record(connection,`payment:${gateway}`,'invoice.settle',invoice.id,{receiptId:saved.rows[0].id,transactionId:result.transactionId,amountCents:result.amountCents,currency:result.currency}); // 可用审计追到原渠道流水
    return {ok:true};                                             // 提交成功后通知支付机构
  });
}

/** @param connection 已入账事务的连接。@param invoice 已结清账单。@returns 对应资源已续费或持久化排队。 */
export async function fulfill(connection:PoolClient,invoice:{id:string;order_id:string},allowReview=true):Promise<void> {
  if(await fulfillCombined(connection,invoice,allowReview))return; // 合并收款不重复记各子单收入
  if((await connection.query("SELECT 1 FROM orders WHERE id=$1 AND kind='recharge'",[invoice.order_id])).rowCount)return; // 充值账单没有资源交付或续费
  if((await connection.query("SELECT 1 FROM orders WHERE id=$1 AND kind='credit_repayment'",[invoice.order_id])).rowCount) {
    const originals=await connection.query('SELECT p.invoice_id FROM credit_repayment_items r JOIN credit_payments p ON p.id=r.payment_id WHERE r.order_id=$1 ORDER BY p.invoice_id',[invoice.order_id]); // 实际还款后才允许重新评估原业务佣金
    for(const row of originals.rows){await captureCommission(connection,row.invoice_id);await captureSales(connection,row.invoice_id);}return; // 还款后才允许原业务计提
  }
  if(await fulfillUpgrade(connection,invoice,allowReview))return; // 已失效的外部升降级收款进入明确核对
  const renewed=await connection.query('SELECT r.service_id,r.period_months,r.period_seconds,o.user_id FROM renewals r JOIN orders o ON o.id=r.order_id WHERE r.order_id=$1',[invoice.order_id]); // 续费关系只定义在renewals
  if (renewed.rowCount) {
    const existing=await connection.query('SELECT id,status,termination_requested_at,COALESCE(current_owner_id,user_id) AS owner_id FROM services WHERE id=$1 FOR UPDATE',[renewed.rows[0].service_id]); // 先锁定资源再判断是否仍可实际续费
    const current=existing.rows[0];                               // 删除或正在终止的资源不能用旧账单复活
    if (!['active','suspended'].includes(current.status) || current.termination_requested_at || current.owner_id!==renewed.rows[0].user_id) {
      if (!allowReview) throw new ConflictException('此服务已终止或正在终止，请联系服务商核对这张续费账单'); // 内部余额扣款可原子回滚，不收无法交付的钱
      await connection.query("INSERT INTO billing_reviews(invoice_id,service_id,reason) VALUES($1,$2,'renewal_resource_unavailable') ON CONFLICT(invoice_id) DO NOTHING",[invoice.id,current.id]); // 外部已收款保留实际现金事实并明确进入核对
      await record(connection,'billing','renewal.review',invoice.id,{serviceId:current.id,serviceStatus:current.status}); // 不延长到期，也不报告资源交付成功
      return;                                                     // 支付机构收到成功回执后不再重复通知同一笔现金
    }
    const saved=await connection.query("UPDATE services SET due_at=GREATEST(COALESCE(due_at,now()),now())+make_interval(months=>$2,secs=>$3) WHERE id=$1 RETURNING id,product_id,status,suspend_type",[renewed.rows[0].service_id,renewed.rows[0].period_months,renewed.rows[0].period_seconds]); // 已付续费只延长原资源，不重复开通
    const service=saved.rows[0];                                  // 只自动恢复因欠费暂停的服务
    if (service.status==='suspended' && service.suspend_type==='overdue') {
      await connection.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) SELECT $1::uuid,'resume',provider,jsonb_build_object('invoiceId',$2::text,'reason','renewal_paid'),'resume:'||$2::text FROM products WHERE id=$3::uuid AND NOT EXISTS(SELECT 1 FROM jobs WHERE service_id=$1::uuid AND action='resume' AND state IN ('queued','running','waiting','manual_review')) ON CONFLICT(dedup_key) DO NOTHING",[service.id,invoice.id,service.product_id]); // 已有真实恢复在途时不重复排队
    }
    return;                                                       // 到期日变更仍在同一资金事务
  }
  await connection.query("UPDATE services SET status='provisioning' WHERE order_id=$1",[invoice.order_id]); // 汇总账单中的每件资源共同进入开通中
  await connection.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) SELECT s.id,'provision',p.provider,jsonb_build_object('invoiceId',$2::text),'provision:'||s.id::text FROM services s JOIN products p ON p.id=s.product_id WHERE s.order_id=$1::uuid AND s.status='provisioning' ON CONFLICT(dedup_key) DO NOTHING",[invoice.order_id,invoice.id]); // 每件资源各有稳定任务键，整张账单仍只提交一次资金事务
}
