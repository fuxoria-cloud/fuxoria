/* 自动续费：主账号明确授权后，接近到期时创建合同周期账单并仅用已有钱包余额付款。
 * 调用：POST /services/:id/auto-renew {enabled,password,...第二因素}；run()可由隔离测试手动调用。
 * 账单和钱包幂等规则来自原主体；多节点运行不会重复扣款，余额不足保留未付账单并通知一次。
 */
import { Body,Controller,Post,Param,Req,ConflictException,NotFoundException,type OnModuleInit,type OnModuleDestroy } from '@nestjs/common'; // 生命周期绑定真实API进程
import { createHash,randomUUID } from 'node:crypto';               // 一个到期日只对应一个稳定订单键
import { z } from 'zod';                                        // 扣款授权边界明确
import { pool,transaction } from './store.js';                    // 授权和审计一起保存
import { ensureUpgradeIdle } from './upgrade.js';                  // 未决配置变更不得被并行资源动作跨越
import { record } from './audit.js';                             // 自动扣款与人工授权可关联
import { notify } from './notification.js';                      // 余额不足使用站内真实通知
import Service from './service.js';                             // 续费报价和合同规则只有一处
import Wallet from './wallet.js';                               // 不复制资金分录逻辑
import { verifyIdentity,factorFields } from './security.js';      // 开启和关闭都核对本人
import { read,uuid } from '../utils/input.js';                    // 标准资源边界
import type { SessionRequest } from '../utils/access.js';         // 任务以明确授权的归属账号执行
import { periods,renewalWindowSeconds,renewalWindowSQL } from './catalogue.js';                         // 试用与一次性均不自动续费

