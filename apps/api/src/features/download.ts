/* 私有文件与下载中心：文件以随机ID存放在源码目录外，所有下载先核对当前权限。
 * 调用：POST /tickets/:id/files?name=说明.pdf，Content-Type:application/octet-stream，正文为原文件；GET /files/:id。
 * 管理下载：POST /admin/support/files上传，再POST /admin/support/downloads登记访问范围；不会执行或解压上传内容。
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, BadRequestException, ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url'; // 源码边界从文件位置确定
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { ticketFor } from './ticket.js';
import { Public, Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const actor = (request: SessionRequest) => request.actorId ?? request.user.id;
const fileName = z.string().trim().min(1).max(180).regex(/^[^/\\\u0000-\u001f\u007f]+$/, '文件名不能包含路径或控制字符');
const maximum = 5 * 1024 * 1024;
const downloadColumns = `d.id,d.title,d.description,d.access,d.product_id AS "productId",d.category_id AS "categoryId",d.published,d.created_at AS "createdAt",d.updated_at AS "updatedAt",f.id AS "fileId",f.name,f.media_type AS "mediaType",f.size_bytes AS "sizeBytes",c.name AS "categoryName"`;
const downloadFrom = 'FROM downloads d JOIN support_files f ON f.id=d.file_id LEFT JOIN content_categories c ON c.id=d.category_id';
const entitled = "(d.access IN ('public','account') OR $2::boolean OR EXISTS(SELECT 1 FROM services s WHERE COALESCE((to_jsonb(s)->>'current_owner_id')::uuid,s.user_id)=$1 AND COALESCE((to_jsonb(s)->>'current_product_id')::uuid,s.product_id)=d.product_id AND s.status IN ('active','suspended')))";
const download = z.object({ fileId: uuid, title: z.string().trim().min(1).max(160), description: z.string().trim().max(5000).default(''), categoryId: uuid.nullable().default(null), access: z.enum(['public', 'account', 'service']).default('account'), productId: uuid.nullable().default(null), published: z.boolean().default(false) }).strict();
/** @returns 文件根目录，默认位于用户数据目录而不是项目public或源码。 */
function directory() { const path = resolve(process.env.FILE_STORAGE_DIR || join(homedir(), '.local/share/yunzou/files')), project = resolve(fileURLToPath(new URL('../../../../', import.meta.url))); if (path === project || path.startsWith(project + sep))
    throw new ConflictException('私有附件须保存在部署数据目录'); return path; } // 配置也不能把客户材料写进源码目录
