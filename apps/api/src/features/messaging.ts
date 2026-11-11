/* 模板、批量发送与客户关怀：发送意图先持久化，插件确认后才记成功，未知结果留人工核对。
 * 调用：GET/PUT /message-preferences；POST /admin/messaging/templates；POST /admin/messaging/batches + Idempotency-Key。
 * run()领取有限任务，scheduleCare()按真实注册/服务日期生成幂等任务，验证码发送不受营销偏好影响。
 */
import { Body, Controller, Get, Post, Put, Param, Query, Headers, Req, BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { notify } from './notification.js';
import { deliverMessage, verificationEnabled } from './verification.js';
import { DeliveryError } from '../utils/delivery.js';
import { verifyIdentity, factorFields } from './security.js';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const actor = (request: SessionRequest) => request.actorId ?? request.user.id;
const link = z.string().max(500).regex(/^\/(?!\/)[^\\\u0000-\u001f]*$/).nullable().default(null);
const templateInput = z.object({ name: z.string().trim().min(1).max(100), channel: z.enum(['site', 'email', 'sms']), category: z.enum(['transactional', 'marketing']), scope: z.enum(['account', 'service']).default('account'), subject: z.string().trim().min(1).max(160).regex(/^[^\r\n]*$/), body: z.string().trim().min(1).max(20000), link, active: z.boolean().default(true) }).strict();
const preferenceInput = z.object({ emailMarketing: z.boolean(), smsMarketing: z.boolean(), siteMarketing: z.boolean(), quietEnabled: z.boolean(), quietStart: z.number().int().min(0).max(1439), quietEnd: z.number().int().min(0).max(1439) }).strict().refine(input => !input.quietEnabled || input.quietStart !== input.quietEnd, '免打扰开始和结束时间不能相同');
const ruleInput = z.object({ name: z.string().trim().min(1).max(100), templateId: uuid, trigger: z.enum(['registered_days', 'inactive_days', 'service_created_days', 'service_due_days', 'service_overdue_days']), days: z.number().int().min(0).max(365), productIds: z.array(uuid).max(100).default([]), active: z.boolean().default(false) }).strict();
const prefColumns = 'email_marketing AS "emailMarketing",sms_marketing AS "smsMarketing",site_marketing AS "siteMarketing",quiet_enabled AS "quietEnabled",quiet_start AS "quietStart",quiet_end AS "quietEnd"';
const defaults = { emailMarketing: false, smsMarketing: false, siteMarketing: false, quietEnabled: false, quietStart: 1260, quietEnd: 480 };
const known = new Set(['name', 'email', 'phone', 'serviceName', 'serviceId', 'dueAt']);
const token = /{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g;
/** 模板只替换白名单文本，不执行表达式、HTML或任意对象路径。 */
function checkTemplate(input: z.infer<typeof templateInput>) { for (const text of [input.subject, input.body, input.link ?? '']) {
    for (const match of text.matchAll(token)) {
        if (!known.has(match[1]) || input.scope === 'account' && ['serviceName', 'serviceId', 'dueAt'].includes(match[1]))
            throw new BadRequestException('模板包含未知变量或与适用范围不符的变量');
    }
    if (/{{|}}/.test(text.replace(token, '')))
        throw new BadRequestException('模板变量请使用{{name}}这样的格式');
} }
function render(template: Record<string, any>, user: Record<string, any>, service?: Record<string, any>) { const variables: Record<string, string> = { name: user.name, email: user.email ?? '', phone: user.phone ?? '', serviceName: service?.service_name ?? '', serviceId: service?.service_id ?? '', dueAt: service?.due_at ? new Date(service.due_at).toLocaleDateString('zh-CN', { timeZone: user.timezone }) : '' }; if (template.scope === 'service' && !service)
    throw new BadRequestException('这份模板需要关联服务，请用于服务关怀规则'); const replace = (value: string) => value.replace(token, (_match, key: string) => variables[key]); const subject = replace(template.subject).replace(/[\u0000-\u001f\u007f]+/g, ' '), body = replace(template.body), destinationLink = template.link ? replace(template.link) : null; if (subject.length > 160 || body.length > 20000)
    throw new BadRequestException('代入资料后的模板内容过长'); if (destinationLink)
    read(link, destinationLink); return { subject, body, link: destinationLink }; }
/** @returns 免打扰结束时间；逐分钟校对时区，跨日和夏令时都按客户本地时间判断。 */
export function nextMessageTime(preferences: typeof defaults, timezone: string, at = new Date()): Date | null {
    if (!preferences.quietEnabled)
        return null;
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const quiet = (date: Date) => { const parts = formatter.formatToParts(date), minute = Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value); return preferences.quietStart < preferences.quietEnd ? minute >= preferences.quietStart && minute < preferences.quietEnd : minute >= preferences.quietStart || minute < preferences.quietEnd; };
    if (!quiet(at))
        return null;
    for (let minute = 1; minute <= 1800; minute++) {
        const next = new Date(at.getTime() + minute * 60000);
        if (!quiet(next))
            return next;
    }
    return new Date(at.getTime() + 86400000);
}
function destination(user: Record<string, any>, channel: string, category: string) { if (channel === 'site')
    return user.id; if (channel === 'email')
    return user.email && (category !== 'marketing' || user.email_verified_at) ? user.email : null; return user.phone_verified_at ? user.phone : null; }
async function preference(connection: Pick<typeof pool, 'query'>, userId: string) { return (await connection.query(`SELECT ${prefColumns} FROM message_preferences WHERE user_id=$1`, [userId])).rows[0] ?? defaults; }
async function enqueue(connection: PoolClient, template: Record<string, any>, user: Record<string, any>, dedup: string, batchId: string | null, ruleId: string | null, service?: Record<string, any>) { const text = render(template, user, service); return (await connection.query('INSERT INTO message_jobs(batch_id,rule_id,user_id,template_id,channel,category,subject,body,link,destination,service_id,service_due_at,dedup_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(dedup_key) DO NOTHING RETURNING id', [batchId, ruleId, user.id, template.id, template.channel, template.category, text.subject, text.body, text.link, destination(user, template.channel, template.category), service?.service_id ?? null, service?.due_at ?? null, dedup])).rowCount ?? 0; }
async function statistics(connection: Pick<typeof pool, 'query'>, id: string) { return (await connection.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='running')::int AS running,count(*) FILTER(WHERE state='sent')::int AS sent,count(*) FILTER(WHERE state='failed')::int AS failed,count(*) FILTER(WHERE state='uncertain')::int AS uncertain,count(*) FILTER(WHERE state='skipped')::int AS skipped,count(*) FILTER(WHERE state='cancelled')::int AS cancelled FROM message_jobs WHERE batch_id=$1", [id])).rows[0]; }
@Controller()
export default class Messaging implements OnModuleInit, OnModuleDestroy {
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    onModuleInit() { this.timer = setInterval(() => void this.run().catch(error => console.error(JSON.stringify({ feature: 'messaging', message: error instanceof Error ? error.message : '消息任务失败' }))), 5000); this.timer.unref(); }
    onModuleDestroy() { if (this.timer)
        clearInterval(this.timer); }
    @Get('message-preferences')
    async preferences(
    @Req()
    request: SessionRequest) { return { ...await preference(pool, request.user.id), timezone: (await pool.query('SELECT timezone FROM users WHERE id=$1', [request.user.id])).rows[0].timezone }; }
    @Put('message-preferences')
    async savePreferences(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { const input = read(preferenceInput, body); return transaction(async (connection) => { await connection.query('INSERT INTO message_preferences(user_id,email_marketing,sms_marketing,site_marketing,quiet_enabled,quiet_start,quiet_end) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET email_marketing=EXCLUDED.email_marketing,sms_marketing=EXCLUDED.sms_marketing,site_marketing=EXCLUDED.site_marketing,quiet_enabled=EXCLUDED.quiet_enabled,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,updated_at=now()', [request.user.id, input.emailMarketing, input.smsMarketing, input.siteMarketing, input.quietEnabled, input.quietStart, input.quietEnd]); await connection.query("UPDATE message_jobs SET state='cancelled',last_error='客户已取消此渠道营销订阅',updated_at=now() WHERE user_id=$1 AND state='queued' AND category='marketing' AND (channel='email' AND NOT $2 OR channel='sms' AND NOT $3 OR channel='site' AND NOT $4)", [request.user.id, input.emailMarketing, input.smsMarketing, input.siteMarketing]); await connection.query("UPDATE message_jobs SET run_at=now(),updated_at=now() WHERE user_id=$1 AND state='queued' AND last_error='处于客户设置的免打扰时段'", [request.user.id]); await record(connection, actor(request), 'messaging.preferences', request.user.id, input); return { ok: true }; }); }
    @Roles('admin')
    @Get('admin/messaging/options')
    async options() { return { site: true, email: await verificationEnabled('email'), sms: await verificationEnabled('sms'), variables: [...known] }; }
    @Roles('admin')
    @Get('admin/messaging/templates')
    async templates() { return (await pool.query('SELECT * FROM message_templates ORDER BY updated_at DESC,id')).rows; }
    @Roles('admin')
    @Post('admin/messaging/templates')
    async createTemplate(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.saveTemplate(null, body, request); }
    @Roles('admin')
    @Put('admin/messaging/templates/:id')
    async updateTemplate(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.saveTemplate(id, body, request); }
    private async saveTemplate(id: string | null, body: unknown, request: SessionRequest) { const input = read(templateInput, body); checkTemplate(input); return transaction(async (connection) => { if (id && (await connection.query("SELECT 1 FROM client_care_rules WHERE template_id=$1 AND active AND (trigger LIKE 'service_%')<>$2::boolean", [id, input.scope === 'service'])).rowCount)
        throw new ConflictException('请先调整关联的已启用关怀规则，再修改模板适用范围'); const values = [input.name, input.channel, input.category, input.scope, input.subject, input.body, input.link, input.active], saved = id ? await connection.query('UPDATE message_templates SET name=$1,channel=$2,category=$3,scope=$4,subject=$5,body=$6,link=$7,active=$8,updated_at=now() WHERE id=$9 RETURNING id', [...values, id]) : await connection.query('INSERT INTO message_templates(name,channel,category,scope,subject,body,link,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', values); if (!saved.rowCount)
        throw new NotFoundException('模板不存在'); await record(connection, actor(request), id ? 'messaging.template.update' : 'messaging.template.create', saved.rows[0].id, { channel: input.channel, category: input.category, active: input.active }); return saved.rows[0]; }); }
    @Roles('admin')
    @Post('admin/messaging/batches')
    async batch(
    @Body()
    body: unknown, 
    @Headers('idempotency-key')
    key: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ templateId: uuid, userIds: z.array(uuid).min(1).max(500) }).strict(), body), tokenValue = read(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), key), ids = [...new Set(input.userIds)].sort(), fingerprint = createHash('sha256').update(JSON.stringify({ templateId: input.templateId, userIds: ids })).digest('hex');
        return transaction(async (connection) => {
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`message-batch:${actor(request)}:${tokenValue}`]);
            const previous = (await connection.query('SELECT id,request_hash FROM message_batches WHERE created_by=$1 AND idempotency_key=$2', [actor(request), tokenValue])).rows[0];
            if (previous) {
                if (previous.request_hash !== fingerprint)
                    throw new ConflictException('提交标识已用于其它发送内容');
                return { id: previous.id, ...await statistics(connection, previous.id) };
            }
            const template = (await connection.query('SELECT * FROM message_templates WHERE id=$1 AND active FOR SHARE', [input.templateId])).rows[0];
            if (!template)
                throw new NotFoundException('模板不存在或已停用');
            if (template.scope !== 'account')
                throw new BadRequestException('批量发送请选择账户模板，服务模板用于关怀规则');
            if (template.channel !== 'site' && !await verificationEnabled(template.channel))
                throw new ServiceUnavailableException('此发送渠道尚未配置');
            const recipients = (await connection.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) AND NOT disabled ORDER BY id', [ids])).rows;
            if (recipients.length !== ids.length)
                throw new NotFoundException('部分接收账户不存在或已停用');
            const saved = (await connection.query('INSERT INTO message_batches(template_id,created_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4) RETURNING id', [template.id, actor(request), tokenValue, fingerprint])).rows[0];
            for (const user of recipients)
                await enqueue(connection, template, user, `batch:${saved.id}:${user.id}`, saved.id, null); // 所有意图先入库，再留一条批量审计
            await record(connection, actor(request), 'messaging.batch', saved.id, { templateId: template.id, channel: template.channel, category: template.category, count: recipients.length });
            return { id: saved.id, ...await statistics(connection, saved.id) };
        });
    }
    @Roles('admin')
    @Get('admin/messaging/batches')
    async batches() { return (await pool.query("SELECT b.id,b.created_at AS \"createdAt\",t.name,t.channel,t.category,(SELECT count(*)::int FROM message_jobs j WHERE j.batch_id=b.id) AS total,(SELECT count(*)::int FROM message_jobs j WHERE j.batch_id=b.id AND j.state='sent') AS sent,(SELECT count(*)::int FROM message_jobs j WHERE j.batch_id=b.id AND j.state='uncertain') AS uncertain,(SELECT count(*)::int FROM message_jobs j WHERE j.batch_id=b.id AND j.state IN ('queued','running')) AS pending FROM message_batches b JOIN message_templates t ON t.id=b.template_id ORDER BY b.created_at DESC LIMIT 200")).rows; }
    @Roles('admin')
    @Get('admin/messaging/batches/:id')
    async progress(
    @Param('id')
    id: string) { read(uuid, id); if (!(await pool.query('SELECT id FROM message_batches WHERE id=$1', [id])).rowCount)
        throw new NotFoundException('发送批次不存在'); return { id, ...await statistics(pool, id) }; }
    @Roles('admin')
    @Post('admin/messaging/batches/:id/cancel')
    async cancelBatch(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); const input = read(z.object({ reason: z.string().trim().min(1).max(1000) }).strict(), body); return transaction(async (connection) => { if (!(await connection.query('SELECT id FROM message_batches WHERE id=$1 FOR UPDATE', [id])).rowCount)
        throw new NotFoundException('发送批次不存在'); const changed = await connection.query("UPDATE message_jobs SET state='cancelled',last_error='管理员取消待发消息',updated_at=now() WHERE batch_id=$1 AND state='queued' RETURNING id", [id]); await record(connection, actor(request), 'messaging.batch.cancel', id, { count: changed.rowCount, reason: input.reason }); return { ok: true, cancelled: changed.rowCount }; }); }
    @Roles('admin')
    @Get('admin/messaging/jobs')
    async jobs(
    @Query()
    query: unknown) { const input = read(z.object({ batchId: uuid.optional(), state: z.enum(['queued', 'running', 'sent', 'failed', 'uncertain', 'skipped', 'cancelled']).optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict(), query), values = [input.batchId ?? null, input.state ?? null]; const where = 'WHERE ($1::uuid IS NULL OR j.batch_id=$1) AND ($2::text IS NULL OR j.state=$2)'; const [items, total] = await Promise.all([pool.query(`SELECT j.id,j.batch_id AS "batchId",j.channel,j.category,j.subject,j.state,j.attempts,j.max_attempts AS "maxAttempts",j.last_error AS "lastError",j.run_at AS "runAt",j.sent_at AS "sentAt",j.created_at AS "createdAt",u.name,u.email,u.phone FROM message_jobs j JOIN users u ON u.id=j.user_id ${where} ORDER BY j.created_at DESC,j.id LIMIT 50 OFFSET $3`, [...values, (input.page - 1) * 50]), pool.query(`SELECT count(*)::int AS total FROM message_jobs j ${where}`, values)]); return { items: items.rows, total: total.rows[0].total, page: input.page, limit: 50 }; }
    @Roles('admin')
    @Post('admin/messaging/jobs/:id/resolve')
    async resolve(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); const input = read(z.object({ action: z.enum(['retry', 'confirm_sent', 'cancel']), evidence: z.string().trim().min(1).max(1000), password: z.string().min(1).max(128), ...factorFields }).strict(), body); await verifyIdentity(request, input, 'messaging.resolve', 'admin'); return transaction(async (connection) => { const job = (await connection.query('SELECT * FROM message_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!job || !['failed', 'uncertain'].includes(job.state))
        throw new ConflictException('只能核对失败或结果未知的任务'); if (input.action === 'retry' && job.max_attempts >= 20 && job.attempts >= 20)
        throw new ConflictException('此任务已达到重试上限，请核对原发送记录'); if (input.action === 'confirm_sent' && job.state !== 'uncertain')
        throw new ConflictException('明确失败的任务不能标记机构已送达'); const state = input.action === 'retry' ? 'queued' : input.action === 'confirm_sent' ? 'sent' : 'cancelled'; await connection.query("UPDATE message_jobs SET state=$2,run_at=CASE WHEN $2='queued' THEN now() ELSE run_at END,max_attempts=CASE WHEN $2='queued' AND attempts>=max_attempts THEN LEAST(20,max_attempts+1) ELSE max_attempts END,sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END,last_error=$3,updated_at=now() WHERE id=$1", [id, state, input.action === 'confirm_sent' ? '已由管理员核对真实机构凭据' : input.action === 'cancel' ? '管理员核对后取消' : null]); await record(connection, actor(request), 'messaging.resolve', id, { action: input.action, evidence: input.evidence, previous: job.state, attempts: job.attempts }); return { ok: true, state }; }); }
    @Roles('admin')
    @Get('admin/messaging/care')
    async care() { return (await pool.query('SELECT r.id,r.name,r.template_id AS "templateId",r.trigger,r.days,r.product_ids AS "productIds",r.active,r.last_checked_at AS "lastCheckedAt",t.name AS "templateName",t.channel FROM client_care_rules r JOIN message_templates t ON t.id=r.template_id ORDER BY r.created_at DESC')).rows; }
    @Roles('admin')
    @Post('admin/messaging/care')
    async createCare(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.saveCare(null, body, request); }
    @Roles('admin')
    @Put('admin/messaging/care/:id')
    async updateCare(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.saveCare(id, body, request); }
    private async saveCare(id: string | null, body: unknown, request: SessionRequest) { const input = read(ruleInput, body); return transaction(async (connection) => { const template = (await connection.query('SELECT * FROM message_templates WHERE id=$1', [input.templateId])).rows[0]; if (!template)
        throw new NotFoundException('消息模板不存在'); const service = input.trigger.startsWith('service_'); if (template.scope !== (service ? 'service' : 'account'))
        throw new BadRequestException('模板适用范围与关怀条件不一致'); const products = [...new Set(input.productIds)]; if (!service && products.length)
        throw new BadRequestException('账户关怀条件不需要选择商品'); if (products.length && (await connection.query('SELECT id FROM products WHERE id=ANY($1::uuid[])', [products])).rowCount !== products.length)
        throw new NotFoundException('部分商品不存在'); const values = [input.name, input.templateId, input.trigger, input.days, products, input.active], saved = id ? await connection.query('UPDATE client_care_rules SET name=$1,template_id=$2,trigger=$3,days=$4,product_ids=$5,active=$6,last_checked_at=NULL,updated_at=now() WHERE id=$7 RETURNING id', [...values, id]) : await connection.query('INSERT INTO client_care_rules(name,template_id,trigger,days,product_ids,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', values); if (!saved.rowCount)
        throw new NotFoundException('关怀规则不存在'); await record(connection, actor(request), id ? 'messaging.care.update' : 'messaging.care.create', saved.rows[0].id, { trigger: input.trigger, days: input.days, active: input.active }); return saved.rows[0]; }); }
    /** 一次有界生成关怀意图；每条规则每分钟检查一次，事件快照决定稳定幂等键。 */
    async scheduleCare(): Promise<number> {
        return transaction(async (connection) => {
            const rules = (await connection.query("SELECT r.*,t.channel,t.category,t.scope,t.subject,t.body,t.link,t.active AS template_active FROM client_care_rules r JOIN message_templates t ON t.id=r.template_id WHERE r.active AND (r.last_checked_at IS NULL OR r.last_checked_at<now()-interval '1 minute') ORDER BY r.id FOR UPDATE OF r SKIP LOCKED LIMIT 25")).rows;
            let total = 0;
            const intended: Record<string, number> = {};
            for (const rule of rules) {
                await connection.query('UPDATE client_care_rules SET last_checked_at=now() WHERE id=$1', [rule.id]);
                if (!rule.template_active)
                    continue;
                if (rule.channel !== 'site' && !await verificationEnabled(rule.channel))
                    continue;
                const isService = rule.trigger.startsWith('service_'), condition = rule.trigger === 'registered_days' ? "(now() AT TIME ZONE u.timezone)::date-(u.created_at AT TIME ZONE u.timezone)::date=$1" : rule.trigger === 'inactive_days' ? "(now() AT TIME ZONE u.timezone)::date-(COALESCE(u.last_login_at,u.created_at) AT TIME ZONE u.timezone)::date>=$1" : rule.trigger === 'service_created_days' ? "(now() AT TIME ZONE u.timezone)::date-(s.created_at AT TIME ZONE u.timezone)::date=$1" : rule.trigger === 'service_due_days' ? "(s.due_at AT TIME ZONE u.timezone)::date-(now() AT TIME ZONE u.timezone)::date=$1" : "(now() AT TIME ZONE u.timezone)::date-(s.due_at AT TIME ZONE u.timezone)::date=$1";
                const source = isService ? 'services s JOIN users u ON u.id=COALESCE(s.current_owner_id,s.user_id)' : 'users u', anchor = isService ? (rule.trigger === 'service_created_days' ? 's.created_at' : 's.due_at') : rule.trigger === 'inactive_days' ? 'COALESCE(u.last_login_at,u.created_at)' : 'u.created_at';
                const candidates = (await connection.query(`SELECT u.*,${anchor}::text AS anchor${isService ? ',s.id AS service_id,s.name AS service_name,s.due_at::text AS due_at' : ''} FROM ${source} WHERE NOT u.disabled AND u.role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id) AND ${condition} AND NOT EXISTS(SELECT 1 FROM message_jobs existing WHERE existing.dedup_key='care:'||$${isService ? 3 : 2}::text||':'||${isService ? 's.id' : 'u.id'}::text||':'||${anchor}::text) ${isService ? "AND s.status IN ('active','suspended') AND (cardinality($2::uuid[])=0 OR COALESCE(s.current_product_id,s.product_id)=ANY($2))" : ''} ORDER BY u.id ${isService ? ',s.id' : ''} LIMIT 100`, isService ? [rule.days, rule.product_ids, rule.id] : [rule.days, rule.id])).rows;
                let added = 0;
                for (const user of candidates) {
                    const template = { ...rule, id: rule.template_id };
                    added += await enqueue(connection, template, user, `care:${rule.id}:${isService ? user.service_id : user.id}:${user.anchor}`, null, rule.id, isService ? user : undefined);
                }
                intended[rule.id] = added;
                total += added;
            }
            if (total)
                await record(connection, 'messaging', 'messaging.care.scheduled', 'care', { total, rules: intended }); // 所有用户外键锁取得后才进入审计锁
            return total;
        });
    }
    private async finish(job: Record<string, any>, state: string, error: string | null = null, runAt: Date | null = null) { return transaction(async (connection) => { const changed = await connection.query('UPDATE message_jobs SET state=$3,last_error=$4,run_at=COALESCE($5::timestamptz,run_at),sent_at=CASE WHEN $3=\'sent\' THEN now() ELSE sent_at END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state=\'running\' AND lease_until>now() RETURNING id', [job.id, job.lease_token, state, error, runAt]); if (changed.rowCount)
        await record(connection, 'messaging', 'messaging.' + state, job.id, { attempts: job.attempts, reason: error }); return !!changed.rowCount; }); }
    private async claim() { return transaction(async (connection) => { const found = (await connection.query("SELECT id FROM message_jobs WHERE state='queued' AND run_at<=now() ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0]; if (!found)
        return null; return (await connection.query("UPDATE message_jobs SET state='running',lease_token=gen_random_uuid(),lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1 RETURNING *,service_due_at::text AS service_due_text", [found.id])).rows[0]; }); }
    private async send(job: Record<string, any>) {
        const user = (await pool.query('SELECT * FROM users WHERE id=$1', [job.user_id])).rows[0];
        if (!user || user.disabled) {
            await this.finish(job, 'skipped', '接收账户不存在或已停用');
            return;
        }
        if (destination(user, job.channel, job.category) !== job.destination || !job.destination) {
            await this.finish(job, 'skipped', '接收地址未验证、已更换或不可用');
            return;
        }
        if (job.service_id && !(await pool.query("SELECT id FROM services WHERE id=$1 AND COALESCE(current_owner_id,user_id)=$2 AND due_at IS NOT DISTINCT FROM $3::timestamptz AND status IN ('active','suspended')", [job.service_id, user.id, job.service_due_text])).rowCount) {
            await this.finish(job, 'skipped', '服务归属或到期事实已变化');
            return;
        }
        const preferences = await preference(pool, user.id);
        if (job.category === 'marketing' && !preferences[(job.channel + 'Marketing') as keyof typeof defaults]) {
            await this.finish(job, 'skipped', '客户未订阅或已取消此渠道的营销消息');
            return;
        }
        const later = nextMessageTime(preferences, user.timezone);
        if (later) {
            await this.finish(job, 'queued', '处于客户设置的免打扰时段', later);
            return;
        }
        if (job.channel === 'site') {
            await transaction(async (connection) => { const changed = await connection.query("UPDATE message_jobs SET state='sent',attempts=attempts+1,sent_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING id", [job.id, job.lease_token]); if (!changed.rowCount)
                return; await notify(connection, user.id, job.subject, job.body, job.link ?? undefined); await record(connection, 'messaging', 'messaging.sent', job.id, { channel: 'site' }); });
            return;
        }
        try {
            if (!await verificationEnabled(job.channel)) {
                await this.finish(job, 'failed', '发送渠道尚未配置');
                return;
            }
        }
        catch {
            await this.finish(job, 'failed', '发送渠道配置不可用');
            return;
        }
        const attempt = await transaction(async (connection) => { const changed = (await connection.query("UPDATE message_jobs SET attempts=attempts+1,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING attempts", [job.id, job.lease_token])).rows[0]; if (changed)
            await record(connection, 'messaging', 'messaging.started', job.id, { attempt: changed.attempts, channel: job.channel }); return changed; });
        if (!attempt)
            return;
        job.attempts = attempt.attempts;
        try {
            await deliverMessage({ id: job.id, channel: job.channel, destination: job.destination, message: job.body, subject: job.subject, category: job.category });
            await this.finish(job, 'sent');
        }
        catch (error) {
            const known = error instanceof DeliveryError;
            if (known && !error.uncertain && error.retryable && job.attempts < job.max_attempts) {
                await this.finish(job, 'queued', '机构明确未受理，等待重试', new Date(Date.now() + Math.min(3600, 2 ** job.attempts * 30) * 1000));
                return;
            }
            await this.finish(job, known && !error.uncertain ? 'failed' : 'uncertain', known ? error.message : '发送结果未确认，请按任务编号核对机构记录');
        }
    }
    /** 定时器与测试共用生产路径；过期发送租约只转未知，不能自动盲目重发。 */
    async run(limit = 20): Promise<number> { if (this.running)
        return 0; this.running = true; try {
        await transaction(async (connection) => { const stale = await connection.query("UPDATE message_jobs SET state='uncertain',lease_token=NULL,lease_until=NULL,last_error='发送进程失联，机构结果未知，请核对',updated_at=now() WHERE id IN(SELECT id FROM message_jobs WHERE state='running' AND lease_until<=now() ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id"); if (stale.rowCount)
            await record(connection, 'messaging', 'messaging.leases_expired', 'queue', { ids: stale.rows.map(row => row.id) }); });
        await this.scheduleCare();
        let count = 0;
        for (; count < Math.min(100, limit); count++) {
            const job = await this.claim();
            if (!job)
                break;
            await this.send(job);
        }
        return count;
    }
    finally {
        this.running = false;
    } }
}
