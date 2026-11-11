/* 站内通知：业务事务直接写入通知；客户只能查看、已读或隐藏自己的消息。
 * 调用：GET /notifications；POST /notifications/:id/read；管理员POST /admin/notifications。
 */
import { Body, Controller, Delete, Get, Param, Post, Query, Req, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
/** @param connection 所属业务事务。@param userId 接收者。@param title 标题。@param message 正文。@param link 站内地址。 */
export async function notify(connection: PoolClient, userId: string, title: string, message: string, link?: string) {
    await connection.query('INSERT INTO notifications(user_id,title,message,link) VALUES($1,$2,$3,$4)', [userId, title, message, link ?? null]); // 通知不会早于业务事实提交
}
@Controller()
export default class Notification {
    @Get('notifications')
    async list(
    @Query('page')
    page: unknown, 
    @Req()
    request: SessionRequest) {
        const number = read(z.coerce.number().int().min(1).max(100000).default(1), page);
        const [items, total] = await Promise.all([
            pool.query('SELECT id,title,message,link,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 50 OFFSET $2', [request.user.id, (number - 1) * 50]),
            pool.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE read_at IS NULL)::int AS unread FROM notifications WHERE user_id=$1 AND deleted_at IS NULL', [request.user.id]),
        ]);
        return { items: items.rows, ...total.rows[0], page: number, limit: 50 };
    }
    @Post('notifications/read-all')
    async all(
    @Req()
    request: SessionRequest) {
        await pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND deleted_at IS NULL', [request.user.id]);
        return { ok: true }; // 已读重试没有额外副作用
    }
    @Post('notifications/:id/read')
    async read(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        const result = await pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id', [read(uuid, id), request.user.id]);
        if (!result.rowCount)
            throw new NotFoundException('通知不存在');
        return { ok: true };
    }
    @Delete('notifications/:id')
    async remove(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        const result = await pool.query('UPDATE notifications SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id', [read(uuid, id), request.user.id]);
        if (!result.rowCount)
            throw new NotFoundException('通知不存在');
        return { ok: true }; // 隐藏不会修改原始消息正文
    }
    @Roles('admin')
    @Post('admin/notifications')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ userIds: z.array(uuid).min(1).max(200), title: z.string().trim().min(1).max(160), message: z.string().trim().min(1).max(20000), link: z.string().max(500).regex(/^\/(?!\/)[^\\\u0000-\u001f]*$/).optional() }).strict(), body);
        return transaction(async (connection) => {
            const ids = [...new Set(input.userIds)];
            const found = await connection.query('SELECT id FROM users WHERE id=ANY($1::uuid[])', [ids]);
            if (found.rowCount !== ids.length)
                throw new NotFoundException('部分接收者不存在');
            for (const id of ids)
                await notify(connection, id, input.title, input.message, input.link);
            await record(connection, request.actorId ?? request.user.id, 'notification.send', 'users', { userIds: ids, count: ids.length });
            return { ok: true, count: ids.length };
        });
    }
}
