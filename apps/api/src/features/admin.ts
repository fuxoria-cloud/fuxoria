/* 管理：商品上架、客户权限、业务概览、人工开通和审计查询。
 * 调用：管理员会话访问 GET /api/v1/admin/overview；POST /admin/products {name,description,priceCents,stock,provider}。
 * 人工交付：POST /admin/jobs/:id/complete {externalId:'真实资源标识'}，只能完成manual任务。
 */
import { currencyDefinition } from './currency.js';
import { Body, Controller, Get, Param, Post, Put, Req, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common'; // 管理动作保持显式权限
import { z } from 'zod';                                          // 配置也是外部输入边界
import { pool, transaction } from './store.js';                    // 管理不能绕过数据库事务
import { record } from './audit.js';                              // 每次资金或权限变动留痕
import { payments } from './payment.js';                          // 显示真实插件配置状态
import { productColumns } from './product.js';                    // 商品字段不重复定义
import { Roles, type SessionRequest } from '../utils/access.js';   // 所有后台动作要求管理员
import { read, uuid, price } from '../utils/input.js';             // 免费报价与真实资金收付明确分开
import { factorFields,checkPassword,checkFactor,proofLimit,proofComplete } from './security.js'; // 取消人工移交也必须明确证明当前操作者

const product=z.object({name:z.string().trim().min(1).max(100),description:z.string().trim().max(5000).default(''),priceCents:price,currency:z.string().regex(/^[A-Z]{3}$/).default('CNY'),stock:z.number().int().nonnegative().nullable().default(null),provider:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).default('manual'),active:z.boolean().default(true)}).strict(); // 后台不能提交SQL或可执行路径

@Controller('admin') @Roles('admin')
export default class Admin {
  /** @returns 财务与运营统计。 */
  @Get('overview') async overview() {
    const result=await pool.query("SELECT (SELECT count(*)::int FROM users) AS \"userCount\",(SELECT count(*)::int FROM services WHERE status='active') AS \"serviceCount\",(SELECT count(*)::int FROM orders) AS \"orderCount\",(SELECT count(*)::int FROM jobs WHERE state='failed') AS \"failedJobCount\",(SELECT (-COALESCE(sum(amount_cents),0))::text FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account LIKE 'income:%' AND t.currency='CNY') AS \"revenueCents\",(SELECT count(*)::int FROM tickets WHERE status='open') AS \"ticketCount\""); // 收入来自支付流水而非可编辑订单
    return {...result.rows[0],currency:'CNY',revenueTotals:(await pool.query("SELECT t.currency,(SELECT decimals FROM currencies WHERE code=t.currency) AS \"currencyDecimals\",(-COALESCE(sum(e.amount_cents),0))::text AS \"amountCents\" FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account LIKE 'income:%' GROUP BY t.currency ORDER BY t.currency")).rows};                                        // 所有金额都保持整数分文本
  }

  /** @returns 所有商品，包含下架项目。 */
  @Get('products') async products() { return (await pool.query(`SELECT ${productColumns} FROM products ORDER BY created_at DESC`)).rows; } // 商品单一数据源

  /** @param body 商品定价和库存。@returns 新商品。 */
  @Post('products') async createProduct(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(product,body);                                // 定价只接受整数分
    return transaction(async connection=>{
      await currencyDefinition(connection,input.currency,true);
      const result=await connection.query(`INSERT INTO products(name,description,price_cents,currency,stock,provider,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${productColumns}`,[input.name,input.description,input.priceCents,input.currency,input.stock,input.provider,input.active]); // 商品不会自动触发资源开通
      await record(connection,request.user.id,'product.create',result.rows[0].id,input); // 报价和库存变更留下证据
      await connection.query('SELECT pg_notify($1,$2)',['content_changed',JSON.stringify({paths:['/products','/'],productId:result.rows[0].id})]); // 提交后通知差异静态发布进程
      return result.rows[0];                                      // 价格立即对动态查询生效
    });
  }

