/* 内容：公开公告、帮助与独立页面；发布动作只允许管理员。
 * 调用：GET /api/v1/content?kind=help；管理员POST /admin/content {slug,title,content,kind,published}。
 * 正文按纯文本或安全Markdown显示，不作为HTML执行；每次发布在事务内登记差异静态页面。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'; // 内容接口与业务入口同样校验权限
import { z } from 'zod'; // 文本和路径只在入口校验
import { pool, transaction } from './store.js'; // 内容事实只保存在PostgreSQL
import { record } from './audit.js'; // 发布和删除有审计记录
import { Public, Roles, type SessionRequest } from '../utils/access.js'; // 客户只能看到已发布内容
import { read, uuid } from '../utils/input.js'; // URL标识不允许目录穿越
const article = z.object({ slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/), title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(200000), kind: z.enum(['news', 'help', 'page']), published: z.boolean(), categoryId: uuid.nullable().default(null) }).strict(); // slug只构成受控页面路径
const columns = 'id,slug,title,content,kind,published,category_id AS "categoryId",updated_at AS "updatedAt"'; // 列表和详情共用一份字段
@Controller()
export default class Content {
    /** @param kind 内容类型。@returns 已发布内容。 */
    @Public()
    @Get('content')
    async list(
    @Query('kind')
    kind: unknown, 
    @Query('categoryId')
    categoryId?: unknown, 
    @Query('q')
    query?: unknown) {
        const type = read(z.enum(['news', 'help', 'page']).default('news'), kind); // 限定查询范围
        const category = read(uuid.optional(), categoryId), text = read(z.string().trim().max(160).default(''), query); // 搜索按文字匹配，分类不会暴露草稿
        return (await pool.query(`SELECT ${columns} FROM articles WHERE published AND kind=$1 AND ($2::uuid IS NULL OR category_id=$2) AND position(lower($3) in lower(title||' '||content))>0 ORDER BY updated_at DESC LIMIT 100`, [type, category ?? null, text])).rows; // 草稿不进入公开缓存
    }
    /** 公开分类不包含后台草稿；下载权限仍由下载入口独立核对。 */
    @Public()
    @Get('content/categories')
    async categories(
    @Query('kind')
    kind: unknown) {
        const type = read(z.enum(['news', 'help', 'page', 'download']).default('help'), kind);
        return (await pool.query('SELECT id,name,kind,parent_id AS "parentId",position FROM content_categories WHERE kind=$1 ORDER BY position,name,id', [type])).rows;
    }
    @Roles('admin')
    @Get('admin/content/categories')
    async adminCategories() {
        return (await pool.query('SELECT id,name,kind,parent_id AS "parentId",position FROM content_categories ORDER BY kind,position,name')).rows;
    }
    @Roles('admin')
    @Post('admin/content/categories')
    async createCategory(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.saveCategory(null, body, request); }
    @Roles('admin')
    @Put('admin/content/categories/:id')
    async updateCategory(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.saveCategory(id, body, request); }
    private async saveCategory(id: string | null, body: unknown, request: SessionRequest) {
        const input = read(z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['news', 'help', 'page', 'download']), parentId: uuid.nullable().default(null), position: z.number().int().min(0).max(10000).default(0) }).strict(), body);
        return transaction(async (connection) => {
            await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('content.categories',0))"); // 同时移动分类不能造成环
            if (id) {
                const old = (await connection.query('SELECT kind FROM content_categories WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!old)
                    throw new NotFoundException('分类不存在');
                if (old.kind !== input.kind)
                    throw new ConflictException('分类类型创建后不能更改');
            }
            if (input.parentId) {
                await this.checkCategory(connection, input.parentId, input.kind); // 父子必须属于同一内容类型
                const cycle = await connection.query('WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM content_categories WHERE id=$1 UNION ALL SELECT c.id,c.parent_id FROM content_categories c JOIN ancestors a ON c.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=$2', [input.parentId, id]);
                if (input.parentId === id || cycle.rowCount)
                    throw new BadRequestException('分类不能移动到自己或子分类下');
            }
            const saved = id ? await connection.query('UPDATE content_categories SET name=$2,parent_id=$3,position=$4 WHERE id=$1 RETURNING id', [id, input.name, input.parentId, input.position]) : await connection.query('INSERT INTO content_categories(name,kind,parent_id,position) VALUES($1,$2,$3,$4) RETURNING id', [input.name, input.kind, input.parentId, input.position]);
            await record(connection, request.actorId ?? request.user.id, id ? 'content.category.update' : 'content.category.create', saved.rows[0].id, input);
            return saved.rows[0];
        });
    }
    @Roles('admin')
    @Delete('admin/content/categories/:id')
    async removeCategory(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        return transaction(async (connection) => {
            await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('content.categories',0))");
            if ((await connection.query('SELECT 1 FROM content_categories WHERE parent_id=$1', [id])).rowCount)
                throw new ConflictException('请先移动或删除子分类');
            if (!(await connection.query('DELETE FROM content_categories WHERE id=$1 RETURNING id', [id])).rowCount)
                throw new NotFoundException('分类不存在');
            await record(connection, request.actorId ?? request.user.id, 'content.category.delete', id, {});
            return { ok: true }; // 文章与下载保留并成为未分类
        });
    }
    private async checkCategory(connection: import('pg').PoolClient, id: string | null, kind: string) {
        if (id && !(await connection.query('SELECT 1 FROM content_categories WHERE id=$1 AND kind=$2', [id, kind])).rowCount)
            throw new NotFoundException('当前内容类型下没有这个分类');
    }
    /** @param slug 页面路径。@returns 一篇公开内容。 */
    @Public()
    @Get('content/:slug')
    async get(
    @Param('slug')
    slug: string) {
        const value = read(article.shape.slug, slug); // URL不能携带文件路径
        const found = await pool.query(`SELECT ${columns} FROM articles WHERE slug=$1 AND published`, [value]); // 草稿与不存在统一处理
        if (!found.rowCount)
            throw new NotFoundException('内容不存在或已撤回'); // 用户不会看到后台草稿
        return found.rows[0]; // 不在服务端插入用户HTML
    }
    /** @returns 管理员可编辑的文章清单。 */
    @Roles('admin')
    @Get('admin/content')
    async admin() {
        return (await pool.query(`SELECT ${columns} FROM articles ORDER BY updated_at DESC LIMIT 200`)).rows; // 后台可看到草稿
    }
    /** @param body 内容全文。@returns 已保存文章。 */
    @Roles('admin')
    @Post('admin/content')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(article, body); // 发布前检查正文大小和路径
        return transaction(async (connection) => {
            await this.checkCategory(connection, input.categoryId, input.kind); // 文章只能进入同类分类
            const saved = await connection.query(`INSERT INTO articles(slug,title,content,kind,published,category_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [input.slug, input.title, input.content, input.kind, input.published, input.categoryId]); // 正文与发布状态一并保存
            await record(connection, request.actorId ?? request.user.id, 'content.create', saved.rows[0].id, { slug: input.slug, published: input.published }); // 审计保留路径与发布事实
            await connection.query('INSERT INTO publications(path) VALUES($1) ON CONFLICT(path) DO UPDATE SET revision=publications.revision+1,changed_at=now()', [`/${input.kind}/${input.slug}`]); // 仅此文章进入重建队列
            return saved.rows[0]; // 提交后前台即可读取
        });
    }
    /** @param id 文章ID。@param body 修改后的全文。@returns 已保存文章。 */
    @Roles('admin')
    @Put('admin/content/:id')
    async update(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id); // 管理操作也不接受任意ID
        const input = read(article, body); // 新旧slug由同一规则限制
        return transaction(async (connection) => {
            const old = await connection.query('SELECT slug,kind FROM articles WHERE id=$1 FOR UPDATE', [id]); // 改名时旧路径也要失效
            if (!old.rowCount)
                throw new NotFoundException('文章不存在'); // 不以新建代替失败编辑
            await this.checkCategory(connection, input.categoryId, input.kind); // 修改类型时同时核对分类
            const saved = await connection.query(`UPDATE articles SET slug=$1,title=$2,content=$3,kind=$4,published=$5,category_id=$6,updated_at=now() WHERE id=$7 RETURNING ${columns}`, [input.slug, input.title, input.content, input.kind, input.published, input.categoryId, id]); // 修改只属于这篇文章
            for (const path of new Set([`/${old.rows[0].kind}/${old.rows[0].slug}`, `/${input.kind}/${input.slug}`])) {
                await connection.query('INSERT INTO publications(path) VALUES($1) ON CONFLICT(path) DO UPDATE SET revision=publications.revision+1,changed_at=now()', [path]); // 改一篇不会重建其它文章
            }
            await record(connection, request.actorId ?? request.user.id, 'content.update', id, { slug: input.slug, published: input.published }); // 改名与撤回都可追查
            return saved.rows[0]; // 返回最终发布状态
        });
    }
    /** @param id 文章ID。@returns 已删除并登记原路径失效。 */
    @Roles('admin')
    @Delete('admin/content/:id')
    async remove(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id); // 删除权限在入口统一检查
        return transaction(async (connection) => {
            const found = await connection.query('DELETE FROM articles WHERE id=$1 RETURNING slug,kind', [id]); // 删除不会影响其它内容
            if (!found.rowCount)
                throw new NotFoundException('文章不存在'); // 不误报删除成功
            await connection.query('INSERT INTO publications(path) VALUES($1) ON CONFLICT(path) DO UPDATE SET revision=publications.revision+1,changed_at=now()', [`/${found.rows[0].kind}/${found.rows[0].slug}`]); // 静态发布器移除这个路径
            await record(connection, request.actorId ?? request.user.id, 'content.delete', id, found.rows[0]); // 原slug保留在审计里
            return { ok: true }; // 删除和失效通知共同提交
        });
    }
}
