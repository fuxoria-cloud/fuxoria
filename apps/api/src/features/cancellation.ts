/* 取消申请：客户提出立即/到期取消，管理员复核后持久化真实终止任务。
 * 调用：POST /services/:id/cancellations；POST /admin/service-cancellations/:id/decide。
 * 申请和批准不冒充资源已删除；executed只由成功的开通守护进程写入。
 */
import { Body,Controller,Get,Post,Param,Req,ConflictException,NotFoundException } from '@nestjs/common'; // 申请与交付分开呈现
import { z } from 'zod';                                         // 所有外部输入在入口检查
import { pool,transaction } from './store.js';                     // 申请、任务与审计共用事务
import { ensureUpgradeIdle } from './upgrade.js';                  // 未决配置变更不得被并行资源动作跨越
import { record } from './audit.js';                              // 保留申请和决策理由
import { verifyIdentity,factorFields } from './security.js';       // 终止批准要求管理员再次证明
import { Roles,type SessionRequest } from '../utils/access.js';   // 所有查询核对账号
import { read,uuid } from '../utils/input.js';                     // UUID与正文使用一致错误格式

const columns=`c.id,c.service_id AS "serviceId",c.mode,c.reason,c.status,c.decision_reason AS "decisionReason",c.execute_at AS "executeAt",c.job_id AS "jobId",c.created_at AS "createdAt",s.name AS "serviceName"`; // 列表不暴露供应商凭据

