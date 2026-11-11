/* 自定义资料与工单字段：定义、格式、权限和保存同在一个主体；工单标签/类型保留创建时快照。
 * 调用：GET/PUT /fields/profile；GET /fields/ticket?departmentId；GET/PUT /tickets/:id/fields。
 * 管理：GET/POST /admin/fields，PUT /admin/fields/:id；客户不能读写管理字段，保存带revision防覆盖。
 */
import { Body, Controller, Get, Post, Put, Param, Query, Req, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { ticketFor } from './ticket.js';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
export const customValues = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().trim().max(20000), z.number().finite().min(-1000000000).max(1000000000), z.boolean(), z.null()])).refine(value => Object.keys(value).length <= 100, '补充字段过多').default({});
const definition = z.object({ scope: z.enum(['profile', 'ticket']), key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine(value => !['constructor', 'prototype'].includes(value)), name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000).default(''), kind: z.enum(['text', 'textarea', 'select', 'number', 'boolean', 'date']), format: z.enum(['plain', 'email', 'url', 'phone', 'ipv4', 'domain']).default('plain'), options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().trim().min(1).max(100) }).strict()).max(100).default([]), required: z.boolean().default(false), access: z.enum(['customer', 'staff', 'admin']).default('customer'), customerEditable: z.boolean().default(true), minimum: z.number().int().min(-1000000000).max(20000).default(0), maximum: z.number().int().min(0).max(1000000000).default(2000), departmentId: uuid.nullable().default(null), position: z.number().int().min(0).max(10000).default(0), active: z.boolean().default(true) }).strict().refine(input => input.maximum >= input.minimum, '字段范围错误').refine(input => input.kind !== 'select' || input.options.length > 0, '选择字段需要至少一个选项').refine(input => new Set(input.options.map(option => option.value)).size === input.options.length, '选项值不能重复').refine(input => input.scope === 'ticket' || !input.departmentId, '资料字段不能绑定工单部门').refine(input => ['text', 'textarea'].includes(input.kind) || input.format === 'plain', '此字段类型不能使用文字格式').refine(input => !['text', 'textarea'].includes(input.kind) || (input.minimum >= 0 && input.maximum <= 20000), '文字字段最多20000字');
export interface CustomDefinition {
    id: string;
    key: string;
    name: string;
    description: string;
    kind: string;
    format: string;
    options: {
        value: string;
        label: string;
    }[];
    required: boolean;
    access: 'customer' | 'staff' | 'admin';
    customerEditable: boolean;
    minimum: number;
    maximum: number;
    departmentId?: string | null;
    active?: boolean;
    position?: number;
    scope?: string;
}
const columns = 'id,scope,key,name,description,kind,format,options,required,access,customer_editable AS "customerEditable",minimum,maximum,department_id AS "departmentId",position,active';
const actor = (request: SessionRequest) => request.actorId ?? request.user.id;
function allowed(field: CustomDefinition, role: string, write = false) { return role === 'admin' || (field.access !== 'admin' && (role === 'support' || field.access === 'customer' && (!write || field.customerEditable))); }
async function definitions(connection: Pool | PoolClient, scope: string, departmentId: string | null = null) { return (await connection.query(`SELECT ${columns} FROM custom_fields WHERE scope=$1 AND active AND (department_id IS NULL OR department_id=$2) ORDER BY position,key`, [scope, departmentId])).rows as CustomDefinition[]; }
/** 值仅在输入边界按管理员定义检查，不把客户文本作为HTML或表达式运行。 */
function validate(fields: CustomDefinition[], values: Record<string, any>, role: string) {
    for (const key of Object.keys(values)) {
        const field = fields.find(item => item.key === key);
        if (!field || !allowed(field, role, true))
            throw new BadRequestException('包含未知、只读或无权修改的补充字段');
    }
    for (const field of fields.filter(item => allowed(item, role, true))) {
        const value = values[field.key], empty = value === undefined || value === null || value === '';
        if (empty) {
            if (field.required)
                throw new BadRequestException(`请填写${field.name}`);
            continue;
        }
        let valid = true;
        if (field.kind === 'boolean')
            valid = typeof value === 'boolean' && (!field.required || value === true);
        else if (field.kind === 'number')
            valid = typeof value === 'number' && Number.isFinite(value) && value >= field.minimum && value <= field.maximum;
        else if (typeof value !== 'string')
            valid = false;
        else if (field.kind === 'select')
            valid = field.options.some(option => option.value === value);
        else if (field.kind === 'date')
            valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
        else {
            valid = value.length >= field.minimum && value.length <= field.maximum;
            if (field.format === 'email')
                valid &&= z.email().max(254).safeParse(value).success;
            if (field.format === 'url')
                valid &&= z.url().refine(item => ['http:', 'https:'].includes(new URL(item).protocol)).safeParse(value).success;
            if (field.format === 'phone')
                valid &&= /^\+[1-9]\d{6,14}$/.test(value);
            if (field.format === 'ipv4')
                valid &&= isIP(value) === 4;
            if (field.format === 'domain')
                valid &&= /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
        }
        if (!valid)
            throw new BadRequestException(`${field.name}的格式或范围不符合要求`);
    }
}
/** 创建工单时在业务事务里固定定义；内部必填项不阻挡客户提交。 */
export async function captureTicketFields(connection: PoolClient, departmentId: string | null, values: Record<string, any>, request: SessionRequest) { const fields = await definitions(connection, 'ticket', departmentId); validate(fields, values, request.user.role); return { values, snapshot: fields }; }
/** 快照原权限和当前权限同时生效，曾经的内部字段不会因改配置自动暴露。 */
export async function ticketFields(connection: Pool | PoolClient, id: string, request: SessionRequest) {
    const row = (await connection.query('SELECT custom_fields,field_snapshot,custom_field_revision FROM tickets WHERE id=$1', [id])).rows[0];
    const current = (await connection.query(`SELECT ${columns} FROM custom_fields WHERE id=ANY($1::uuid[])`, [row.field_snapshot.map((field: CustomDefinition) => field.id)])).rows as CustomDefinition[];
    const visible = (row.field_snapshot as CustomDefinition[]).filter(field => allowed(field, request.user.role) && allowed(current.find(item => item.id === field.id) ?? field, request.user.role));
    return { definitions: visible.map(field => ({ ...field, editable: allowed(field, request.user.role, true) && allowed(current.find(item => item.id === field.id) ?? field, request.user.role, true), customerEditable: field.customerEditable && (current.find(item => item.id === field.id)?.customerEditable ?? false) })), values: Object.fromEntries(visible.filter(field => Object.hasOwn(row.custom_fields, field.key)).map(field => [field.key, row.custom_fields[field.key]])), revision: row.custom_field_revision };
}
@Controller()
export default class Fields {
    @Roles('admin')
    @Get('admin/fields')
    async all() { return (await pool.query(`SELECT ${columns} FROM custom_fields ORDER BY scope,position,key`)).rows; }
    @Roles('admin')
    @Post('admin/fields')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.configure(null, body, request); }
    @Roles('admin')
    @Put('admin/fields/:id')
    async update(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.configure(id, body, request); }
    private async configure(id: string | null, body: unknown, request: SessionRequest) {
        const input = read(definition, body);
        return transaction(async (connection) => {
            await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-fields',0))");
            if (input.departmentId && !(await connection.query('SELECT id FROM support_departments WHERE id=$1', [input.departmentId])).rowCount)
                throw new NotFoundException('工单部门不存在');
            if (id) {
                const previous = (await connection.query('SELECT scope,key FROM custom_fields WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!previous)
                    throw new NotFoundException('字段不存在');
                if (previous.scope !== input.scope || previous.key !== input.key)
                    throw new ConflictException('字段用途与标识创建后不能修改');
            }
            if (input.active && (await connection.query('SELECT count(*)::int AS total FROM custom_fields WHERE scope=$1 AND department_id IS NOT DISTINCT FROM $2::uuid AND active AND ($3::uuid IS NULL OR id<>$3)', [input.scope, input.departmentId, id])).rows[0].total >= 50)
                throw new ConflictException('每个用途或部门最多启用50个字段');
            const parameters = [input.scope, input.key, input.name, input.description, input.kind, input.format, JSON.stringify(input.options), input.required, input.access, input.access === 'customer' && input.customerEditable, input.minimum, input.maximum, input.departmentId, input.position, input.active];
            const saved = id ? await connection.query('UPDATE custom_fields SET scope=$1,key=$2,name=$3,description=$4,kind=$5,format=$6,options=$7,required=$8,access=$9,customer_editable=$10,minimum=$11,maximum=$12,department_id=$13,position=$14,active=$15,updated_at=now() WHERE id=$16 RETURNING id', [...parameters, id]) : await connection.query('INSERT INTO custom_fields(scope,key,name,description,kind,format,options,required,access,customer_editable,minimum,maximum,department_id,position,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id', parameters);
            await record(connection, actor(request), id ? 'fields.update' : 'fields.create', saved.rows[0].id, { scope: input.scope, key: input.key, access: input.access, active: input.active });
            return { id: saved.rows[0].id };
        });
    }
    @Get('fields/ticket')
    async ticketDefinitions(
    @Query('departmentId')
    departmentId: unknown, 
    @Req()
    request: SessionRequest) { const id = read(uuid.optional(), departmentId); return { definitions: (await definitions(pool, 'ticket', id ?? null)).filter(field => allowed(field, request.user.role, true)) }; }
    @Get('fields/profile')
    async profile(
    @Req()
    request: SessionRequest) { return this.readProfile(request.user.id, request); }
    @Roles('admin')
    @Get('admin/clients/:id/fields')
    async client(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) { return this.readProfile(read(uuid, id), request); }
    private async readProfile(id: string, request: SessionRequest) { const fields = (await definitions(pool, 'profile')).filter(field => allowed(field, request.user.role)), user = (await pool.query('SELECT custom_fields,custom_field_revision FROM users WHERE id=$1', [id])).rows[0]; if (!user)
        throw new NotFoundException('客户不存在'); return { definitions: fields.map(field => ({ ...field, editable: allowed(field, request.user.role, true) })), values: Object.fromEntries(fields.filter(field => Object.hasOwn(user.custom_fields, field.key)).map(field => [field.key, user.custom_fields[field.key]])), revision: user.custom_field_revision }; }
    @Put('fields/profile')
    async saveProfile(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.writeProfile(request.user.id, body, request); }
    @Roles('admin')
    @Put('admin/clients/:id/fields')
    async saveClient(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.writeProfile(read(uuid, id), body, request); }
    private async writeProfile(id: string, body: unknown, request: SessionRequest) {
        const input = read(z.object({ values: customValues, revision: z.number().int().min(0) }).strict(), body);
        return transaction(async (connection) => {
            const user = (await connection.query('SELECT custom_fields,custom_field_revision FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!user)
                throw new NotFoundException('客户不存在');
            if (user.custom_field_revision !== input.revision)
                throw new ConflictException('资料已在另一处更新，请刷新后重试');
            const fields = await definitions(connection, 'profile');
            validate(fields, input.values, request.user.role);
            const values = { ...user.custom_fields, ...input.values }, revision = input.revision + 1;
            await connection.query('UPDATE users SET custom_fields=$2,custom_field_revision=$3,updated_at=now() WHERE id=$1', [id, values, revision]);
            await connection.query("INSERT INTO custom_field_changes(scope,target_id,actor_id,revision,values) VALUES('profile',$1,$2,$3,$4)", [id, actor(request), revision, values]);
            await record(connection, actor(request), 'fields.profile', id, { revision, keys: Object.keys(input.values) });
            return { ok: true, revision };
        });
    }
    @Get('tickets/:id/fields')
    async getTicket(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) { read(uuid, id); await ticketFor(pool, id, request); return ticketFields(pool, id, request); }
    @Put('tickets/:id/fields')
    async saveTicket(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const input = read(z.object({ values: customValues, revision: z.number().int().min(0) }).strict(), body);
        return transaction(async (connection) => {
            const ticket = await ticketFor(connection, id, request, true);
            if (ticket.merged_into || request.user.role === 'customer' && ticket.status === 'closed')
                throw new ConflictException('请在尚未结束的接收工单修改补充资料');
            if (ticket.custom_field_revision !== input.revision)
                throw new ConflictException('资料已更新，请刷新后再修改');
            const view = await ticketFields(connection, id, request);
            validate(view.definitions, input.values, request.user.role);
            const values = { ...ticket.custom_fields, ...input.values }, revision = input.revision + 1;
            await connection.query('UPDATE tickets SET custom_fields=$2,custom_field_revision=$3,updated_at=now() WHERE id=$1', [id, values, revision]);
            await connection.query("INSERT INTO custom_field_changes(scope,target_id,actor_id,revision,values) VALUES('ticket',$1,$2,$3,$4)", [id, actor(request), revision, values]);
            await record(connection, actor(request), 'fields.ticket', id, { revision, keys: Object.keys(input.values) });
            return { ok: true, revision };
        });
    }
}
