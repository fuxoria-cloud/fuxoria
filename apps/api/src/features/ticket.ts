/* 工单：客户沟通、部门分流、分配、内部备注、评价和同客户工单合并。
 * 调用：POST /tickets {subject,message,departmentId?,serviceId?,priority?}；POST /tickets/:id/replies。
 * 客服仅处理所属部门或明确分配的工单；内部备注不会返回客户，回复和关闭在同一行上互斥。
 */
import { Body, Controller, Get, Param, Post, Query, Req, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { notify } from './notification.js';
import {customValues,captureTicketFields,ticketFields} from './fields.js'; // 定义与权限只由字段主体维护
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const message = z.string().trim().min(1, '请填写问题内容').max(20000);
const actor = (request: SessionRequest) => request.actorId ?? request.user.id;
const scope = "(t.user_id=$1 OR $2::boolean OR ($3::boolean AND (t.assigned_to=$1 OR EXISTS(SELECT 1 FROM support_department_members m WHERE m.department_id=t.department_id AND m.user_id=$1))))";
const columns = 't.id,t.user_id AS "userId",t.subject,t.priority,t.status,t.department_id AS "departmentId",d.name AS "departmentName",t.assigned_to AS "assignedTo",a.name AS "assigneeName",t.service_id AS "serviceId",s.name AS "serviceName",t.merged_into AS "mergedInto",t.rating,t.rating_comment AS "ratingComment",t.rated_at AS "ratedAt",t.created_at AS "createdAt",t.updated_at AS "updatedAt"';
const source = 'FROM tickets t LEFT JOIN support_departments d ON d.id=t.department_id LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN services s ON s.id=t.service_id';
/** @param connection 业务事务或只读池。@param id 已验证工单ID。@param request 已认证身份。@param lock 是否准备写入。 */
export async function ticketFor(connection: Pool | PoolClient, id: string, request: SessionRequest, lock = false) {
    const found = await connection.query(`SELECT t.* FROM tickets t WHERE t.id=$4 AND ${scope}${lock ? ' FOR UPDATE' : ''}`, [request.user.id, request.user.role === 'admin', request.user.role === 'support', id]);
    if (!found.rowCount)
        throw new NotFoundException('工单不存在');
    return found.rows[0]; // 附件也使用同一归属判断
}
@Controller()
export default class Ticket {
    @Get('tickets')
    async list(
    @Req()
    request: SessionRequest, 
    @Query()
    query: unknown = {}) { return (await this.find(request, query)).items; } // 原数组接口保持兼容
    @Roles('admin', 'support')
    @Get('admin/support/tickets')
    async admin(
    @Req()
    request: SessionRequest, 
    @Query()
    query: unknown = {}) { return this.find(request, query); }
    private async find(request: SessionRequest, query: unknown) {
        const input = read(z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(100), status: z.enum(['open', 'answered', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(), departmentId: uuid.optional(), q: z.string().trim().max(160).optional(), assignedTo: uuid.optional() }).strict(), query);
        const where = `WHERE ${scope} AND ($4::text IS NULL OR t.status=$4) AND ($5::uuid IS NULL OR t.department_id=$5) AND ($6::text IS NULL OR t.subject ILIKE '%'||$6||'%') AND ($7::text IS NULL OR t.priority=$7) AND ($8::uuid IS NULL OR t.assigned_to=$8)`;
        const values = [request.user.id, request.user.role === 'admin', request.user.role === 'support', input.status ?? null, input.departmentId ?? null, input.q ?? null, input.priority ?? null, input.assignedTo ?? null];
        const [items, total] = await Promise.all([pool.query(`SELECT ${columns} ${source} ${where} ORDER BY t.updated_at DESC,t.id LIMIT $9 OFFSET $10`, [...values, input.limit, (input.page - 1) * input.limit]), pool.query(`SELECT count(*)::int AS total FROM tickets t ${where}`, values)]);
        return { items: items.rows, total: total.rows[0].total, page: input.page, limit: input.limit };
    }
    @Post('tickets')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ subject: z.string().trim().min(1).max(160), message, priority: z.enum(['normal', 'high', 'low']).default('normal'), departmentId: uuid.optional(), serviceId: uuid.optional(),customFields:customValues }).strict(), body);
        return transaction(async (connection) => {
            if (input.departmentId && !(await connection.query('SELECT 1 FROM support_departments WHERE id=$1 AND active', [input.departmentId])).rowCount)
                throw new NotFoundException('支持部门不存在或已停用');
            if (input.serviceId && !(await connection.query("SELECT 1 FROM services s WHERE id=$1 AND COALESCE((to_jsonb(s)->>'current_owner_id')::uuid,s.user_id)=$2", [input.serviceId, request.user.id])).rowCount)
                throw new NotFoundException('关联服务不存在');
            const fields=await captureTicketFields(connection,input.departmentId ?? null,input.customFields,request); // 必填字段与主工单同事务核对
            const saved = (await connection.query('INSERT INTO tickets(user_id,subject,priority,department_id,service_id,custom_fields,field_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,subject,priority,status,created_at AS "createdAt",updated_at AS "updatedAt"', [request.user.id, input.subject, input.priority, input.departmentId ?? null, input.serviceId ?? null,JSON.stringify(fields.values),JSON.stringify(fields.snapshot)])).rows[0];
            await connection.query("INSERT INTO custom_field_changes(scope,target_id,actor_id,revision,values) VALUES('ticket',$1,$2,0,$3)",[saved.id,actor(request),fields.values]); // 初始单据也保留只追加快照
            await connection.query('INSERT INTO ticket_replies(ticket_id,user_id,message) VALUES($1,$2,$3)', [saved.id, actor(request), input.message]);
            await notify(connection, request.user.id, '工单已提交', `“${input.subject}”已记录，我们会在工单中继续沟通。`, `/console/tickets/${saved.id}`);
            await record(connection, actor(request), 'ticket.create', saved.id, { departmentId: input.departmentId, serviceId: input.serviceId });
            return saved;
        });
    }
    @Get('tickets/:id')
    async get(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        await ticketFor(pool, id, request);
        const found = (await pool.query(`SELECT ${columns} ${source} WHERE t.id=$1`, [id])).rows[0], staff = request.user.role !== 'customer';
        const [replies, attachments] = await Promise.all([
            pool.query('SELECT r.id,r.ticket_id AS "ticketId",r.message,r.internal,r.created_at AS "createdAt",u.name,u.role,u.id AS "userId" FROM ticket_replies r JOIN users u ON u.id=r.user_id WHERE (r.ticket_id=$1 OR EXISTS(SELECT 1 FROM tickets m WHERE m.id=r.ticket_id AND m.merged_into=$1)) AND ($2::boolean OR NOT r.internal) ORDER BY r.created_at,r.id', [id, staff]),
            pool.query('SELECT f.id,f.name,f.media_type AS "mediaType",f.size_bytes AS "sizeBytes",f.reply_id AS "replyId",f.internal,f.created_at AS "createdAt" FROM support_files f WHERE (f.ticket_id=$1 OR EXISTS(SELECT 1 FROM tickets m WHERE m.id=f.ticket_id AND m.merged_into=$1)) AND ($2::boolean OR NOT f.internal) ORDER BY f.created_at,f.id', [id, staff]),
        ]);
        return { ...found, replies: replies.rows, attachments: attachments.rows,customFields:await ticketFields(pool,id,request) };
    }
    @Post('tickets/:id/replies')
    async reply(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const input = read(z.object({ message, internal: z.boolean().default(false), attachmentIds: z.array(uuid).max(5).default([]) }).strict(), body);
        if (input.internal && request.user.role === 'customer')
            throw new ForbiddenException('客户不能写入内部备注');
        return transaction(async (connection) => {
            const ticket = await ticketFor(connection, id, request, true);
            if (ticket.merged_into)
                throw new ConflictException('这张工单已合并，请到关联工单继续沟通');
            if (ticket.status === 'closed' && !input.internal)
                throw new ConflictException('工单已关闭，请新建工单');
            const ids = [...new Set(input.attachmentIds)];
            if (ids.length && (await connection.query('SELECT id FROM support_files WHERE id=ANY($1::uuid[]) AND ticket_id=$2 AND user_id=$3 AND reply_id IS NULL FOR UPDATE', [ids, id, actor(request)])).rowCount !== ids.length)
                throw new NotFoundException('附件不存在或不属于当前回复');
            const saved = (await connection.query('INSERT INTO ticket_replies(ticket_id,user_id,message,internal) VALUES($1,$2,$3,$4) RETURNING id,message,internal,created_at AS "createdAt"', [id, actor(request), input.message, input.internal])).rows[0];
            if (ids.length)
                await connection.query('UPDATE support_files SET reply_id=$2,internal=$3 WHERE id=ANY($1::uuid[])', [ids, saved.id, input.internal]);
            await connection.query('UPDATE tickets SET status=CASE WHEN $3 THEN status ELSE $1 END,updated_at=now() WHERE id=$2', [request.user.role === 'customer' ? 'open' : 'answered', id, input.internal]);
            if (!input.internal && request.user.role !== 'customer')
                await notify(connection, ticket.user_id, '工单有新回复', `“${ticket.subject}”有了新进展，打开工单查看。`, `/console/tickets/${id}`);
            await record(connection, actor(request), input.internal ? 'ticket.note' : 'ticket.reply', id, { replyId: saved.id, attachmentIds: ids });
            return saved;
        });
    }
    @Post('tickets/:id/close')
    async close(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        return transaction(async (connection) => { const ticket = await ticketFor(connection, id, request, true); if (ticket.status === 'closed')
            return { ok: true }; await connection.query("UPDATE tickets SET status='closed',updated_at=now() WHERE id=$1", [id]); await record(connection, actor(request), 'ticket.close', id, {}); return { ok: true }; });
    }
    @Post('tickets/:id/reopen')
    async reopen(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        return transaction(async (connection) => { const ticket = await ticketFor(connection, id, request, true); if (ticket.merged_into)
            throw new ConflictException('已合并工单请到关联工单继续沟通'); await connection.query("UPDATE tickets SET status='open',updated_at=now() WHERE id=$1", [id]); await record(connection, actor(request), 'ticket.reopen', id, {}); return { ok: true }; });
    }
    @Post('tickets/:id/evaluate')
    async evaluate(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).default('') }).strict(), body);
        read(uuid, id);
        return transaction(async (connection) => { const ticket = await ticketFor(connection, id, request, true); if (ticket.user_id !== request.user.id || request.user.role !== 'customer')
            throw new ForbiddenException('只有提交工单的客户可以评价'); if (ticket.status !== 'closed')
            throw new ConflictException('结束工单后再评价'); if (ticket.rating) {
            if (ticket.rating === input.rating && ticket.rating_comment === input.comment)
                return { ok: true };
            throw new ConflictException('这张工单已经评价');
        } await connection.query('UPDATE tickets SET rating=$2,rating_comment=$3,rated_at=now() WHERE id=$1', [id, input.rating, input.comment]); await record(connection, actor(request), 'ticket.evaluate', id, { rating: input.rating }); return { ok: true }; });
    }
    @Roles('admin', 'support')
    @Post('admin/support/tickets/:id/assign')
    async assign(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ departmentId: uuid.nullable(), assignedTo: uuid.nullable().default(null), priority: z.enum(['low', 'normal', 'high']).optional() }).strict(), body);
        read(uuid, id);
        return transaction(async (connection) => {
            await ticketFor(connection, id, request, true);
            if (input.departmentId && !(await connection.query('SELECT id FROM support_departments d WHERE id=$1 AND active AND ($2::boolean OR EXISTS(SELECT 1 FROM support_department_members m WHERE m.department_id=d.id AND m.user_id=$3))', [input.departmentId, request.user.role === 'admin', request.user.id])).rowCount)
                throw new NotFoundException('部门不存在或没有转入权限');
            if (input.assignedTo && !(await connection.query("SELECT id FROM users u WHERE u.id=$1 AND NOT disabled AND role IN ('admin','support') AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM support_department_members m WHERE m.department_id=$2 AND m.user_id=u.id))", [input.assignedTo, input.departmentId])).rowCount)
                throw new ConflictException('接收人员不属于所选部门或当前不可用');
            await connection.query('UPDATE tickets SET department_id=$2,assigned_to=$3,priority=COALESCE($4,priority),updated_at=now() WHERE id=$1', [id, input.departmentId, input.assignedTo, input.priority ?? null]);
            if (input.assignedTo)
                await notify(connection, input.assignedTo, '收到分配的工单', '请查看新分配的支持工单。', `/console/tickets/${id}`);
            await record(connection, actor(request), 'ticket.assign', id, input);
            return { ok: true };
        });
    }
    @Roles('admin', 'support')
    @Post('admin/support/tickets/:id/merge')
    async merge(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ targetId: uuid }).strict(), body);
        read(uuid, id);
        if (id === input.targetId)
            throw new ConflictException('不能把工单合并到自己');
        return transaction(async (connection) => {
            if ((await connection.query('SELECT id FROM tickets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[id, input.targetId]])).rowCount !== 2)
                throw new NotFoundException('工单不存在');
            const original = await ticketFor(connection, id, request), target = await ticketFor(connection, input.targetId, request);
            if (original.merged_into === target.id)
                return { ok: true, targetId: target.id };
            if (original.user_id !== target.user_id || original.merged_into || target.merged_into || target.status === 'closed')
                throw new ConflictException('只能合并同一客户的工单，接收工单须保持打开');
            await connection.query("UPDATE tickets SET merged_into=$2,status='closed',updated_at=now() WHERE id=$1 OR merged_into=$1", [id, target.id]);
            await connection.query('UPDATE tickets SET updated_at=now() WHERE id=$1', [target.id]);
            await notify(connection, target.user_id, '工单已合并', '相关沟通已整理到同一张工单中。', `/console/tickets/${target.id}`);
            await record(connection, actor(request), 'ticket.merge', id, { targetId: target.id });
            return { ok: true, targetId: target.id };
        });
    }
}
