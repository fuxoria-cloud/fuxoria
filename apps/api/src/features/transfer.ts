/* 服务转移：双方主账号确认后变更当前归属，原订单、收款和签约方保持历史事实。
 * 调用：POST /services/:id/transfer {email,password}；接收方 POST /service-transfers/:id/accept。
 * 接收方不获得原客户账单、余额或私有联系人，自动续费授权在转移时关闭。
 */
import { Body,Controller,Get,Post,Param,Req,ConflictException,NotFoundException } from '@nestjs/common'; // 两方各自确认
import { z } from 'zod';                                         // 转移边界只接受目标邮箱和本人证明
import type { PoolClient } from 'pg';                            // 冲突检查复用同一服务事务
import { pool,transaction } from './store.js';                    // 归属更新和审计原子提交
import { ensureUpgradeIdle } from './upgrade.js';                  // 未决配置变更不得被并行资源动作跨越
import { record } from './audit.js';                             // 原归属与新归属均可核对
import { verifyIdentity,factorFields } from './security.js';      // 不能仅靠一个已泄露的会话转走服务
import { type SessionRequest } from '../utils/access.js';        // delegated由统一边界屏蔽
import { read,uuid } from '../utils/input.js';                    // 标准UUID校验

/** @param connection 服务已锁定的事务。@param id 服务ID。@returns 服务没有未决交付或续费。 */
async function available(connection:PoolClient,id:string) {
 await ensureUpgradeIdle(connection,id); // 转移双方确认时都核对配置账单
 const busy=await connection.query("SELECT 1 FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review') UNION ALL SELECT 1 FROM renewals r JOIN invoices i ON i.order_id=r.order_id WHERE r.service_id=$1 AND i.status='unpaid' UNION ALL SELECT 1 FROM service_cancellations WHERE service_id=$1 AND status IN ('pending','approved','executing')",[id]); // 一切可能改变归属/计费的未决事实先处理
 if(busy.rowCount)throw new ConflictException('请先处理此服务的任务、续费账单或取消申请'); // 避免原账号支付旧续费为新归属延长
}

