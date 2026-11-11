/* 手机登录、验证注册与密码找回：复用真实发送插件，重置只改密码和会话版本，保留本地MFA。
 * 调用：GET /auth/access-options；POST /auth/challenges {purpose,channel,destination}；
 * POST /auth/verify-login {id,code,...MFA}；/auth/verify-register {id,code,name,password}；/auth/recover {id,code,newPassword,...MFA}。
 * 手机密码登录：POST /auth/phone-login {phone,password,...MFA}。不存在账号也发出同样的挑战响应，不返回账户存在性。
 */
import { Body, Controller, Get, Post, Req, Res, BadRequestException, ConflictException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, redis, transaction } from './store.js';
import { record } from './audit.js';
import { notify } from './notification.js';
import { attachReferral } from './affiliate.js';
import { start, clear } from './session.js';
import { checkFactor, factorComplete, factorFields } from './security.js';
import { verificationEnabled, verificationDestination, sendVerificationMessage } from './verification.js';
import { Public, tokenHash, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const purpose = z.enum(['login', 'register', 'reset']), channel = z.enum(['email', 'sms']);
const codeInput = z.object({ id: uuid, code: z.string().regex(/^\d{6}$/) });
const strongPassword = z.string().min(12, '密码至少12位').max(128);
const invalid = '凭据无效或已过期，请重新核对后重试。';
function digest(id: string, destination: string, code: string) { return createHmac('sha256', process.env.VERIFICATION_KEY ?? process.env.AUDIT_KEY!).update(`yunzou-access:${id}:${destination}:${code}`).digest('hex'); }
function summary(user: Record<string, any>) { return { id: user.id, email: user.email, phone: user.phone, name: user.name, role: user.role, emailVerified: !!user.email_verified_at, phoneVerified: !!user.phone_verified_at }; }
/** 错误次数先独立提交，后面的密码/MFA失败不能回滚验证码预算。 */
async function challenge(input: {
    id: string;
    code: string;
}, expected: string) {
    const result = await transaction(async (connection) => {
        const row = (await connection.query('SELECT *,expires_at>clock_timestamp() AS valid FROM account_challenges WHERE id=$1 AND purpose=$2 FOR UPDATE', [input.id, expected])).rows[0];
        if (!row || row.consumed_at || !row.sent_at || !row.valid || row.attempts >= 5)
            return null;
        if (timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(digest(row.id, row.destination, input.code), 'hex')))
            return row;
        await connection.query('UPDATE account_challenges SET attempts=attempts+1,consumed_at=CASE WHEN attempts+1>=5 THEN now() ELSE NULL END WHERE id=$1', [row.id]);
        return null;
    });
    if (!result)
        throw new BadRequestException(invalid);
    return result;
}
/** 先锁账号再锁挑战，与改密、MFA和028绑定保持相同顺序。 */
async function locked(connection: PoolClient, row: Record<string, any>) {
    if (!row.user_id) {
        await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE id=$1', [row.id]);
        return null;
    }
    const user = (await connection.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [row.user_id])).rows[0];
    const current = (await connection.query('SELECT *,expires_at>clock_timestamp() AS valid FROM account_challenges WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
    if (!user || user.disabled || current.consumed_at || !current.valid || !current.sent_at || current.attempts >= 5 || current.session_version !== user.session_version || current.channel === 'email' && (!user.email_verified_at || user.email !== current.destination) || current.channel === 'sms' && (!user.phone_verified_at || user.phone !== current.destination))
        throw new BadRequestException(invalid);
    return user;
}
async function loginLimit(request: SessionRequest, destination: string) {
    for (const name of [`access-login:ip:${tokenHash(request.ip ?? '')}`, `access-login:destination:${tokenHash(destination)}`]) {
        const count = await redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],600) end;return n", { keys: [name], arguments: [] });
        if (Number(count) > 10)
            throw new HttpException('登录尝试较频繁，请稍后再试', 429);
    }
}
@Controller()
export default class Recovery {
    @Public()
    @Get('auth/access-options')
    async options() { return { emailEnabled: await verificationEnabled('email'), smsEnabled: await verificationEnabled('sms'), phonePasswordEnabled: true }; }
    @Public()
    @Post('auth/challenges')
    async create(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        const input = read(z.object({ purpose, channel, destination: z.string().max(254) }).strict().refine(value => value.purpose !== 'login' || value.channel === 'sms', '验证码登录请使用已验证手机号'), body), target = verificationDestination(input.channel, input.destination);
        if (!await verificationEnabled(input.channel))
            throw new ServiceUnavailableException('此验证渠道尚未启用，请使用其它方式或联系支持团队');
        const id = randomUUID(), code = String(randomInt(1000000)).padStart(6, '0'), ip = tokenHash(request.ip ?? '');
        const expires = await transaction(async (connection) => {
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`verification-destination:${target}`]);
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`verification-ip:${ip}`]); // 与028共享目的地址和来源限额锁
            const rates = (await connection.query("WITH sends AS(SELECT destination,ip_hash,created_at FROM account_challenges UNION ALL SELECT destination,ip_hash,created_at FROM verification_challenges) SELECT count(*) FILTER(WHERE destination=$1)::int AS target,count(*) FILTER(WHERE ip_hash=$2)::int AS ip,bool_or(destination=$1 AND created_at>now()-interval '1 minute') AS recent FROM sends WHERE created_at>now()-interval '1 hour' AND (destination=$1 OR ip_hash=$2)", [target, ip])).rows[0];
            if (rates.recent || rates.target >= 5 || rates.ip >= 20)
                throw new HttpException('验证码发送较频繁，请稍后再试', 429);
            const user = input.purpose === 'register' ? null : (await connection.query(`SELECT id,session_version FROM users WHERE NOT disabled AND ${input.channel === 'email' ? 'email=$1 AND email_verified_at IS NOT NULL' : 'phone=$1 AND phone_verified_at IS NOT NULL'}`, [target])).rows[0];
            await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE purpose=$1 AND channel=$2 AND destination=$3 AND consumed_at IS NULL', [input.purpose, input.channel, target]);
            const saved = (await connection.query('INSERT INTO account_challenges(id,user_id,session_version,purpose,channel,destination,code_hash,ip_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at', [id, user?.id ?? null, user?.session_version ?? null, input.purpose, input.channel, target, digest(id, target, code), ip])).rows[0];
            await record(connection, 'anonymous', 'access.challenge', id, { purpose: input.purpose, channel: input.channel });
            return saved.expires_at;
        });
        try {
            await sendVerificationMessage({ id, channel: input.channel, destination: target, code, expiresInSeconds: 600, message: `狐岚云验证码：${code}，10分钟内有效。请勿向他人透露。` });
        }
        catch {
            await transaction(async (connection) => { await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE id=$1', [id]); await record(connection, 'anonymous', 'access.delivery_failed', id, { purpose: input.purpose, channel: input.channel }); });
            throw new ServiceUnavailableException('验证码未能发送，请稍后重试或联系支持团队');
        }
        await transaction(async (connection) => { await connection.query('UPDATE account_challenges SET sent_at=now() WHERE id=$1 AND consumed_at IS NULL', [id]); await record(connection, 'anonymous', 'access.sent', id, { purpose: input.purpose, channel: input.channel }); });
        return { id, expiresAt: expires, retryAfterSeconds: 60 }; // 所有合法目标使用相同响应与真实发送流程，不暴露账号是否存在
    }
    @Public()
    @Post('auth/phone-login')
    async password(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest, 
    @Res({ passthrough: true })
    response: Response) {
        const input = read(z.object({ phone: z.string().max(16), password: z.string().min(1).max(128), ...factorFields }).strict(), body), phone = verificationDestination('sms', input.phone);
        await loginLimit(request, phone);
        const user = await transaction(async (connection) => {
            const current = (await connection.query('SELECT * FROM users WHERE phone=$1 AND phone_verified_at IS NOT NULL AND NOT disabled FOR UPDATE', [phone])).rows[0];
            const valid = current?.password.startsWith('$argon2') ? await verify(current.password, input.password) : (await hash(input.password, { type: argon2id }), false);
            if (!valid)
                throw new UnauthorizedException('手机号或密码不正确');
            await checkFactor(connection, current.id, input, 'account.phone_login');
            await connection.query('UPDATE users SET last_login_at=now(),last_login_ip=$2,updated_at=now() WHERE id=$1', [current.id, (request.ip ?? '').slice(0, 80)]);
            await record(connection, current.id, 'account.phone_login', current.id, {});
            return current;
        });
        await factorComplete(user.id);
        await start(user.id, user.session_version, response);
        return summary(user);
    }
    @Public()
    @Post('auth/verify-login')
    async login(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest, 
    @Res({ passthrough: true })
    response: Response) {
        const input = read(codeInput.extend({ ...factorFields }).strict(), body), row = await challenge(input, 'login');
        await loginLimit(request, row.destination);
        const user = await transaction(async (connection) => { const current = await locked(connection, row); if (!current)
            return null; await checkFactor(connection, current.id, input, 'account.code_login'); await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE id=$1', [row.id]); await connection.query('UPDATE users SET last_login_at=now(),last_login_ip=$2,updated_at=now() WHERE id=$1', [current.id, (request.ip ?? '').slice(0, 80)]); await record(connection, current.id, 'account.code_login', current.id, {}); return current; });
        if (!user)
            throw new BadRequestException(invalid);
        await factorComplete(user.id);
        await start(user.id, user.session_version, response);
        return summary(user);
    }
    @Public()
    @Post('auth/verify-register')
    async register(
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest, 
    @Res({ passthrough: true })
    response: Response) {
        const input = read(codeInput.extend({ name: z.string().trim().min(1).max(60), password: strongPassword, referralCode: z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional() }).strict(), body), row = await challenge(input, 'register'), encoded = await hash(input.password, { type: argon2id });
        let user: Record<string, any>;
        try {
            user = await transaction(async (connection) => {
                await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`account-register:${row.destination}`]);
                const current = (await connection.query('SELECT *,expires_at>clock_timestamp() AS valid FROM account_challenges WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
                if (current.consumed_at || !current.valid || !current.sent_at || current.attempts >= 5)
                    throw new BadRequestException(invalid);
                const saved = (await connection.query("INSERT INTO users(email,phone,email_verified_at,phone_verified_at,name,password) VALUES($1,$2,CASE WHEN $3 THEN now() ELSE NULL END,CASE WHEN $4 THEN now() ELSE NULL END,$5,$6) RETURNING *", [row.channel === 'email' ? row.destination : null, row.channel === 'sms' ? row.destination : '', row.channel === 'email', row.channel === 'sms', input.name, encoded])).rows[0];
                await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE id=$1', [row.id]);
                await attachReferral(connection, saved.id, input.referralCode);
                await record(connection, saved.id, 'account.verified_register', saved.id, { channel: row.channel });
                return saved;
            });
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === '23505')
                throw new ConflictException('无法完成注册，请核对资料或使用登录与找回功能');
            throw error;
        }
        await start(user.id, user.session_version, response);
        return summary(user);
    }
    @Public()
    @Post('auth/recover')
    async recover(
    @Body()
    body: unknown, 
    @Req()
    _request: SessionRequest, 
    @Res({ passthrough: true })
    response: Response) {
        const input = read(codeInput.extend({ newPassword: strongPassword, ...factorFields }).strict(), body), row = await challenge(input, 'reset'), encoded = await hash(input.newPassword, { type: argon2id });
        const user = await transaction(async (connection) => {
            const current = await locked(connection, row);
            if (!current)
                return null;
            await checkFactor(connection, current.id, input, 'account.password_recovery');
            await connection.query('UPDATE users SET password=$2,legacy_password=NULL,legacy_authcode_id=NULL,session_version=session_version+1,email_verified_at=CASE WHEN $3 THEN now() ELSE email_verified_at END,updated_at=now() WHERE id=$1', [current.id, encoded, row.channel === 'email']);
            await connection.query('UPDATE account_challenges SET consumed_at=now() WHERE id=$1', [row.id]);
            await notify(connection, current.id, '登录密码已重置', '旧登录会话与API密钥已失效。双因素认证继续保留；若不是你操作，请立即联系支持团队。', '/console/settings');
            await record(connection, current.id, 'account.password_recovery', current.id, { channel: row.channel, otherSessionsRevoked: true, mfaPreserved: true });
            return current;
        });
        if (!user)
            throw new BadRequestException(invalid);
        await factorComplete(user.id);
        clear(response);
        return { ok: true }; // 重置不自动登录，也不关闭MFA或创建明文口令
    }
}