  /** @param id 商品ID。@param body 商品修改值。@returns 修改后的商品。 */
  @Put('products/:id') async updateProduct(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                 // 修改不能指向任意表
    const input=read(product,body);                                // 全字段编辑避免隐式状态拼接
    return transaction(async connection=>{
      const prior=await connection.query('SELECT provider FROM products WHERE id=$1 FOR UPDATE',[id]); // 和新订购使用同一商品锁，避免切换供应商竞态
      if (!prior.rowCount) throw new NotFoundException('商品不存在'); // 在检查已有服务前确认目标
      if (prior.rows[0].provider!==input.provider) {
        const active=await connection.query("SELECT 1 FROM services WHERE COALESCE(current_product_id,product_id)=$1 AND status<>'cancelled' UNION ALL SELECT 1 FROM service_upgrades u JOIN orders o ON o.id=u.order_id WHERE u.target_product_id=$1 AND u.status IN ('unpaid','queued','review') AND o.status<>'cancelled' LIMIT 1",[id]); // 既有资源的externalId属于原供应商
        if (active.rowCount) throw new ConflictException('这个商品已有服务，不能更换开通插件；请为新供应商创建另一款商品'); // 不把旧资源操作误发给新供应商
      }
      await currencyDefinition(connection,input.currency,true);
      const result=await connection.query(`UPDATE products SET name=$1,description=$2,price_cents=$3,currency=$4,stock=$5,provider=$6,active=$7 WHERE id=$8 RETURNING ${productColumns}`,[input.name,input.description,input.priceCents,input.currency,input.stock,input.provider,input.active,id]); // 已有订单的成交价格不随商品改价
      if (!result.rowCount) throw new NotFoundException('商品不存在'); // 修改无效不能显示成功
      await record(connection,request.user.id,'product.update',id,input); // 管理操作和审计共同提交
      await connection.query('SELECT pg_notify($1,$2)',['content_changed',JSON.stringify({paths:['/products','/'],productId:id})]); // CDN内容差异发布订阅点
      return result.rows[0];                                      // 确认后的商品作为返回值
    });
  }

  /** @returns 最近客户，隐藏密码摘要。 */
  @Get('users') async users() { return (await pool.query('SELECT id,email,phone,name,role,disabled,created_at AS "createdAt" FROM users ORDER BY created_at DESC LIMIT 200')).rows; } // 账号密钥不进入管理列表

  /** @returns 最近订单及客户、商品。 */
  @Get('orders') async orders() { return (await pool.query('SELECT o.id,o.status,o.kind,o.amount_cents::text AS "amountCents",o.currency,o.created_at AS "createdAt",u.email,p.name AS "productName",i.id AS "invoiceId" FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN products p ON p.id=o.product_id JOIN invoices i ON i.order_id=o.id ORDER BY o.created_at DESC LIMIT 200')).rows; } // 订单状态能对应到真实账单

  /** @returns 排队、运行、失败与人工交付任务。 */
  @Get('jobs') async jobs() { return (await pool.query(`SELECT j.id,j.service_id AS "serviceId",j.action,j.provider,j.state,j.attempts,j.max_attempts AS "maxAttempts",j.run_at AS "runAt",j.last_error AS "lastError",j.result,j.created_at AS "createdAt",j.payload->>'reason' AS "scheduledReason",COALESCE((j.result->>'manualRequired')::boolean,false) AS "manualRequired",COALESCE(j.provider='manual' AND j.state='queued' AND j.action='suspend' AND j.payload->>'reason'='overdue' AND j.payload ? 'dueAt' AND (s.termination_requested_at IS NOT NULL OR s.status<>'active' OR s.due_at IS NULL OR s.due_at>now() OR s.due_at<>(j.payload->>'dueAt')::timestamptz),false) AS "skipAvailable" FROM jobs j JOIN services s ON s.id=j.service_id ORDER BY j.created_at DESC,j.id LIMIT 200`)).rows; } // 交给人工后的待办不能被后台清理器冒充供应商执行成功

