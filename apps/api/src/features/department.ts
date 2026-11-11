/* 支持部门、成员与快捷回复：配置和操作放在同一支持主体中。
 * 调用：GET /support/departments；管理员POST /admin/support/departments；PUT /admin/support/departments/:id/members。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const department = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(2000).default(''), active: z.boolean().default(true), position: z.number().int().min(0).max(10000).default(0) }).strict();
const actor = (request: SessionRequest) => request.actorId ?? request.user.id; // 子账号的真实操作人单独留痕
@Controller()
export default class Department {
    @Get('support/departments')
    async list() {
        return (await pool.query('SELECT id,name,description,position FROM support_departments WHERE active ORDER BY position,name,id')).rows; // 客户看不到部门成员或未启用部门
    }
    @Roles('admin', 'support')
    @Get('admin/support/departments')
    async admin(
    @Req()
    request: SessionRequest) {
        return (await pool.query('SELECT d.*,(SELECT COALESCE(jsonb_agg(jsonb_build_object(\'id\',u.id,\'name\',u.name,\'email\',u.email) ORDER BY u.name),\'[]\'::jsonb) FROM support_department_members m JOIN users u ON u.id=m.user_id WHERE m.department_id=d.id) AS members FROM support_departments d WHERE $1::boolean OR EXISTS(SELECT 1 FROM support_department_members m WHERE m.department_id=d.id AND m.user_id=$2) ORDER BY position,name', [request.user.role === 'admin', request.user.id])).rows;
    }
    @Roles('admin')
    @Post('admin/support/departments')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(department, body);
        return transaction(async (connection) => {
            const saved = (await connection.query('INSERT INTO support_departments(name,description,active,position) VALUES($1,$2,$3,$4) RETURNING *', [input.name, input.description, input.active, input.position])).rows[0];
            await record(connection, actor(request), 'support.department.create', saved.id, input);
            return saved;
        });
    }
    @Roles('admin')
    @Put('admin/support/departments/:id')
    async update(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(department, body);
        read(uuid, id);
        return transaction(async (connection) => {
            const saved = await connection.query('UPDATE support_departments SET name=$2,description=$3,active=$4,position=$5 WHERE id=$1 RETURNING *', [id, input.name, input.description, input.active, input.position]);
            if (!saved.rowCount)
                throw new NotFoundException('部门不存在');
            await record(connection, actor(request), 'support.department.update', id, input);
            return saved.rows[0];
        });
    }
    @Roles('admin')
    @Put('admin/support/departments/:id/members')
    async members(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ userIds: z.array(uuid).max(100) }).strict(), body);
        read(uuid, id);
        return transaction(async (connection) => {
            if (!(await connection.query('SELECT id FROM support_departments WHERE id=$1 FOR UPDATE', [id])).rowCount)
                throw new NotFoundException('部门不存在');
            const ids = [...new Set(input.userIds)];
            const found = await connection.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND role IN ('admin','support') AND NOT disabled", [ids]);
            if (found.rowCount !== ids.length)
                throw new ConflictException('成员必须是有效的管理员或支持人员');
            await connection.query('DELETE FROM support_department_members WHERE department_id=$1', [id]);
            for (const userId of ids)
                await connection.query('INSERT INTO support_department_members VALUES($1,$2)', [id, userId]);
            await record(connection, actor(request), 'support.department.members', id, { userIds: ids });
            return { ok: true };
        });
    }
    @Roles('admin', 'support')
    @Get('admin/support/agents')
    async agents() {
        return (await pool.query("SELECT id,name,email,role FROM users WHERE role IN ('admin','support') AND NOT disabled ORDER BY name,id LIMIT 500")).rows;
    }
    @Roles('admin', 'support')
    @Get('admin/support/reply-categories')
    async replyCategories() {
        return (await pool.query('SELECT * FROM support_reply_categories ORDER BY name')).rows;
    }
    @Roles('admin')
    @Post('admin/support/reply-categories')
    async createReplyCategory(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ name: z.string().trim().min(1).max(100) }).strict(), body);
        return transaction(async (connection) => { const saved = (await connection.query('INSERT INTO support_reply_categories(name) VALUES($1) RETURNING *', [input.name])).rows[0]; await record(connection, actor(request), 'support.reply-category.create', saved.id, {}); return saved; });
    }
    @Roles('admin')
    @Put('admin/support/reply-categories/:id')
    async updateReplyCategory(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const input = read(z.object({ name: z.string().trim().min(1).max(100) }).strict(), body);
        return transaction(async (connection) => { if (!(await connection.query('UPDATE support_reply_categories SET name=$2 WHERE id=$1 RETURNING id', [id, input.name])).rowCount)
            throw new NotFoundException('回复分类不存在'); await record(connection, actor(request), 'support.reply-category.update', id, {}); return { id, ...input }; });
    }
    @Roles('admin')
    @Delete('admin/support/reply-categories/:id')
    async removeReplyCategory(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        return transaction(async (connection) => { if (!(await connection.query('DELETE FROM support_reply_categories WHERE id=$1 RETURNING id', [read(uuid, id)])).rowCount)
            throw new NotFoundException('回复分类不存在'); await record(connection, actor(request), 'support.reply-category.delete', id, {}); return { ok: true }; }); // 分类移除后原模板成为未分类
    }
    @Roles('admin', 'support')
    @Get('admin/support/replies')
    async templates() {
        return (await pool.query('SELECT t.id,t.title,t.message,t.category_id AS "categoryId",c.name AS "categoryName" FROM support_reply_templates t LEFT JOIN support_reply_categories c ON c.id=t.category_id ORDER BY c.name NULLS LAST,t.title LIMIT 500')).rows;
    }
    @Roles('admin')
    @Post('admin/support/replies')
    async createTemplate(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.saveTemplate(null, body, request); }
    @Roles('admin')
    @Put('admin/support/replies/:id')
    async updateTemplate(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.saveTemplate(id, body, request); }
    /** 快捷回复仍是纯文本，使用时由客服明确提交，不自动替客户发言。 */
    private async saveTemplate(id: string | null, body: unknown, request: SessionRequest) {
        const input = read(z.object({ title: z.string().trim().min(1).max(160), message: z.string().trim().min(1).max(20000), categoryId: uuid.nullable().default(null) }).strict(), body);
        return transaction(async (connection) => {
            if (input.categoryId && !(await connection.query('SELECT 1 FROM support_reply_categories WHERE id=$1', [input.categoryId])).rowCount)
                throw new NotFoundException('快捷回复分类不存在');
            const saved = id ? await connection.query('UPDATE support_reply_templates SET title=$2,message=$3,category_id=$4,updated_at=now() WHERE id=$1 RETURNING *', [id, input.title, input.message, input.categoryId]) : await connection.query('INSERT INTO support_reply_templates(title,message,category_id) VALUES($1,$2,$3) RETURNING *', [input.title, input.message, input.categoryId]);
            if (!saved.rowCount)
                throw new NotFoundException('快捷回复不存在');
            await record(connection, actor(request), id ? 'support.reply-template.update' : 'support.reply-template.create', saved.rows[0].id, {});
            return saved.rows[0];
        });
    }
    @Roles('admin')
    @Delete('admin/support/replies/:id')
    async removeTemplate(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        return transaction(async (connection) => { const saved = await connection.query('DELETE FROM support_reply_templates WHERE id=$1 RETURNING id', [read(uuid, id)]); if (!saved.rowCount)
            throw new NotFoundException('快捷回复不存在'); await record(connection, actor(request), 'support.reply-template.delete', id, {}); return { ok: true }; });
    }
}