@Controller()
export default class Autorenew implements OnModuleInit,OnModuleDestroy {
 private timer?:ReturnType<typeof setInterval>;private running=false; // 同一进程上一批未完不叠加
 onModuleInit(){this.timer=setInterval(()=>void this.run().catch(error=>console.error(JSON.stringify({feature:'autorenew',error:error instanceof Error?error.message:'自动续费失败'}))),60000);this.timer.unref();} // 实际数据库账单跨进程幂等，不依赖内存计时器正确性
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}       // 退出后不再接受下一批
 /** @returns 保存后的自动续费授权。 */
 @Post('services/:id/auto-renew') async authorize(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const input=read(z.object({enabled:z.boolean(),password:z.string().min(1).max(128),...factorFields}).strict(),body); // 客户不能配置金额或第三方免密扣款
  await verifyIdentity(request,input,'service.auto_renew');        // 只有主账号本人可以授权钱包
  return transaction(async connection=>{
   const found=await connection.query('SELECT billing_months,billing_seconds,billing_period,status,termination_requested_at FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 FOR UPDATE',[id,request.user.id]);if(!found.rowCount)throw new NotFoundException('服务不存在'); // 转移和授权按同一个服务锁串行
   const service=found.rows[0];if(input.enabled)await ensureUpgradeIdle(connection,id); // 不能替旧配置开启扣款
   if(input.enabled&&(!periods[service.billing_period as keyof typeof periods]?.renewable||service.termination_requested_at||!['active','suspended'].includes(service.status)))throw new ConflictException('当前服务不支持自动续费'); // 一次性和终止服务不进入调度
   await connection.query('UPDATE services SET auto_renew=$2 WHERE id=$1',[id,input.enabled]); // 关闭授权立即影响下一笔扣款事务
   await record(connection,request.actorId??request.user.id,'service.auto_renew',id,{enabled:input.enabled,paymentSource:'wallet',windowSeconds:renewalWindowSeconds(service.billing_period,service.billing_seconds)});return {enabled:input.enabled}; // 明确授权用途和时间窗口
  });
 }
 /** @returns 本轮实际检查的服务数，供运行核对与隔离测试使用。 */
 async run():Promise<number> {
  if(this.running)return 0;this.running=true;                     // 多个时钟触发不堆叠同一批
  try {
   const candidates=await pool.query(`SELECT s.id,s.billing_period,s.due_at::text AS due,u.id AS owner,u.email,u.name,u.role,${renewalWindowSQL('s')} AS window_seconds FROM services s JOIN users u ON u.id=COALESCE(s.current_owner_id,s.user_id) LEFT JOIN auto_renew_attempts previous ON previous.service_id=s.id AND previous.owner_id=u.id AND previous.due_at=s.due_at LEFT JOIN invoices bill ON bill.id=previous.invoice_id WHERE s.auto_renew AND s.billing_period NOT IN ('ontrial','onetime') AND (s.billing_months>0 OR s.billing_seconds>0) AND s.due_at<=now()+make_interval(secs=>${renewalWindowSQL('s')}) AND s.status IN ('active','suspended') AND s.termination_requested_at IS NULL AND NOT u.disabled AND (previous.service_id IS NULL OR bill.status='unpaid' AND bill.amount_cents<=
     -COALESCE((SELECT sum(e.amount_cents) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='wallet:'||u.id::text AND t.currency=bill.currency),0)
     -COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payment_receipts paid ON paid.id=r.receipt_id JOIN invoices recharge_bill ON recharge_bill.id=paid.invoice_id JOIN orders recharge ON recharge.id=recharge_bill.order_id WHERE r.user_id=u.id AND r.currency=bill.currency AND recharge.kind='recharge' AND r.status NOT IN('rejected','failed','succeeded')),0)) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.service_id=s.id AND j.state IN ('queued','running','waiting','manual_review')) ORDER BY s.due_at,s.id LIMIT 25`); // 有界扫描真实授权；已有不足尝试不占后续候选，原未付账单补足同币种可用余额后可恢复
   for(const service of candidates.rows) {
    const request={user:{id:service.owner,email:service.email,name:service.name,role:service.role},actorId:service.owner,requestId:randomUUID()} as SessionRequest; // 自动操作只代表当前钱包所有人
    const key='auto_'+createHash('sha256').update(`${service.id}:${service.owner}:${service.due}`).digest('hex');let invoiceId:string|undefined; // 重启和多实例使用同一幂等键
    try {
     const order=await new Service().renew(service.id,key,{period:service.billing_period},request,{dueAt:service.due});invoiceId=order.invoiceId; // 价格、配置和周期仍由原合同决定
     await pool.query('INSERT INTO auto_renew_attempts(service_id,owner_id,due_at,invoice_id) VALUES($1,$2,$3,$4) ON CONFLICT(service_id,owner_id,due_at) DO NOTHING',[service.id,service.owner,service.due,invoiceId]); // 记录实际账单而不另存余额
     if(order.status!=='paid')await new Wallet().pay(invoiceId!,request,{serviceId:service.id,dueAt:service.due}); // 免费合同在原续费事务交付，不伪造钱包资金
     await pool.query('UPDATE auto_renew_attempts SET last_error=NULL,updated_at=now() WHERE service_id=$1 AND owner_id=$2 AND due_at=$3',[service.id,service.owner,service.due]); // 成功后真实到期日已改变，下一轮不会重复续费
    } catch(error) {
     if(!(error instanceof ConflictException))throw error;        // 数据库或系统故障不伪装为余额不足
     if(!invoiceId)continue;                                     // 授权已撤回等情况没有新账单可通知
     await transaction(async connection=>{
      const saved=await connection.query('UPDATE auto_renew_attempts SET last_error=$4,notified_at=COALESCE(notified_at,now()),updated_at=now() WHERE service_id=$1 AND owner_id=$2 AND due_at=$3 AND notified_at IS NULL RETURNING invoice_id',[service.id,service.owner,service.due,error.message]); // 竞争节点只有一个能通知
      if(saved.rowCount){await notify(connection,service.owner,'自动续费需要处理',`服务续费账单已生成：${error.message}。请核对后付款。`,`/console/invoices/${invoiceId}`);await record(connection,'autorenew','service.auto_renew_attention',service.id,{invoiceId,reason:error.message});} // 失败通知与审计一起提交
     });
    }
   }
   return candidates.rowCount??0;                               // 计数不冒充实际付款数
  } finally {this.running=false;}                              // 故障后下一分钟仍能恢复
 }
}
