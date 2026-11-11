/* 服务：读取已有资源、发起续费，状态只由已入账流程和开通任务改变。
 * 调用：GET /api/v1/services；POST /services/:id/renew + Idempotency-Key。
 */
import { Body, Controller, Get, Param, Post, Patch, Delete, Headers, Req, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common'; // 服务动作都核对所有权
import { z } from 'zod';                                          // 续费输入只在边界解析
import { pool, transaction } from './store.js';                    // 服务、续费订单共享事务
import { ensureUpgradeIdle } from './upgrade.js';                  // 未决配置变更不得被并行资源动作跨越
import { record } from './audit.js';                              // 资源与资金关系可追溯
import { periodSchema,periods,renewalWindowSQL } from './catalogue.js';                    // 续费沿用已保存的周期合同
import { fulfill } from './settlement.js';                        // 免费续费也使用相同的一次性资源交付规则
import { read, uuid } from '../utils/input.js';                    // 保持标准UUID边界
import { Roles,type SessionRequest } from '../utils/access.js';    // 客户与管理员动作显式分开
import { factorFields,checkPassword,checkFactor,proofLimit,proofComplete } from './security.js'; // 破坏性资源动作复用真正的身份复核

export const serviceColumns=`s.id,s.name,s.status,s.due_at AS "dueAt",s.external_id AS "externalId",s.created_at AS "createdAt",s.termination_requested_at AS "terminationRequestedAt",s.billing_period AS "billingPeriod",s.billing_months AS "billingMonths",s.billing_seconds AS "billingSeconds",s.configuration_labels AS "configurationLabels",s.group_id AS "groupId",s.remark,s.auto_renew AS "autoRenew",${renewalWindowSQL('s')} AS "autoRenewWindowSeconds",p.name AS "productName",COALESCE(s.renew_amount_cents,p.price_cents)::text AS "priceCents",s.billing_currency AS currency,(SELECT decimals FROM currencies WHERE code=s.billing_currency) AS "currencyDecimals",
  (SELECT o.status FROM orders o WHERE o.id=s.order_id) AS "orderStatus",(SELECT i.id FROM invoices i JOIN orders o ON o.id=i.order_id LEFT JOIN renewals r ON r.order_id=o.id WHERE (i.order_id=s.order_id OR r.service_id=s.id) AND i.user_id=COALESCE(s.current_owner_id,s.user_id) ORDER BY i.created_at DESC LIMIT 1) AS "invoiceId",
  (SELECT jsonb_build_object('id',j.id,'action',j.action,'state',j.state,'createdAt',j.created_at) FROM jobs j WHERE j.service_id=s.id AND j.state IN ('queued','running','waiting','manual_review') ORDER BY j.created_at,j.id LIMIT 1) AS operation`; // 运行状态与在途操作分别展示，收到供应商确认前不提前变更状态

@Controller()
export default class Service {
  /** @returns 当前账号的全部服务。 */
  @Get('services') async list(@Req() request:SessionRequest) {
    return (await pool.query(`SELECT ${serviceColumns} FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE COALESCE(s.current_owner_id,s.user_id)=$1 ORDER BY s.created_at DESC LIMIT 100`,[request.user.id])).rows; // 账号范围在数据库查询中固定
  }

  /** @param id 服务ID。@returns 服务当前状态。 */
  @Get('services/:id') async get(@Param('id') id:string,@Req() request:SessionRequest) {
    const result=await pool.query(`SELECT ${serviceColumns} FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 AND COALESCE(s.current_owner_id,s.user_id)=$2`,[read(uuid,id),request.user.id]); // 外部ID仅展示自己的服务
    if (!result.rowCount) throw new NotFoundException('服务不存在'); // 不泄露其它账号资源
    return result.rows[0];                                        // 真实状态由守护进程维护
  }

  /** @param id 要续费的服务。@param key 幂等键。@returns 续费账单。 */
  @Post('services/:id/renew') async renew(@Param('id') id:string,@Headers('idempotency-key') key:unknown,@Body() body:unknown,@Req() request:SessionRequest,automatic?:{dueAt:string},expectedVersion?:number) {
    read(uuid,id);                                                 // 所有权检查前验证ID形式
    const input=read(z.object({period:periodSchema}).strict(),body);      // 续费不接受自报金额或自造周期
    const token=read(z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),key); // 重试不能生成第二张账单
    return transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${request.user.id}:${token}`]); // 与新订购共享幂等命名空间
      const prior=await connection.query('SELECT o.*,i.id AS invoice_id FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.idempotency_key=$2',[request.user.id,token]); // 先查已经保存的续费
      if (prior.rowCount) {
        if (prior.rows[0].request_hash!==`renew:${id}${input.period==='month'?'':':'+input.period}`) throw new ConflictException('此提交标识已用于其它操作'); // 同键不同资源明确拒绝
        return {id:prior.rows[0].id,invoiceId:prior.rows[0].invoice_id,serviceId:id,amountCents:prior.rows[0].amount_cents,currency:prior.rows[0].currency,status:prior.rows[0].status}; // 返回原订单
      }
      const found=await connection.query("SELECT s.*,COALESCE(s.current_product_id,s.product_id) AS effective_product_id,COALESCE(s.renew_amount_cents,p.price_cents)::text AS price_cents,s.billing_currency AS currency FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 AND COALESCE(s.current_owner_id,s.user_id)=$2 AND s.status IN ('active','suspended') AND s.termination_requested_at IS NULL FOR UPDATE OF s",[id,request.user.id]); // 老客户保留合同价格，已请求终止的资源不再生成续费单
      if (!found.rowCount) throw new ConflictException('服务当前不能续费'); // 不给取消服务创建新账单
      const service=found.rows[0];
      if(expectedVersion!==undefined && !(await connection.query('SELECT id FROM users WHERE id=$1 AND NOT disabled AND session_version=$2 FOR SHARE',[request.user.id,expectedVersion])).rowCount)throw new ConflictException('续费任务的账号授权已变化，请重新登录后提交'); // 批量后台任务沿用提交时凭据版本，不能升级旧授权
      await ensureUpgradeIdle(connection,id); // 付款中的新配置不能继续按旧价续费
      if(automatic && !(await connection.query(`SELECT u.id FROM users u JOIN services s ON COALESCE(s.current_owner_id,s.user_id)=u.id WHERE s.id=$1 AND u.id=$3 AND NOT u.disabled AND s.auto_renew AND s.due_at=$2::timestamptz AND s.due_at<=now()+make_interval(secs=>${renewalWindowSQL('s')}) FOR SHARE OF u`,[id,automatic.dueAt,request.user.id])).rowCount)throw new ConflictException('自动续费授权或到期日已变化'); // 调度选中后仍以锁后的授权为准
      if(!periods[service.billing_period as keyof typeof periods]?.renewable || service.billing_period!==input.period)throw new ConflictException('请选择当前服务的计费周期；一次性服务无需续费');                                 // 当前续费价格来自商品
      const order=await connection.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,currency,kind,items_explicit) VALUES($1,$2,$3,$4,$5,$6,'renew',true) RETURNING id",[request.user.id,service.effective_product_id,token,`renew:${id}${input.period==='month'?'':':'+input.period}`,service.price_cents,service.currency]); // 续费不消耗新资源库存
      await connection.query('INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,billing_months,configuration,configuration_labels,billing_seconds,pricing_source) SELECT $1,$2,name,1,$3,$4,$4,$5,$6,$7,$8,$9 FROM products WHERE id=$2',[order.rows[0].id,service.effective_product_id,service.billing_period,service.price_cents,service.billing_months,service.configuration,service.configuration_labels,service.billing_seconds,service.pricing_source]); // 续费快照保留当前合同周期与配置
      const invoice=await connection.query('INSERT INTO invoices(order_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4) RETURNING id',[order.rows[0].id,request.user.id,service.price_cents,service.currency]); // 支付后才延长到期日
      await connection.query('INSERT INTO renewals(order_id,service_id,period_months,period_seconds) VALUES($1,$2,$3,$4)',[order.rows[0].id,id,service.billing_months,service.billing_seconds]); // 服务关系保存在专用续费记录
      const free=service.price_cents==='0';                        // 免费合同不生成虚构收款
      if (free) {
        await connection.query("UPDATE orders SET status='paid' WHERE id=$1",[order.rows[0].id]); // 0元续费不挂在不可支付状态
        await connection.query("UPDATE invoices SET status='paid',paid_at=now() WHERE id=$1",[invoice.rows[0].id]); // 免费成交仍保留账单事实
        await fulfill(connection,{id:invoice.rows[0].id,order_id:order.rows[0].id},false); // 免费续费也不能复活已终止资源
        await record(connection,request.actorId??request.user.id,'order.free',order.rows[0].id,{serviceId:id,kind:'renew'}); // 审计注明免费续费，不计现金收入
      }
      await record(connection,request.actorId??request.user.id,'service.renew',id,{orderId:order.rows[0].id,amountCents:service.price_cents}); // 记录续费报价事实
      return {id:order.rows[0].id,invoiceId:invoice.rows[0].id,serviceId:id,amountCents:service.price_cents,currency:service.currency,status:free?'paid':'unpaid'}; // 免费方案直接显示完成，其余进入收银台
    });
  }

  /** @returns 当前账号自定义的服务分组。 */
  @Get('service-groups') async groups(@Req() request:SessionRequest) {
    return (await pool.query('SELECT id,name,sort FROM service_groups WHERE user_id=$1 ORDER BY sort,name',[request.user.id])).rows; // 分组属于账号，不跟随转移
  }
  /** @returns 新建或已存在的同名分组。 */
  @Post('service-groups') async group(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({name:z.string().trim().min(1).max(80)}).strict(),body);return transaction(async connection=>{
      const saved=await connection.query('INSERT INTO service_groups(user_id,name) VALUES($1,$2) ON CONFLICT(user_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,sort',[request.user.id,input.name]); // 同名重试只返回一个分组
      await record(connection,request.actorId??request.user.id,'service.group_created',saved.rows[0].id,{name:input.name});return saved.rows[0]; // 分组修改有审计
    });
  }
  /** @returns 删除分组，服务本身保留。 */
  @Delete('service-groups/:id') async removeGroup(@Param('id') id:string,@Req() request:SessionRequest) {
    read(uuid,id);return transaction(async connection=>{const removed=await connection.query('DELETE FROM service_groups WHERE id=$1 AND user_id=$2 RETURNING id',[id,request.user.id]);if(!removed.rowCount)throw new NotFoundException('分组不存在');await record(connection,request.actorId??request.user.id,'service.group_deleted',id,{});return {ok:true};}); // 外键只清空分组，不删资源
  }
  /** @returns 保存后的名称、备注和分组。 */
  @Patch('services/:id') async update(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);const input=read(z.object({name:z.string().trim().min(1).max(100).optional(),remark:z.string().trim().max(1000).optional(),groupId:uuid.nullable().optional()}).strict().refine(value=>Object.keys(value).length>0),body); // 客户不能修改到期日或真实状态
    return transaction(async connection=>{
      const owned=await connection.query('SELECT id FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 FOR UPDATE',[id,request.user.id]);if(!owned.rowCount)throw new NotFoundException('服务不存在'); // 锁后归属校验
      if(input.groupId&&!(await connection.query('SELECT 1 FROM service_groups WHERE id=$1 AND user_id=$2 FOR SHARE',[input.groupId,request.user.id])).rowCount)throw new NotFoundException('分组不存在'); // 禁止关联他人分组
      await connection.query('UPDATE services SET name=COALESCE($2,name),remark=COALESCE($3,remark),group_id=CASE WHEN $4 THEN $5::uuid ELSE group_id END WHERE id=$1',[id,input.name??null,input.remark??null,'groupId' in input,input.groupId??null]); // 只更新客户可编辑字段
      await record(connection,request.actorId??request.user.id,'service.updated',id,input);return {ok:true}; // 备注不传给供应商插件
    });
  }

  /** @returns 管理员视角的服务与客户，不包含登录凭据。 */
  @Roles('admin') @Get('admin/services') async all() {
    return (await pool.query(`SELECT ${serviceColumns},u.email,p.provider,s.suspend_type AS "suspendType",s.suspend_reason AS "suspendReason" FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) JOIN users u ON u.id=COALESCE(s.current_owner_id,s.user_id) ORDER BY s.created_at DESC LIMIT 200`)).rows; // 真实开通状态不由后台列表编辑
  }

  /** @param id 服务ID。@param body 动作、说明与当前管理员证明。@param key 本次动作的稳定提交键。@returns 已持久化的操作任务。 */
  @Roles('admin') @Post('admin/services/:id/actions') async action(@Param('id') id:string,@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                 // 资源标识先在边界整理
    const input=read(z.object({action:z.enum(['suspend','resume','terminate']),reason:z.string().trim().min(1).max(500),password:z.string().min(1).max(128),...factorFields}).strict(),body); // 每个动作明确说明实际原因
    const token=read(z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),key); // 重试不会多执行一次删资源
    const limits=await proofLimit(request);                       // 当前密码和验证码都有失败预算
    await transaction(async connection=>{
      const administrator=await checkPassword(connection,request.user.id,input.password); // 当前会话不足以直接破坏资源
      if (administrator.role!=='admin') throw new ForbiddenException('管理员权限已变化，请重新登录'); // 角色撤销后不能利用竞态执行
      await checkFactor(connection,request.user.id,input,'service.action'); // 已开启双重验证时再次证明
    });                                                           // 先提交身份审计，再按服务→审计顺序操作，避免与Go交付互锁
    const result=await transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`resource:${request.user.id}:${token}`]); // 同键并发动作先串行核对，稳定返回原任务
      const old=await connection.query('SELECT id,service_id,action,payload,state FROM jobs WHERE dedup_key=$1',[`admin:${request.user.id}:${token}`]); // 同一管理员的提交标识只有一种内容
      if (old.rowCount) {
        if (old.rows[0].service_id!==id || old.rows[0].action!==input.action || old.rows[0].payload.reason!==input.reason) throw new ConflictException('这个提交标识已用于其它资源操作'); // 不把不同动作误判为重试
        return {id:old.rows[0].id,state:old.rows[0].state};           // 返回已保存的执行状态
      }
      const found=await connection.query('SELECT s.*,p.provider FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 FOR UPDATE OF s',[id]); // 同一资源变更按服务行串行
      if (!found.rowCount) throw new NotFoundException('服务不存在'); // 不创建不存在资源的操作
      const service=found.rows[0];
                                // 状态来自数据库，不来自按钮标签
      await ensureUpgradeIdle(connection,id); // 先结束已经付费的资源变更
      if (service.termination_requested_at) throw new ConflictException('此服务正在终止，请先跟进原任务'); // 不用其它动作覆盖已确认的终止意图
      const allowed=input.action==='suspend'?['active']:input.action==='resume'?['suspended']:['active','suspended']; // 已取消/未交付资源不能被随意操作
      if (!allowed.includes(service.status)) throw new ConflictException('服务当前状态不允许此操作'); // 防止重复暂停或重复删除
      const busy=await connection.query("SELECT id FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review') LIMIT 1",[id]); // 未知结果未核对前不操作同一资源
      if (busy.rowCount) throw new ConflictException('此服务已有正在处理的操作，请先核对结果'); // 避免相互覆盖的供应商请求
      const job=await connection.query('INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,$2,$3,$4,$5) RETURNING id,state',[id,input.action,service.provider,{reason:input.reason,requestedBy:request.user.id},`admin:${request.user.id}:${token}`]); // 只排队，不伪造供应商已完成
      if (input.action==='terminate') await connection.query('UPDATE services SET termination_requested_at=now() WHERE id=$1',[id]); // 阻止新的续费与checkout，仍保留供应商的真实运行状态
      await record(connection,request.actorId??request.user.id,'service.action',id,{jobId:job.rows[0].id,action:input.action,reason:input.reason}); // 操作、权限证明与排队共同提交
      return job.rows[0];                                         // 守护进程接下来执行真实资源动作
    });
    await proofComplete(limits);                                 // 完整授权成功后才清除失败次数
    return result;                                               // 后台可用任务ID跟进
  }
}