  /** @param id 过时的人工到期暂停任务。@param body 当前身份与未执行核实说明。@returns 只关闭待办，服务真实状态保持原样。 */
  @Post('jobs/:id/skip') async skip(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                 // 只允许标准任务标识
    const input=read(z.object({reason:z.string().trim().min(1).max(500),password:z.string().min(1).max(128),...factorFields}).strict(),body); // 必须先核实供应商并未执行暂停
    const limits=await proofLimit(request);                        // 身份复核有独立失败预算
    await transaction(async connection=>{
      const administrator=await checkPassword(connection,request.user.id,input.password); // 登录会话不能代替当次证明
      if (administrator.role!=='admin') throw new ConflictException('管理员权限已变化，请重新登录'); // 当前角色仍须有效
      await checkFactor(connection,request.user.id,input,'job.manual_skip'); // 已启用MFA时消费当次因子
    });                                                           // 身份审计先提交，资源事务仍按任务→服务→审计加锁
    await proofComplete(limits);                                  // 证明成功即清除错误凭据计数，业务状态冲突不算输错密码
    return transaction(async connection=>{
      const found=await connection.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[id]); // 与人工完成、Go领取互斥
      if (!found.rowCount) throw new NotFoundException('任务不存在'); // 不返回无效成功
      const job=found.rows[0];                                     // 已确认跳过的重复提交没有第二次副作用
      if (job.state==='succeeded' && job.result?.skipped && job.result?.reason==='manual_not_executed') return {ok:true,skipped:true}; // 允许网络重试
      if (job.provider!=='manual' || job.state!=='queued' || job.action!=='suspend' || job.payload.reason!=='overdue' || !Object.hasOwn(job.payload,'dueAt')) throw new ConflictException('只能取消尚未执行的人工到期暂停待办，请先核对原任务'); // 人工说明恰好写overdue不构成系统到期任务
      const service=(await connection.query("SELECT (termination_requested_at IS NOT NULL OR status<>'active' OR due_at IS NULL OR due_at>now() OR due_at<>$2::timestamptz) AS stale FROM services WHERE id=$1 FOR UPDATE",[job.service_id,job.payload.dueAt])).rows[0]; // PostgreSQL保留完整时间精度，不把微秒经JavaScript截断
      if (!service.stale) throw new ConflictException('服务仍已到期，请核对到期时间或继续处理原暂停待办'); // 当前仍有效的欠费任务不能随手清掉
      await connection.query("UPDATE jobs SET state='succeeded',result=$2,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1",[id,{skipped:true,reason:'manual_not_executed',confirmedBy:request.user.id,note:input.reason}]); // 明确记录未执行，而非供应商已暂停
      await record(connection,request.user.id,'job.manual_skip',job.service_id,{jobId:id,reason:input.reason,confirmedNotExecuted:true}); // 操作者、核实说明和关闭事实一起提交
      return {ok:true,skipped:true};                               // 不改变外部资源标识、运行状态或到期日
    });
  }

  /** @param id 失败任务。@returns 已重新排队。 */
  @Post('jobs/:id/retry') async retry(@Param('id') id:string,@Req() request:SessionRequest) {
    read(uuid,id);                                                 // 任务标识在边界验证
    return transaction(async connection=>{
      const result=await connection.query("UPDATE jobs SET state='queued',attempts=0,run_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND state='failed' RETURNING id",[id]); // 只重试已停止任务，不抢运行中租约
      if (!result.rowCount) throw new ConflictException('只能重试已失败的任务'); // 防止人为重复执行开通
      await record(connection,request.user.id,'job.retry',id,{});   // 谁重新执行可追查
      return {ok:true};                                           // 守护进程会重新领取
    });
  }

  /** @param id 人工开通任务。@param body 真实资源ID。@returns 人工交付已确认。 */
  @Post('jobs/:id/complete') async complete(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);                                                 // 不允许把任意数据库对象当任务
    const input=read(z.object({externalId:z.string().trim().min(1).max(200).optional(),note:z.string().trim().max(1000).optional()}).strict(),body); // 开通填真实资源标识，其它动作填实际处理说明
    return transaction(async connection=>{
      const found=await connection.query("SELECT * FROM jobs WHERE id=$1 AND provider='manual' FOR UPDATE",[id]); // 人工确认只用于明确选择的人工插件
      if (!found.rowCount) throw new NotFoundException('人工交付任务不存在'); // 不可绕过供应商插件结果
      const job=found.rows[0];                                     // 完成后重复提交只返回已确认状态
      if (job.state==='succeeded' && job.result?.skipped) throw new ConflictException('此待办已确认跳过；若供应商实际已暂停，请先核对资源再记录实际操作'); // 跳过不能被旧确认请求伪装成实际完成
      if (job.state==='succeeded') return {ok:true};               // 不重复延长到期时间
      if (job.state==='running') throw new ConflictException('任务正在处理，请稍后再确认'); // 不覆盖守护进程持有的租约
      if (job.action==='provision' && !input.externalId) throw new BadRequestException('首次交付请填写真实资源标识'); // 未实际交付不能显示已开通
      if (job.action!=='provision' && !input.note) throw new BadRequestException('请填写实际处理说明，再确认此资源操作'); // 暂停和删除不靠无说明点击完成
      await connection.query("UPDATE jobs SET state='succeeded',result=$2,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1",[id,{externalId:input.externalId,note:input.note,confirmedBy:request.user.id}]); // 人工结果明示由谁确认
      const overdue=job.payload.reason==='overdue' && Object.hasOwn(job.payload,'dueAt'); // 用户手填说明不能变成自动恢复策略
      await connection.query("UPDATE services SET status=CASE $2 WHEN 'provision' THEN 'active' WHEN 'resume' THEN 'active' WHEN 'suspend' THEN 'suspended' WHEN 'terminate' THEN 'cancelled' ELSE status END,external_id=CASE WHEN $2='provision' THEN $3 ELSE external_id END,due_at=CASE WHEN $2 IN ('provision','renew') AND billing_months=0 AND billing_seconds=0 THEN NULL WHEN $2='provision' THEN COALESCE(due_at,now()+make_interval(months=>billing_months,secs=>billing_seconds)) WHEN $2='renew' THEN GREATEST(COALESCE(due_at,now()),now())+make_interval(months=>billing_months,secs=>billing_seconds) ELSE due_at END,suspend_type=CASE WHEN $2='suspend' THEN $4 WHEN $2='resume' THEN '' ELSE suspend_type END,suspend_reason=CASE WHEN $2='suspend' THEN $5 WHEN $2='resume' THEN '' ELSE suspend_reason END,suspended_at=CASE WHEN $2='suspend' THEN now() WHEN $2='resume' THEN NULL ELSE suspended_at END WHERE id=$1",[job.service_id,job.action,input.externalId ?? null,overdue?'overdue':'manual',job.payload.reason ?? input.note ?? '']); // 按成交合同月数交付，一次性资源没有到期日
      if (job.action==='suspend' && overdue) {
        await connection.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) SELECT s.id,'resume',p.provider,jsonb_build_object('reason','renewal_raced_overdue'),'resume:overdue-race:'||$2::text FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1::uuid AND s.status='suspended' AND s.suspend_type='overdue' AND s.due_at>now() AND s.termination_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE service_id=s.id AND action='resume' AND state IN ('queued','running','waiting','manual_review')) ON CONFLICT(dedup_key) DO NOTHING",[job.service_id,id]); // 续费先到账而人工随后实际暂停时，保留暂停事实再安排一次真实恢复
      }
      if(job.action==='upgrade')await connection.query('SELECT apply_service_upgrade($1::uuid)',[id]); // 与Go同步/回调使用同一真实交付规则
      if(job.action==='terminate')await connection.query("UPDATE service_cancellations SET status='executed',updated_at=now() WHERE service_id=$1 AND job_id=$2 AND status='executing'",[job.service_id,id]); // 人工确认真实删除后，和服务取消事实同事务完成申请
      await record(connection,request.user.id,'service.deliver',job.service_id,{jobId:id,action:job.action,externalId:input.externalId,note:input.note}); // 每个动作的交付事实进入审计链
      return {ok:true};                                           // 业务与审计共同提交后回应
    });
  }

  /** @returns 最近审计链节点。 */
  @Get('audit') async audit() { return (await pool.query('SELECT id::text,actor,action,target,details,previous_hash AS "previousHash",hash,created_at AS "createdAt" FROM audit ORDER BY audit.id DESC LIMIT 200')).rows; } // 只读接口不允许修改历史

  /** @returns 可发现支付插件及配置是否齐全。 */
  @Get('plugins') plugins() { return payments.list(); }              // 密钥和证书正文不返回给浏览器
}