/** @param id 数据库里的随机文件ID。@returns 目录内唯一blob路径。 */
function pathFor(id: string) { return join(directory(), read(uuid, id) + '.blob'); }
/** @param request 原始二进制流。@returns 最多5MiB，超限或中断不保存文件。 */
async function receive(request: Request): Promise<Buffer> {
    if (!request.is('application/octet-stream'))
        throw new BadRequestException('上传请使用原始文件内容');
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
        throw new PayloadTooLargeException('单个文件不能超过5MiB');
    return new Promise((resolve_, reject) => {
        const chunks: Buffer[] = [];
        let size = 0, finished = false;
        const timer = setTimeout(() => finish(new BadRequestException('文件上传超时，请重新上传')), 15000);
        function finish(error?: Error) { if (finished)
            return; finished = true; clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted); if (error) {
            request.resume();
            reject(error);
        }
        else
            resolve_(Buffer.concat(chunks, size)); }
        function data(chunk: Buffer | string) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > maximum)
            return finish(new PayloadTooLargeException('单个文件不能超过5MiB')); chunks.push(buffer); }
        function end() { finish(size ? undefined : new BadRequestException('文件不能为空')); }
        function failed(error: Error) { finish(error); }
        function aborted() { finish(new BadRequestException('文件上传已中断')); }
        request.on('data', data);
        request.once('end', end);
        request.once('error', failed);
        request.once('aborted', aborted);
    });
}
/** @param name 用户可见文件名。@param data 实际字节。@returns 经扩展名与内容共同核对的媒体类型。 */
function media(name: string, data: Buffer) {
    const extension = name.split('.').pop()?.toLowerCase();
    if (extension === 'png' && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        return 'image/png';
    if (['jpg', 'jpeg'].includes(extension ?? '') && data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
        return 'image/jpeg';
    if (extension === 'pdf' && data.subarray(0, 5).toString() === '%PDF-')
        return 'application/pdf';
    if (extension === 'zip' && ['504b0304', '504b0506', '504b0708'].includes(data.subarray(0, 4).toString('hex')))
        return 'application/zip';
    if (['txt', 'log', 'csv'].includes(extension ?? '') && isUtf8(data) && !data.includes(0))
        return extension === 'csv' ? 'text/csv' : 'text/plain';
    throw new BadRequestException('文件类型不支持或内容与扩展名不一致，请使用PDF、图片、ZIP或UTF-8文本');
}
@Controller()
export default class Download {
    @Post('tickets/:id/files')
    async attach(
    @Param('id')
    id: string, 
    @Query('name')
    name: unknown, 
    @Query('internal')
    internal: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const filename = read(fileName, name), inside = read(z.enum(['true', 'false']).default('false'), internal) === 'true';
        if (inside && request.user.role === 'customer')
            throw new ForbiddenException('客户不能上传内部附件');
        const ticket = await ticketFor(pool, id, request);
        if (ticket.merged_into || (ticket.status === 'closed' && !inside))
            throw new ConflictException('请在尚未结束的接收工单上传附件');
        return this.store(filename, await receive(request), request, id, inside);
    }
    @Roles('admin')
    @Post('admin/support/files')
    async upload(
    @Query('name')
    name: unknown, 
    @Req()
    request: SessionRequest) { return this.store(read(fileName, name), await receive(request), request, null, false); }
    private async store(name: string, data: Buffer, request: SessionRequest, ticketId: string | null, internal: boolean) {
        const type = media(name, data), id = randomUUID(), root = directory(), project = resolve(new URL('../../../../', import.meta.url).pathname);
        if (root === project || root.startsWith(project + sep))
            throw new ConflictException('文件存储目录必须位于源码目录之外');
        await mkdir(root, { recursive: true, mode: 0o700 });
        let written = false;
        try {
            return await transaction(async (connection) => {
                if (ticketId) {
                    const ticket = await ticketFor(connection, ticketId, request, true);
                    if (ticket.merged_into || (ticket.status === 'closed' && !internal))
                        throw new ConflictException('工单状态已变化，请刷新后再上传');
                }
                await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`files:${actor(request)}`]);
                const used = (await connection.query('SELECT COALESCE(sum(size_bytes),0)::bigint AS bytes FROM support_files WHERE user_id=$1', [actor(request)])).rows[0].bytes;
                if (BigInt(used) + BigInt(data.length) > (request.user.role === 'admin' ? 1073741824n : 104857600n))
                    throw new ConflictException('文件空间已达上限，请联系管理员');
                await writeFile(pathFor(id), data, { flag: 'wx', mode: 0o600 });
                written = true;
                const saved = (await connection.query('INSERT INTO support_files(id,user_id,ticket_id,name,media_type,size_bytes,sha256,internal) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,media_type AS "mediaType",size_bytes AS "sizeBytes",internal,created_at AS "createdAt"', [id, actor(request), ticketId, name, type, data.length, createHash('sha256').update(data).digest('hex'), internal])).rows[0];
                await record(connection, actor(request), 'file.upload', id, { ticketId, sizeBytes: data.length, mediaType: type, internal });
                return saved;
            });
        }
        catch (error) {
            if (written)
                await rm(pathFor(id), { force: true });
            throw error;
        }
    }
    @Get('files/:id')
    async file(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest, 
    @Res()
    response: Response) {
        const found = (await pool.query('SELECT * FROM support_files WHERE id=$1', [read(uuid, id)])).rows[0];
        if (!found)
            throw new NotFoundException('文件不存在');
        if (found.ticket_id) {
            const ticket = (await pool.query('SELECT merged_into FROM tickets WHERE id=$1', [found.ticket_id])).rows[0];
            await ticketFor(pool, ticket.merged_into ?? found.ticket_id, request);
            if (found.internal && request.user.role === 'customer')
                throw new NotFoundException('文件不存在');
        }
        else if (request.user.role !== 'admin' && found.user_id !== actor(request))
            throw new NotFoundException('文件不存在');
        return this.send(found, response, false);
    }
    @Get('downloads')
    async list(
    @Req()
    request: SessionRequest, 
    @Query('categoryId')
    categoryId: unknown, 
    @Query('q')
    query: unknown) {
        const category = read(uuid.optional(), categoryId), text = read(z.string().trim().max(160).default(''), query);
        return (await pool.query(`SELECT ${downloadColumns} ${downloadFrom} WHERE d.published AND ${entitled} AND ($3::uuid IS NULL OR d.category_id=$3) AND position(lower($4) in lower(d.title||' '||d.description))>0 ORDER BY d.updated_at DESC,d.id LIMIT 200`, [request.user.id, request.user.role === 'admin', category ?? null, text])).rows;
    }
    @Get('downloads/categories')
    async categories() { return (await pool.query("SELECT id,name,parent_id AS \"parentId\" FROM content_categories WHERE kind='download' ORDER BY position,name")).rows; }
    @Public()
    @Get('public/downloads')
    async publicList() { return (await pool.query(`SELECT ${downloadColumns} ${downloadFrom} WHERE d.published AND d.access='public' ORDER BY d.updated_at DESC LIMIT 100`)).rows; }
    @Roles('admin')
    @Get('admin/support/downloads')
    async admin() { return (await pool.query(`SELECT ${downloadColumns} ${downloadFrom} ORDER BY d.updated_at DESC LIMIT 500`)).rows; }
    @Roles('admin')
    @Post('admin/support/downloads')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { return this.save(null, body, request); }
    @Roles('admin')
    @Put('admin/support/downloads/:id')
    async update(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) { read(uuid, id); return this.save(id, body, request); }
    private async save(id: string | null, body: unknown, request: SessionRequest) {
        const input = read(download, body);
        if (input.access === 'service' && !input.productId)
            throw new BadRequestException('服务专属下载请选择商品');
        return transaction(async (connection) => {
            if (!(await connection.query('SELECT 1 FROM support_files WHERE id=$1 AND ticket_id IS NULL AND NOT internal', [input.fileId])).rowCount)
                throw new NotFoundException('请先上传下载中心文件');
            if (input.categoryId && !(await connection.query("SELECT 1 FROM content_categories WHERE id=$1 AND kind='download'", [input.categoryId])).rowCount)
                throw new NotFoundException('下载分类不存在');
            if (input.productId && !(await connection.query('SELECT 1 FROM products WHERE id=$1', [input.productId])).rowCount)
                throw new NotFoundException('商品不存在');
            const saved = id ? await connection.query('UPDATE downloads SET file_id=$2,title=$3,description=$4,category_id=$5,access=$6,product_id=$7,published=$8,updated_at=now() WHERE id=$1 RETURNING id', [id, input.fileId, input.title, input.description, input.categoryId, input.access, input.productId, input.published]) : await connection.query('INSERT INTO downloads(file_id,title,description,category_id,access,product_id,published) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [input.fileId, input.title, input.description, input.categoryId, input.access, input.productId, input.published]);
            if (!saved.rowCount)
                throw new NotFoundException('下载记录不存在');
            await record(connection, actor(request), id ? 'download.update' : 'download.create', saved.rows[0].id, { access: input.access, published: input.published });
            return saved.rows[0];
        });
    }
    @Roles('admin')
    @Delete('admin/support/downloads/:id')
    async remove(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) { return transaction(async (connection) => { const saved = await connection.query('DELETE FROM downloads WHERE id=$1 RETURNING id', [read(uuid, id)]); if (!saved.rowCount)
        throw new NotFoundException('下载记录不存在'); await record(connection, actor(request), 'download.delete', id, {}); return { ok: true }; }); }
    @Get('downloads/:id/file')
    async get(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest, 
    @Res()
    response: Response) {
        const found = (await pool.query(`SELECT f.* ${downloadFrom} WHERE d.id=$3 AND d.published AND ${entitled}`, [request.user.id, request.user.role === 'admin', read(uuid, id)])).rows[0];
        if (!found)
            throw new NotFoundException('下载不存在或没有访问权限');
        return this.send(found, response, false);
    }
    @Public()
    @Get('public/downloads/:id/file')
    async publicFile(
    @Param('id')
    id: string, 
    @Res()
    response: Response) {
        const found = (await pool.query(`SELECT f.* ${downloadFrom} WHERE d.id=$1 AND d.published AND d.access='public'`, [read(uuid, id)])).rows[0];
        if (!found)
            throw new NotFoundException('下载不存在');
        return this.send(found, response, true);
    }
    private async send(file: Record<string, any>, response: Response, isPublic: boolean) {
        let data: Buffer;
        try {
            data = await readFile(pathFor(file.id));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                throw new NotFoundException('原文件暂不可用，请联系支持');
            throw error;
        }
        if (data.length !== file.size_bytes || createHash('sha256').update(data).digest('hex') !== file.sha256)
            throw new ConflictException('文件校验失败，请联系管理员核对');
        response.setHeader('Cache-Control', isPublic ? 'public, max-age=0, must-revalidate' : 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.setHeader('ETag', '"' + file.sha256 + '"');
        response.attachment(file.name).type(file.media_type).send(data); // 安全附件下载不在本站执行HTML或脚本
    }
}
