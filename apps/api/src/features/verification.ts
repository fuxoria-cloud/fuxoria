/* 邮箱/手机验证码与换绑：真实发送插件启用后才允许发码，修改绑定需要主账号密码与第二因素。
 * 调用：GET /auth/verification；POST /auth/verification/challenges {channel,destination}；
 * POST /auth/verification/confirm {id,code,password,totp?|recoveryCode?}，成功后重签当前会话。
 */
import { Body, Controller, Get, Post, Req, Res, BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { notify } from './notification.js';
import { start as startSession } from './session.js';
import { verifyIdentity, factorFields } from './security.js';
import { interactive, tokenHash, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
export type VerificationChannel = 'email' | 'sms';
export interface VerificationMessage {
    id: string;
    channel: VerificationChannel;
    destination: string;
    code: string;
    expiresInSeconds: number;
    message: string;
}
export interface BusinessMessage {id:string;channel:VerificationChannel;destination:string;message:string;subject?:string;category?:'transactional'|'marketing'}
export type MessageEnvelope=VerificationMessage|BusinessMessage;
export interface MessageSender {
    available(channel: VerificationChannel): Promise<boolean>;
    send(message: MessageEnvelope): Promise<void>;
}
const plugins = new Map<string, MessageSender>();
for (const file of (await readdir(new URL('../message-plugins/', import.meta.url))).filter(name => /^[a-z][a-z0-9-]*\.(js|ts)$/.test(name) && !name.endsWith('.d.ts')).sort()) {
    const { default: plugin } = await import(new URL('../message-plugins/' + file, import.meta.url).href);
    plugins.set(file.replace(/\.(js|ts)$/, ''), plugin);
} // 文件名即插件名，加删一个文件即可发现
const selected = () => plugins.get(process.env.MESSAGE_SENDER_PLUGIN || 'command');
const channel = z.enum(['email', 'sms']);
const invalid = '验证码无效或已过期，请重新获取后重试。';
function digest(id: string, userId: string, code: string) { return createHmac('sha256', process.env.VERIFICATION_KEY ?? process.env.AUDIT_KEY!).update(`yunzou-verification:${userId}:${id}:${code}`).digest('hex'); }
async function available(type: VerificationChannel) { const sender = selected(); return !!sender && await sender.available(type); }
function destination(type: VerificationChannel, value: unknown) { return type === 'email' ? read(z.string().trim().toLowerCase().email().max(254), value) : read(z.string().trim().regex(/^\+[1-9]\d{6,14}$/, '手机号请填写含国家区号的国际格式，例如+8613800000000'), value); }
@Controller()
export default class Verification {
    @Get('auth/verification')
    async status(
    @Req()
    request: SessionRequest) {
        interactive(request);
        const user = (await pool.query('SELECT email,phone,email_verified_at IS NOT NULL AS "emailVerified",phone_verified_at IS NOT NULL AS "phoneVerified" FROM users WHERE id=$1', [request.user.id])).rows[0];
        return { ...user, emailEnabled: await available('email'), smsEnabled: await available('sms') }; // 没有真实发送程序不展示可用发送入口
    }
    @Post('auth/verification/challenges')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        interactive(request);
        const input = read(z.object({ channel, destination: z.string().max(254) }).strict(), body), target = destination(input.channel, input.destination);
        if (!await available(input.channel))
            throw new ServiceUnavailableException('此验证渠道尚未启用，请联系支持团队');
        const id = randomUUID(), code = String(randomInt(1000000)).padStart(6, '0'), ip = tokenHash(request.ip ?? ''), hash = digest(id, request.user.id, code);
        const expires = await transaction(async (connection) => {
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`verification:${request.user.id}`]); // 同一账户的发送限额串行核对
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`verification-destination:${target}`]); // 多账号不能并发轰炸同一地址
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`verification-ip:${ip}`]); // 共享来源的发送上限也不能被并发跨过
            const limits = (await connection.query("WITH sends AS(SELECT user_id,destination,ip_hash,created_at FROM verification_challenges UNION ALL SELECT user_id,destination,ip_hash,created_at FROM account_challenges) SELECT count(*) FILTER(WHERE user_id=$1)::int AS account,count(*) FILTER(WHERE destination=$2)::int AS destination,count(*) FILTER(WHERE ip_hash=$3)::int AS ip,bool_or(created_at>now()-interval '1 minute' AND (user_id=$1 OR destination=$2)) AS recent FROM sends WHERE created_at>now()-interval '1 hour' AND (user_id=$1 OR destination=$2 OR ip_hash=$3)", [request.user.id, target, ip])).rows[0]; // 公开验证和登录后换绑共用真实发送预算，不能交替入口绕过
            if (limits.recent || limits.account >= 5 || limits.destination >= 5 || limits.ip >= 20)
                throw new HttpException('验证码发送较频繁，请稍后再试', 429);
            const current = (await connection.query('SELECT session_version FROM users WHERE id=$1 AND NOT disabled FOR SHARE', [request.user.id])).rows[0];
            if (!current)
                throw new NotFoundException('账号不可用');
            await connection.query('UPDATE verification_challenges SET consumed_at=now() WHERE user_id=$1 AND channel=$2 AND consumed_at IS NULL', [request.user.id, input.channel]); // 新验证码取代同一用途的旧验证码
            const saved = (await connection.query('INSERT INTO verification_challenges(id,user_id,channel,destination,code_hash,session_version,ip_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expires_at', [id, request.user.id, input.channel, target, hash, current.session_version, ip])).rows[0];
            await record(connection, request.actorId ?? request.user.id, 'verification.request', id, { channel: input.channel });
            return saved.expires_at;
        });
        try {
            await selected()!.send({ id, channel: input.channel, destination: target, code, expiresInSeconds: 600, message: `狐岚云验证码：${code}，10分钟内有效。请勿向他人透露。` });
        }
        catch {
            await transaction(async (connection) => { await connection.query('UPDATE verification_challenges SET consumed_at=now() WHERE id=$1', [id]); await record(connection, request.actorId ?? request.user.id, 'verification.delivery_failed', id, { channel: input.channel }); });
            throw new ServiceUnavailableException('验证码未能发送，请稍后重试或联系支持团队');
        }
        await transaction(async (connection) => { await connection.query('UPDATE verification_challenges SET sent_at=now() WHERE id=$1 AND consumed_at IS NULL', [id]); await record(connection, request.actorId ?? request.user.id, 'verification.sent', id, { channel: input.channel }); });
        return { id, expiresAt: expires, retryAfterSeconds: 60 }; // 响应和日志均不返回验证码
    }
    @Post('auth/verification/confirm')
    async confirm(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest, 
    @Res({ passthrough: true })
    response: Response) {
        interactive(request);
        const input = read(z.object({ id: uuid, code: z.string().regex(/^\d{6}$/), password: z.string().min(1).max(128), ...factorFields }).strict(), body);
        const verified = await transaction(async (connection) => {
            const challenge = (await connection.query('SELECT c.*,c.expires_at>clock_timestamp() AS valid,u.session_version AS version FROM verification_challenges c JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE OF c', [input.id, request.user.id])).rows[0];
            if (!challenge || challenge.consumed_at || !challenge.sent_at || !challenge.valid || challenge.attempts >= 5 || challenge.session_version !== challenge.version)
                return false;
            const equal = timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(digest(input.id, request.user.id, input.code), 'hex'));
            if (!equal) {
                await connection.query('UPDATE verification_challenges SET attempts=attempts+1,consumed_at=CASE WHEN attempts+1>=5 THEN now() ELSE NULL END WHERE id=$1', [input.id]);
                await record(connection, request.actorId ?? request.user.id, 'verification.code_failed', input.id, { channel: challenge.channel });
            }
            return equal;
        });
        if (!verified)
            throw new BadRequestException(invalid); // 失败次数已经提交，抛错不会把计数回滚
        await verifyIdentity(request, input, 'verification.confirm'); // 当前密码与第二因素独立消费，子账号/API密钥不能代办
        let saved: {
            version: number;
            channel: VerificationChannel;
        };
        try {
            saved = await transaction(async (connection) => {
                const user = (await connection.query('SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE', [request.user.id])).rows[0];
                const challenge = (await connection.query('SELECT *,expires_at>clock_timestamp() AS valid FROM verification_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE', [input.id, request.user.id])).rows[0];
                if (!user || !challenge || challenge.consumed_at || !challenge.sent_at || !challenge.valid || challenge.attempts >= 5 || challenge.session_version !== user.session_version)
                    throw new BadRequestException(invalid);
                const result = challenge.channel === 'email' ? await connection.query('UPDATE users SET email=$2,email_verified_at=now(),session_version=session_version+1,updated_at=now() WHERE id=$1 RETURNING session_version', [user.id, challenge.destination]) : await connection.query('UPDATE users SET phone=$2,phone_verified_at=now(),session_version=session_version+1,updated_at=now() WHERE id=$1 RETURNING session_version', [user.id, challenge.destination]);
                await connection.query('UPDATE verification_challenges SET consumed_at=now() WHERE id=$1', [input.id]);
                await notify(connection, user.id, challenge.channel === 'email' ? '登录邮箱已验证' : '联系手机已验证', '这次安全资料变更已保存，其它登录会话已失效。若不是你操作，请立即联系支持团队。', '/console/verification');
                await record(connection, request.actorId ?? request.user.id, 'verification.confirmed', input.id, { channel: challenge.channel, changed: challenge.channel === 'email' ? user.email !== challenge.destination : user.phone !== challenge.destination });
                return { version: result.rows[0].session_version, channel: challenge.channel };
            });
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === '23505')
                throw new BadRequestException(invalid);
            throw error;
        } // 未证明地址归属的人不能从发码接口枚举其它账户
        await startSession(request.user.id, saved.version, response);
        return { ok: true, channel: saved.channel }; // 新Cookie与数据库凭据版本保持一致
    }
}

// 公开登录/注册/找回与已登录换绑共用同一真实发送边界，不重复登记插件。
export { available as verificationEnabled, destination as verificationDestination };
export async function deliverMessage(message: MessageEnvelope) { await selected()!.send(message); }
export const sendVerificationMessage=deliverMessage;