@Controller()
export default class Cancellation {
 /** @returns 当前客户全部取消申请。 */
 @Get('service-cancellations') async list(@Req() request:SessionRequest) {
  return (await pool.query(`SELECT ${columns} FROM service_cancellations c JOIN services s ON s.id=c.service_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 200`,[request.user.id])).rows; // 转移前的申请仍属原申请人
 }
 /** @returns 管理员待处理及历史申请。 */
 @Roles('admin') @Get('admin/service-cancellations') async all() {
  return (await pool.query(`SELECT ${columns},u.email FROM service_cancellations c JOIN services s ON s.id=c.service_id JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200`)).rows; // 仅管理权限可读全局
 }
 /** @returns 保存后的申请；尚未批准时资源照常运行。 */
 @Post('services/:id/cancellations') async create(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const input=read(z.object({mode:z.enum(['immediate','end_of_period']),reason:z.string().trim().min(1).max(1000)}).strict(),body); // 客户只决定取消方式和理由
  return transaction(async connection=>{
   const found=await connection.query("SELECT * FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 FOR UPDATE",[id,request.user.id]); // 按服务串行处理归属与申请
   if(!found.rowCount)throw new NotFoundException('服务不存在');const service=found.rows[0]; await ensureUpgradeIdle(connection,id); // 不泄露其他客户服务
   if(!['active','suspended'].includes(service.status)||service.termination_requested_at)throw new ConflictException('当前服务不能申请取消'); // 不重复终止
   if(input.mode==='end_of_period'&&!service.due_at)throw new ConflictException('一次性服务请选择立即取消'); // 没有到期日不能定时
   const busy=await connection.query("SELECT 1 FROM service_transfers WHERE service_id=$1 AND status='pending' AND expires_at>now() UNION ALL SELECT 1 FROM service_cancellations WHERE service_id=$1 AND status IN ('pending','approved','executing')",[id]); // 转移与取消不可竞争归属
   if(busy.rowCount)throw new ConflictException('请先处理已有转移或取消申请'); // 明确冲突而不隐藏旧申请
   const saved=await connection.query('INSERT INTO service_cancellations(service_id,user_id,mode,reason) VALUES($1,$2,$3,$4) RETURNING id,status',[id,request.user.id,input.mode,input.reason]); // 本步骤没有供应商动作
   await record(connection,request.actorId??request.user.id,'service.cancel_requested',id,{requestId:saved.rows[0].id,...input}); // 申请与操作者一起留痕
   return saved.rows[0];                                         // 后台必须明确批准
  });
 }
 /** @returns 未进入执行的申请已撤回。 */
 @Post('service-cancellations/:id/withdraw') async withdraw(@Param('id') id:string,@Req() request:SessionRequest) {
  read(uuid,id);return transaction(async connection=>{
   const target=await connection.query('SELECT service_id FROM service_cancellations WHERE id=$1 AND user_id=$2',[id,request.user.id]); // 先找服务锁顺序
   if(!target.rowCount)throw new NotFoundException('申请不存在'); // 不暴露全局申请
   await connection.query('SELECT id FROM services WHERE id=$1 FOR UPDATE',[target.rows[0].service_id]); // 与调度器服务锁串行
   const locked=await connection.query('SELECT * FROM service_cancellations WHERE id=$1 FOR UPDATE',[id]);const current=locked.rows[0]; // 读取锁后最新决定
   if(!['pending','approved'].includes(current.status))throw new ConflictException('此申请已进入执行或结束，不能撤回'); // 已向供应商发送的动作不可假装撤销
   await connection.query("UPDATE service_cancellations SET status='withdrawn',updated_at=now() WHERE id=$1",[id]); // 历史保留
   if(current.status==='approved')await connection.query('UPDATE services SET termination_requested_at=NULL WHERE id=$1',[current.service_id]); // 未排任务才解除本申请终止意图
   await record(connection,request.actorId??request.user.id,'service.cancel_withdrawn',current.service_id,{requestId:id});return {ok:true}; // 事务一起提交
  });
 }
 /** @returns 复核后状态，立即取消也只显示正在执行。 */
 @Roles('admin') @Post('admin/service-cancellations/:id/decide') async decide(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
  read(uuid,id);const input=read(z.object({action:z.enum(['approve','reject']),reason:z.string().trim().min(1).max(1000),password:z.string().min(1).max(128),...factorFields}).strict(),body); // 批准和拒绝都说明理由
  await verifyIdentity(request,input,'cancellation.decide','admin'); // 身份证明先独立提交，保持服务→审计锁顺序
  return transaction(async connection=>{
   const target=await connection.query('SELECT service_id FROM service_cancellations WHERE id=$1',[id]);if(!target.rowCount)throw new NotFoundException('申请不存在'); // 不创建悬空任务
   const found=await connection.query('SELECT s.*,p.provider FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 FOR UPDATE OF s',[target.rows[0].service_id]);const service=found.rows[0]; // 服务是实际执行锁
   const locked=await connection.query('SELECT * FROM service_cancellations WHERE id=$1 FOR UPDATE',[id]);const current=locked.rows[0]; // 再锁申请
   if(current.status!=='pending')throw new ConflictException('申请已经处理'); // 审批一次
   if(input.action==='reject') {
    await connection.query("UPDATE service_cancellations SET status='rejected',decision_reason=$2,decided_by=$3,decided_at=now(),updated_at=now() WHERE id=$1",[id,input.reason,request.user.id]); // 拒绝不影响服务
    await record(connection,request.actorId??request.user.id,'service.cancel_rejected',service.id,{requestId:id,reason:input.reason});return {status:'rejected'}; // 决策与审计一致
   }
   await ensureUpgradeIdle(connection,service.id); // 不能批准终止已付但未交付的变更
   if(!['active','suspended'].includes(service.status)||service.termination_requested_at||current.user_id!==(service.current_owner_id??service.user_id))throw new ConflictException('服务状态或归属已变化'); // 老申请不能终止他人资源
   const busy=await connection.query("SELECT 1 FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review')",[service.id]);if(busy.rowCount)throw new ConflictException('请先处理此服务正在执行的任务'); // 不越过未知供应商结果
   let jobId:string|null=null;const immediate=current.mode==='immediate'||new Date(service.due_at).getTime()<=Date.now(); // 已过期的到期取消立即排队
   if(immediate) {
    const job=await connection.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,'terminate',$2,$3,$4) RETURNING id",[service.id,service.provider,{reason:current.reason,cancellationId:id},`cancellation:${id}`]);jobId=job.rows[0].id; // 真正执行仍由Go确认
   }
   await connection.query('UPDATE services SET termination_requested_at=now(),auto_renew=false WHERE id=$1',[service.id]); // 批准后不再继续收续费
   await connection.query("UPDATE service_cancellations SET status=$2,decision_reason=$3,decided_by=$4,decided_at=now(),execute_at=$5,job_id=$6,updated_at=now() WHERE id=$1",[id,immediate?'executing':'approved',input.reason,request.user.id,immediate?new Date():service.due_at,jobId]); // 到期调度使用批准时快照
   await record(connection,request.actorId??request.user.id,'service.cancel_approved',service.id,{requestId:id,mode:current.mode,jobId,reason:input.reason}); // 排队和财务阻断一起提交
   return {status:immediate?'executing':'approved',jobId};          // 不返回虚构的已取消
  });
 }
}
