/* 退款：客户申请先预留可退额度，管理员用当前密码批准，机构确认成功后才追加反向分录。
 * 调用：POST /api/v1/invoices/:id/refunds {amountCents:'100',reason:'客户申请'}，带Idempotency-Key。
 * 审批：POST /api/v1/admin/refunds/:id/approve {password:'当前管理员密码'}；refresh只查询原退款号。
 * 未知结果保留额度并转人工核对，既不产生新退款号，也不提供模拟完成按钮。
 */
import { Body, Controller, Get, Headers, Param, Post, Query, Req, ConflictException, NotFoundException, UnauthorizedException, HttpException } from '@nestjs/common'; // HTTP只适配业务输入
import { createHash } from 'node:crypto';                          // 幂等键必须绑定同一份申请
import { z } from 'zod';                                          // 在退款边界统一整理输入
import type { PoolClient } from 'pg';                             // 原收款锁与退款状态共享事务
import type { PaymentRefund, RefundResult } from '@fuxoria/payments'; // 同一份机构退款合同
import { pool, redis, transaction } from './store.js';             // 退款事实只保存到PostgreSQL
import { funds } from './wallet.js';                             // 充值退款和消费共享钱包预留规则
import { record } from './audit.js';                              // 额度与资金变动都留下审计
import { payments } from './payment.js';                          // 使用已经扫描的真实支付插件
import { Roles, tokenHash, type SessionRequest } from '../utils/access.js'; // 客户所有权和管理员角色分开检查
import { read, uuid, money } from '../utils/input.js';             // 金额保持整数分文本
import { checkPassword, checkFactor, factorComplete, factorFields, type FactorProof } from './security.js'; // 资金审批使用与登录一致的双因素规则
import { assertTaxRefundable } from './voucher.js';                // 票据红冲和退款共用账单锁

const columns = 'r.id,r.receipt_id AS "receiptId",p.invoice_id AS "invoiceId",r.user_id AS "userId",r.amount_cents::text AS "amountCents",r.currency,(SELECT decimals FROM currencies WHERE code=r.currency) AS "currencyDecimals",r.reason,r.status,r.provider_status AS "providerStatus",r.provider_reference AS "providerReference",r.last_error AS "lastError",r.approved_by AS "approvedBy",r.approved_at AS "approvedAt",r.decision_reason AS "decisionReason",r.completed_at AS "completedAt",r.created_at AS "createdAt",r.updated_at AS "updatedAt",p.gateway'; // 对外不返回密码、提交指纹或商户密钥
const page = z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),limit:z.coerce.number().int().min(1).max(200).default(50),status:z.string().trim().max(30).optional()}).strict(); // 大列表必须有固定页长

// --- 读取一份可给界面展示的退款 ---
async function view(connection: PoolClient, id: string) {
  const found = await connection.query(`SELECT ${columns} FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE r.id=$1`,[id]); // 所有界面使用同一份字段映射
  return found.rows[0];                                           // 调用前已确认退款存在
}

// --- 按原收款再按退款加锁 ---
async function lock(connection: PoolClient, id: string) {
  const found = await connection.query('SELECT r.receipt_id,p.invoice_id FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE r.id=$1',[id]); // 先定位不会改变的原收款
  if (!found.rowCount) throw new NotFoundException('退款申请不存在'); // 不制造新的退款事实
  await connection.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[found.rows[0].invoice_id]); // 开票与退款统一账单→收款→申请的锁顺序
  const paid = await connection.query('SELECT * FROM payment_receipts WHERE id=$1 FOR UPDATE',[found.rows[0].receipt_id]); // 同收款的额度和状态始终串行
  const application = await connection.query('SELECT * FROM refunds WHERE id=$1 FOR UPDATE',[id]); // 持有收款锁后才锁申请，避免交叉死锁
  return {application:application.rows[0],receipt:paid.rows[0]};   // 原始申请字段由数据库禁止修改
}

// --- 组装机构需要的固定申请 ---
function instruction(application: Record<string, any>, receipt: Record<string, any>): PaymentRefund {
  return {currency:application.currency,invoiceId:receipt.invoice_id,transactionId:receipt.transaction_id,refundId:application.id,amountCents:application.amount_cents,totalCents:receipt.amount_cents,reason:application.reason}; // 机构金额只来自已锁定的收款和申请
}