@Controller()
export default class Transfer {
 /** @returns 自己作为转出方或接收方的记录。 */
 @Get('service-transfers') async list(@Req() request:SessionRequest) {
  return (await pool.query('SELECT t.id,t.service_id AS "serviceId",s.name AS "serviceName",t.sender_id AS "senderId",t.recipient_id AS "recipientId",a.email AS "senderEmail",b.email AS "recipientEmail",a.phone AS "senderPhone",b.phone AS "recipientPhone",t.status,t.expires_at AS "expiresAt",t.created_at AS "createdAt" FROM service_transfers t JOIN services s ON s.id=t.service_id JOIN users a ON a.id=t.sender_id JOIN users b ON b.id=t.recipient_id WHERE t.sender_id=$1 OR t.recipient_id=$1 ORDER BY t.created_at DESC LIMIT 200',[request.user.id])).rows; // 仅参与方读取对方转移邮箱
 }
 /** @returns 有效七天的转移邀请。 */
 @Post('services/:id/transfer') async create(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const input=read(z.object({email:z.email().max(254).transform(value=>value.toLowerCase()).optional(),phone:z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),password:z.string().min(1).max(128),...factorFields}).strict().refine(value=>Boolean(value.email)!==Boolean(value.phone),'请选择邮箱或已验证手机号填写一种'),body); // 不允许客户直接写目标ID或服务状态
  await verifyIdentity(request,input,'service.transfer');          // 双重验证恢复码依照公共防重放策略
  return transaction(async connection=>{
   const found=await connection.query("SELECT * FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 FOR UPDATE",[id,request.user.id]);if(!found.rowCount)throw new NotFoundException('服务不存在'); // 归属必须在锁后确认
   const service=found.rows[0];if(!['active','suspended'].includes(service.status)||service.termination_requested_at)throw new ConflictException('此服务当前不能转移'); // 不把未交付/终止资源转走
   const target=await connection.query("SELECT u.id FROM users u WHERE ((u.email=$1 AND u.email_verified_at IS NOT NULL) OR (u.phone=$2 AND u.phone_verified_at IS NOT NULL)) AND NOT u.disabled AND u.role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id)",[input.email??null,input.phone??null]); // 只有独立主账号能接收
   if(!target.rowCount||target.rows[0].id===request.user.id)throw new ConflictException('请填写其他可接收服务的客户主账号已验证邮箱或手机号'); // 不泄露客户详细身份
   await available(connection,id);                               // 未决续费由原账号处理完再转出
   await connection.query("UPDATE service_transfers SET status='expired',completed_at=now() WHERE service_id=$1 AND status='pending' AND expires_at<=now()",[id]); // 过期邀请明确归档
   const pending=await connection.query("SELECT id,recipient_id FROM service_transfers WHERE service_id=$1 AND status='pending'",[id]); // 同一服务只能一个有效邀请
   if(pending.rowCount) {
    if(pending.rows[0].recipient_id!==target.rows[0].id)throw new ConflictException('请先撤销已有转移');return {id:pending.rows[0].id,status:'pending'}; // 网络重试返回原邀请
   }
   const saved=await connection.query('INSERT INTO service_transfers(service_id,sender_id,recipient_id) VALUES($1,$2,$3) RETURNING id,status,expires_at AS "expiresAt"',[id,request.user.id,target.rows[0].id]); // 归属尚未改变
   await record(connection,request.actorId??request.user.id,'service.transfer_requested',id,{transferId:saved.rows[0].id,recipientId:target.rows[0].id});return saved.rows[0]; // 发起事实可追溯
  });
 }
 /** @returns 接收/拒绝/撤销后的最终记录。 */
 @Post('service-transfers/:id/:action') async decide(@Param('id') id:string,@Param('action') action:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const command=read(z.enum(['accept','reject','cancel']),action);const proof=read(z.object({password:z.string().min(1).max(128),...factorFields}).strict(),body); // 每次改变归属/授权都需本人证明
  await verifyIdentity(request,proof,'service.transfer_decide');   // API密钥和联系人不能代办
  return transaction(async connection=>{
   const target=await connection.query('SELECT service_id FROM service_transfers WHERE id=$1 AND (sender_id=$2 OR recipient_id=$2)',[id,request.user.id]);if(!target.rowCount)throw new NotFoundException('转移记录不存在'); // 不向旁观账号返回记录
   const found=await connection.query('SELECT * FROM services WHERE id=$1 FOR UPDATE',[target.rows[0].service_id]);const service=found.rows[0]; // 全部转移路径先锁资源
   const locked=await connection.query('SELECT * FROM service_transfers WHERE id=$1 FOR UPDATE',[id]);const current=locked.rows[0]; // 再锁邀请
   if(command==='cancel'?current.sender_id!==request.user.id:current.recipient_id!==request.user.id)throw new NotFoundException('转移记录不存在'); // 发起方只能撤销，接收方只能接受/拒绝
   if(current.status!=='pending')throw new ConflictException('转移已经结束'); // 不能重写历史
   if(new Date(current.expires_at).getTime()<=Date.now())throw new ConflictException('转移邀请已过期'); // 过期不能接受
   if(command==='accept') {
    if((service.current_owner_id??service.user_id)!==current.sender_id||!['active','suspended'].includes(service.status)||service.termination_requested_at)throw new ConflictException('服务状态或归属已变化'); // 原邀请不能覆盖后来归属
    await available(connection,service.id);                       // 接收前再检查一次未决交付
    await connection.query('UPDATE services SET current_owner_id=$2,auto_renew=false,group_id=NULL,remark=\'\' WHERE id=$1',[service.id,request.user.id]); // 原订单所有人不可变；清除原账号备注和扣款授权
    await connection.query("UPDATE contracts SET status='cancelled' WHERE service_id=$1 AND user_id=$2 AND status='pending'",[service.id,current.sender_id]); // 原账号未签的资源合同不再有效
   }
   const status={accept:'accepted',reject:'rejected',cancel:'cancelled'}[command];await connection.query('UPDATE service_transfers SET status=$2,completed_at=now() WHERE id=$1',[id,status]); // 只追加最终结论
   await record(connection,request.actorId??request.user.id,`service.transfer_${status}`,service.id,{transferId:id,senderId:current.sender_id,recipientId:current.recipient_id});return {status}; // 金融历史不随服务一起移走
  });
 }
}