// --- 核对管理员当前密码 ---
async function authorize(request: SessionRequest, input: FactorProof & {password:string}, id:string) {
  const key = `refund-password:${request.user.id}:${tokenHash(request.ip ?? '')}`; // 限额不包含密码正文
  const count = await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",{keys:[key],arguments:[]}); // 检查和过期原子完成
  if (Number(count)>5) throw new HttpException('退款密码核对过于频繁，请10分钟后重试',429); // 被盗会话不能无限尝试当前密码
  await transaction(async connection=>{
    const user=await checkPassword(connection,request.user.id,input.password); // 先锁账号并核对当前密码
    if (user.role!=='admin') throw new UnauthorizedException('当前账号没有退款审批权限'); // 不接受过时会话中的管理员角色
    await checkFactor(connection,user.id,input,`refund.approve:${id}`); // 已启用MFA时还需当次TOTP或恢复码，消费事实同事务审计
  });
  await redis.del(key);                                          // 密码和MFA都成功后才清除失败计数
  await factorComplete(request.user.id);                         // 不因密码正确而重置错误TOTP预算
}

// --- 只在机构明确成功后写反向分录 ---
async function confirm(id: string, actor: string, result: RefundResult) {
  return transaction(async connection=>{
    const {application,receipt} = await lock(connection,id);      // 与其它申请及结果确认争用同一收款锁
    if (application.status==='succeeded') return view(connection,id); // 重复查询不会重复冲账
    if (!['processing','manual_review'].includes(application.status)) throw new ConflictException('此退款尚未发送或已终止'); // 不让外部查询复活拒绝的申请
    if (result.status==='pending') {
      await connection.query("UPDATE refunds SET status='processing',provider_status='pending',provider_reference=$2,last_error=NULL,updated_at=now() WHERE id=$1",[id,result.reference]); // 已受理仍继续占用可退额度
      await record(connection,actor,'refund.pending',id,{reference:result.reference}); // 明确记录受理而非到账
      return view(connection,id);                                // 前端显示仍在处理
    }
    const kind=(await connection.query('SELECT o.kind FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=$1',[receipt.invoice_id])).rows[0].kind; // 充值退款冲回客户负债
    if(kind==='recharge')await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet:${application.user_id}`]); // 确认退款与钱包消费串行
    const ledger = await connection.query('INSERT INTO ledger_transactions(refund_id,currency) VALUES($1,$2) RETURNING id',[id,application.currency]); // 原收款事务不修改，每笔退款有独立事务
    await connection.query('INSERT INTO ledger_entries(transaction_id,account,amount_cents) VALUES($1,$2,$3),($1,$4,$5)',[ledger.rows[0].id,`cash:${receipt.gateway}`,(-BigInt(application.amount_cents)).toString(),`${kind==='recharge'?'wallet':'income'}:${application.user_id}`,application.amount_cents]); // 退款现金减少，原收入反向冲回
    await connection.query("UPDATE refunds SET status='succeeded',provider_status='succeeded',provider_reference=$2,last_error=NULL,completed_at=now(),updated_at=now() WHERE id=$1",[id,result.reference]); // 状态与反向分录在同一事务确认
    await connection.query("UPDATE billing_reviews SET status='resolved',resolution='refunded',resolved_at=now() WHERE invoice_id=$1 AND status='open' AND (SELECT COALESCE(sum(amount_cents),0) FROM refunds WHERE receipt_id=$2 AND status='succeeded')>=$3::bigint",[receipt.invoice_id,receipt.id,receipt.amount_cents]); // 核对中的续费只有完整真实退款后才自动结案
    await connection.query("UPDATE service_upgrades SET status='cancelled' WHERE order_id=(SELECT order_id FROM invoices WHERE id=$1) AND status='review' AND (SELECT COALESCE(sum(amount_cents),0) FROM refunds WHERE receipt_id=$2 AND status='succeeded')>=$3::bigint",[receipt.invoice_id,receipt.id,receipt.amount_cents]); // 实际全额退回的失效升降级解除资源阻断
    await record(connection,actor,'refund.succeed',id,{receiptId:receipt.id,invoiceId:receipt.invoice_id,gateway:receipt.gateway,amountCents:application.amount_cents,currency:application.currency,reference:result.reference}); // 资金审计与账本一起提交
    return view(connection,id);                                  // 提交成功才对界面宣告退款完成
  });
}

// --- 机构结果不明时保持额度，等待真实查询 ---
async function uncertain(id: string, actor: string, error: unknown) {
  const failure = error as {status?:number;message?:string};      // 这里只接收机构边界的异常
  const reason = (failure.message ?? '支付机构没有返回可确认的退款结果').replace(/[\u0000-\u001f]/g,' ').slice(0,500); // 不保存控制符或无限长网关正文
  return transaction(async connection=>{
    const {application} = await lock(connection,id);              // 不覆盖其它请求已经确认的完成事实
    if (application.status==='succeeded') return view(connection,id); // 后到的网络异常不能撤销已验证成功
    await connection.query("UPDATE refunds SET status='manual_review',provider_status=$2,last_error=$3,updated_at=now() WHERE id=$1",[id,failure.status===501?'unsupported':'unknown',reason]); // 未知出站结果绝不释放退款额度
    await record(connection,actor,'refund.uncertain',id,{providerStatus:failure.status===501?'unsupported':'unknown',reason}); // 之后能定位为什么需要核对
    return view(connection,id);                                  // 管理界面显示实际状态与处理原因
  });
}

/** @param id 已发送的退款ID。@param actor 查询人或调度任务标识。@returns 真实机构结果，未知时保留额度。 */
export async function refreshRefund(id: string, actor: string) {
  read(uuid,id);                                                  // 定时任务和HTTP入口使用同一标识规则
  const prepared = await transaction(async connection=>{
    const {application,receipt} = await lock(connection,id);      // 读取不可变申请及当前状态
    if (application.status==='succeeded') return {finished:await view(connection,id)}; // 已完成无需再次请求机构
    if (!['processing','manual_review'].includes(application.status)) throw new ConflictException('只有已发送的退款可以查询机构结果'); // 不凭查询发起新退款
    return {input:instruction(application,receipt),gateway:receipt.gateway as string}; // 不持有数据库锁等待HTTP
  });
  if ('finished' in prepared) return prepared.finished;            // 终态直接返回保存事实
  let result: RefundResult;                                       // 机构查询与数据库确认分开，避免吞掉数据库故障
  try {
    const plugin = payments.get(prepared.gateway);                 // 只调用原支付渠道
    if (!plugin.queryRefund || !(plugin.currencies??['CNY']).includes(prepared.input.currency??'CNY')) throw Object.assign(new Error('此通道没有可验签的退款结果查询，请从商户后台核对'),{status:501}); // 能力缺失不能伪造退款成功
    result = await plugin.queryRefund(prepared.input);             // 始终查询原refundId，不再次发送退款
  } catch (error) { return uncertain(id,actor,error); }             // 机构无法确定结果时保留人工核对状态
  return confirm(id,actor,result);                                 // 数据库失败会直接报错，原processing记录仍可补偿
}

@Controller()
export default class Refund {
  /** @param id 当前客户的已付款账单。@param body 金额和原因。@param key 一次申请的幂等标识。@returns 已预留额度的退款申请。 */
  @Post('invoices/:id/refunds') async create(@Param('id') id:string,@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                // 账单标识只在边界检查
    const input = read(z.object({amountCents:money,reason:z.string().trim().min(1).max(500)}).strict(),body); // 不接收客户自报的原收款或币种
    const token = read(z.string().trim().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),key); // 同一次提交使用固定键
    const fingerprint = createHash('sha256').update(JSON.stringify({invoiceId:id,...input})).digest('hex'); // 相同键不能换金额或原因
    return transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`refund:${request.user.id}:${token}`]); // 同账号同键的请求串行处理
      const previous = await connection.query('SELECT id,request_hash FROM refunds WHERE user_id=$1 AND idempotency_key=$2',[request.user.id,token]); // 重复提交直接返回原申请
      if (previous.rowCount) {
        if (previous.rows[0].request_hash!==fingerprint) throw new ConflictException('同一个提交标识不能申请不同退款'); // 防止重试偷偷改变资金意图
        return view(connection,previous.rows[0].id);              // 不重复预留额度
      }
      const owner = await connection.query("SELECT id FROM invoices WHERE id=$1 AND user_id=$2 AND status='paid' FOR UPDATE",[id,request.user.id]); // 与开票串行，先锁本人真实账单
      if (!owner.rowCount) throw new NotFoundException('已付款账单不存在'); // 不能探测其他客户的账单
      const paid = await connection.query('SELECT * FROM payment_receipts WHERE invoice_id=$1 FOR UPDATE',[id]); // 同收款的所有申请串行占用额度
      if (!paid.rowCount) throw new ConflictException('未找到可原路退款的支付机构收款记录，请联系服务商核对账户余额付款'); // 余额付款不伪装成支付机构现金退款
      await assertTaxRefundable(connection,id);
      const receipt=paid.rows[0];
      const kind=(await connection.query('SELECT o.kind FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=$1',[id])).rows[0].kind; // 充值只有尚可用的钱包额度能退
      if(kind==='credit_repayment')throw new ConflictException('还款账单用于结清信用欠款，业务退款请先核对原业务账单'); // 不把已释放额度重复提取为现金
      if(kind==='recharge') {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet:${request.user.id}`]); // 和消费使用同一把钱包锁
        if(BigInt((await funds(connection,request.user.id,receipt.currency)).availableCents)<BigInt(input.amountCents))throw new ConflictException('充值余额已使用或已预留退款，当前可用余额不足'); // 避免同一资金双重支出
      }
      const reserved = await connection.query("SELECT COALESCE(sum(amount_cents),0)::text AS total FROM refunds WHERE receipt_id=$1 AND status NOT IN ('rejected','failed')",[receipt.id]); // 成功、待审批和未知退款都继续计入已占额度
      if (BigInt(reserved.rows[0].total)+BigInt(input.amountCents)>BigInt(receipt.amount_cents)) throw new ConflictException('申请金额超过当前可退金额，请先查看已有退款'); // 并发申请不会超出实际收款
      const saved = await connection.query('INSERT INTO refunds(receipt_id,user_id,amount_cents,currency,reason,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[receipt.id,request.user.id,input.amountCents,receipt.currency,input.reason,token,fingerprint]); // 额度预留与申请同时持久化
      await record(connection,request.actorId??request.user.id,'refund.request',saved.rows[0].id,{receiptId:receipt.id,invoiceId:id,amountCents:input.amountCents,currency:receipt.currency,reason:input.reason}); // 客户的真实退款意图进入审计
      return view(connection,saved.rows[0].id);                    // 客户看到待审批，而不是虚构已退款
    });
  }

  /** @param id 当前客户的账单。@returns 该账单全部退款申请，最多200条。 */
  @Get('invoices/:id/refunds') async customer(@Param('id') id:string,@Req() request:SessionRequest) {
    read(uuid,id);                                                // 不把任意值作为数据库标识
    const owner = await pool.query('SELECT id FROM invoices WHERE id=$1 AND user_id=$2',[id,request.user.id]); // 没有退款的账单也需先确认所有权
    if (!owner.rowCount) throw new NotFoundException('账单不存在'); // 不泄漏其他账号是否申请过退款
    return (await pool.query(`SELECT ${columns} FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE p.invoice_id=$1 AND r.user_id=$2 ORDER BY r.created_at DESC LIMIT 200`,[id,request.user.id])).rows; // 条件始终带当前账号
  }

  /** @param query 页码、页长和可选状态。@returns 管理员退款工作列表。 */
  @Roles('admin') @Get('admin/refunds') async list(@Query() query:unknown) {
    const input = read(page,query);                               // 页长最多200
    const items = await pool.query(`SELECT ${columns} FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE ($1::text IS NULL OR r.status=$1) ORDER BY r.created_at DESC,r.id LIMIT $2 OFFSET $3`,[input.status ?? null,input.limit,(input.page-1)*input.limit]); // 页码顺序稳定
    const count = await pool.query('SELECT count(*)::int AS total FROM refunds WHERE ($1::text IS NULL OR status=$1)',[input.status ?? null]); // 只返回当前筛选的总数
    return {items:items.rows,total:count.rows[0].total,page:input.page,limit:input.limit}; // 未知机构状态也会展示
  }

  /** @param id 待审批退款。@param body 管理员当前密码。@returns 已发送或明确未发送的实际状态。 */
  @Roles('admin') @Post('admin/refunds/:id/approve') async approve(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                // 审批目标必须是本地申请
    const input = read(z.object({password:z.string().min(1).max(128),...factorFields}).strict(),body); // 不接受用户更改申请金额
    await authorize(request,input,id);                           // 当前密码与启用的MFA都验证通过后才能出站
    const prepared = await transaction(async connection=>{
      const {application,receipt} = await lock(connection,id);    // 同收款的审批与新申请共用额度锁
      if (['succeeded','processing','manual_review'].includes(application.status)) return {finished:await view(connection,id)}; // 重复批准绝不再次发起退款
      if (!['requested','approved'].includes(application.status)) throw new ConflictException('此退款已经被拒绝或终止'); // 不复活已结束申请
      await assertTaxRefundable(connection,receipt.invoice_id); // 仅真正出站前复核，不回滚已发生的机构成功事实
      if (receipt.import_id) {
        await connection.query("UPDATE refunds SET provider_status='historical_reference_required',last_error='历史收款需先核对原商户订单号，请在原支付商户后台处理并保留凭据',updated_at=now() WHERE id=$1",[id]); // 旧交易号不能被新账单UUID冒充商户单号
        await record(connection,request.actorId??request.user.id,'refund.historical',id,{receiptId:receipt.id,legacyTransactionId:receipt.transaction_id}); // 未向机构发出任何退款，原申请仍可核对或拒绝
        return {finished:await view(connection,id)};                // 不将猜测的旧映射用于真实资金出站
      }
      const plugin = payments.get(receipt.gateway);               // 资金只能原路返回
      if (!plugin.configured || !plugin.refund || !(plugin.currencies??['CNY']).includes(application.currency)) {
        await connection.query("UPDATE refunds SET provider_status='unsupported',last_error='此支付渠道尚未配置可执行的退款接口',updated_at=now() WHERE id=$1",[id]); // 未发送的申请仍可明确拒绝释放额度
        await record(connection,request.actorId??request.user.id,'refund.unsupported',id,{gateway:receipt.gateway}); // 能力不足不伪造外部动作
        return {finished:await view(connection,id)};              // 界面显示未发送原因
      }
      await connection.query("UPDATE refunds SET status='processing',provider_status='pending',approved_by=$2,approved_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",[id,request.user.id]); // HTTP调用前先提交固定退款号和处理中状态
      await record(connection,request.actorId??request.user.id,'refund.approve',id,{receiptId:receipt.id,gateway:receipt.gateway,amountCents:application.amount_cents,currency:application.currency}); // 审批人与出站意图可追踪
      return {input:instruction(application,receipt),plugin};     // 事务结束后才等待外部HTTP
    });
    if ('finished' in prepared) return prepared.finished;          // 已发送或未配置都不会再发一次退款
    let result: RefundResult;                                     // 机构失败与本地数据库失败分开处理
    try { result = await prepared.plugin.refund!(prepared.input); } catch (error) { return uncertain(id,request.user.id,error); } // 未知结果保留额度，后续只查询原申请
    return confirm(id,request.user.id,result);                     // 最终成功和独立反向分录一起提交
  }

  /** @param id 尚未发送的退款。@param body 拒绝原因。@returns 已拒绝并释放申请预留额度。 */
  @Roles('admin') @Post('admin/refunds/:id/reject') async reject(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                // 输入只在HTTP边界检查
    const input = read(z.object({reason:z.string().trim().min(1).max(500)}).strict(),body); // 拒绝必须提供可给客户看的原因
    return transaction(async connection=>{
      const {application} = await lock(connection,id);            // 拒绝与批准不能同时成功
      if (application.status==='rejected') return view(connection,id); // 重复拒绝不会重复释放额度
      if (!['requested','approved'].includes(application.status)) throw new ConflictException('退款已经发送，必须核对机构结果，不能直接释放金额'); // 资金可能已出站时禁止手工抹掉预留
      await connection.query("UPDATE refunds SET status='rejected',provider_status='not_requested',rejected_by=$2,decision_reason=$3,updated_at=now() WHERE id=$1",[id,request.user.id,input.reason]); // 只有未出站申请可以拒绝
      await record(connection,request.actorId??request.user.id,'refund.reject',id,{reason:input.reason}); // 释放额度的原因同事务保存
      return view(connection,id);                                // 客户能看到明确的拒绝原因
    });
  }

  /** @param id 已发送的退款。@returns 机构确认结果，不重新发起退款。 */
  @Roles('admin') @Post('admin/refunds/:id/refresh') refresh(@Param('id') id:string,@Req() request:SessionRequest) {
    return refreshRefund(id,request.user.id);                     // 只查询原申请，不需要再次批准资金出站
  }
}
