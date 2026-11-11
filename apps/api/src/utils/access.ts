/* 访问边界：会话/API密钥认证、角色与子账号逐路由权限、Cookie写请求来源校验。
 * 调用：入口注册Access；公开操作@Public()，管理操作@Roles('admin')。
 * user.id是数据归属账号，actorId是实际认证人；委托或密钥调用另记关联审计。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  HttpException,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { pool, redis, transaction } from '../features/store.js';
import { record } from '../features/audit.js';
export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
export type User = {
  id: string;
  email: string | null;
  phone?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  name: string;
  role: 'customer' | 'admin' | 'support';
  actorId?: string;
  ownerId?: string;
  delegated?: boolean;
};
export type SessionRequest = Request & {
  user: User;
  actorId?: string;
  apiKeyId?: string;
  permission?: string;
  requestId: string;
};
export const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** @returns 来自实际框架操作的稳定权限名，保留:id参数。 */
export function permissionFor(controller: Function, handler: Function): string {
  const pieces = [
    Reflect.getMetadata(PATH_METADATA, controller) ?? '',
    Reflect.getMetadata(PATH_METADATA, handler) ?? '',
  ]
    .map((value) =>
      String(Array.isArray(value) ? value[0] : value).replace(/^\/+|\/+$/g, ''),
    )
    .filter(Boolean);
  return `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod] ?? 'GET'} /api/v1/${pieces.join('/')}`;
}
/** 委托与自动化密钥不能代办主账号的凭据、授权、合同签署和资源转移。 */
export function sensitivePermission(permission: string): boolean {
  const [method, path] = permission.split(' ');
  if (/^\/api\/v1\/auth\//.test(path!))
    return !['GET /api/v1/auth/me', 'POST /api/v1/auth/logout'].includes(
      permission,
    );
  if (
    /^\/api\/v1\/(contacts|api-keys|affiliates|sales|certifications|certification-channels|oauth)(\/|$)/.test(
      path!,
    )
  )
    return true;
  if (
    /^\/api\/v1\/admin\/(roles|permissions|administrators|clients|client-groups|certifications|affiliates|affiliate-withdrawals|sales)(\/|$)/.test(
      path!,
    )
  )
    return true;
  if (
    /(?:\/service-transfers(?:\/|$)|\/services\/[^/]+\/(?:transfer|auto-renew)(?:\/|$)|\/contracts\/[^/]+\/sign$)/.test(
      path!,
    )
  )
    return true;
  if (/^\/api\/v1\/resource-jobs\/[^/]+\/private$/.test(path!)) return true;
  return (
    method !== 'GET' &&
    /^\/api\/v1\/admin\/services\/[^/]+\/actions$/.test(path!)
  );
}
export function interactive(request: SessionRequest) {
  if (request.apiKeyId || request.user.delegated)
    throw new ForbiddenException('此操作需要主账号本人登录并确认');
}
@Injectable()
export class Access implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const reflector = new Reflector(),
      request = context.switchToHttp().getRequest<SessionRequest>(),
      handler = context.getHandler(),
      controller = context.getClass();
    if (reflector.getAllAndOverride<boolean>('public', [handler, controller])) {
      if (
        request.path.toLowerCase().startsWith('/api/v1/auth/') &&
        request.method === 'POST'
      ) {
        if (!request.is('application/json'))
          throw new ForbiddenException('账号操作请使用本站表单');
        if (
          request.headers.origin &&
          request.headers.origin !== process.env.PUBLIC_ORIGIN
        )
          throw new ForbiddenException('请求来源校验失败');
        if (request.headers['sec-fetch-site'] === 'cross-site')
          throw new ForbiddenException('请从狐岚云页面登录');
      }
      return true;
    }
    const permission = permissionFor(controller, handler);
    request.permission = permission;
    const bearer = request.headers.authorization,
      cookie = request.cookies?.yunzou_session;
    let id: string,
      version: number,
      key:
        | {
            id: string;
            permissions: string[];
          }
        | undefined;
    if (bearer) {
      if (cookie || !/^Bearer yz_[A-Za-z0-9_-]{43}$/.test(bearer))
        throw new UnauthorizedException('API密钥格式无效，不能混用登录Cookie');
      const found = await pool.query(
        'SELECT id,user_id,session_version,permissions FROM api_keys WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',
        [tokenHash(bearer.slice(7))],
      );
      if (!found.rowCount)
        throw new UnauthorizedException('API密钥无效或已到期');
      key = found.rows[0];
      id = found.rows[0].user_id;
      version = found.rows[0].session_version;
      if (
        !key!.permissions.includes(permission) ||
        sensitivePermission(permission) ||
        permission === 'POST /api/v1/auth/logout'
      )
        throw new ForbiddenException('API密钥未获准执行此操作');
      const count = await redis.eval(
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
        { keys: [`api-rate:${key!.id}`], arguments: [] },
      );
      if (Number(count) > 600)
        throw new HttpException('API调用过于频繁，请稍后重试', 429);
    } else {
      if (!cookie) throw new UnauthorizedException('请先登录');
      const saved = await redis.get(`session:${tokenHash(cookie)}`);
      if (!saved) throw new UnauthorizedException('登录已过期，请重新登录');
      const session = saved.startsWith('{')
        ? (JSON.parse(saved) as {
            id: string;
            version: number;
          })
        : { id: saved, version: 0 };
      id = session.id;
      version = session.version;
    }
    const found = await pool.query(
      "SELECT u.id,u.email,u.phone,(to_jsonb(u)->>'email_verified_at') IS NOT NULL AS email_verified,(to_jsonb(u)->>'phone_verified_at') IS NOT NULL AS phone_verified,u.name,u.role,u.session_version,u.admin_role_id,r.permissions AS role_permissions,r.disabled AS role_disabled FROM users u LEFT JOIN admin_roles r ON r.id=u.admin_role_id WHERE u.id=$1 AND NOT u.disabled",
      [id],
    );
    if (!found.rowCount || found.rows[0].session_version !== version)
      throw new UnauthorizedException(
        '账号当前不可用或安全设置已更新，请重新认证',
      );
    const actor = found.rows[0];
    request.actorId = actor.id;
    request.user = {
      id: actor.id,
      email: actor.email,
      phone: actor.phone,
      emailVerified: actor.email_verified,
      phoneVerified: actor.phone_verified,
      name: actor.name,
      role: actor.role,
      actorId: actor.id,
    };
    if (
      actor.role === 'admin' &&
      actor.admin_role_id &&
      permission !== 'POST /api/v1/auth/logout'
    ) {
      if (actor.role_disabled)
        throw new UnauthorizedException(
          '管理角色已停用，请重新登录或联系管理员',
        );
      if (
        permission !== 'GET /api/v1/auth/me' &&
        !actor.role_permissions?.includes(permission)
      )
        throw new ForbiddenException('当前管理角色没有此操作权限');
    }
    const delegated = await pool.query(
      'SELECT c.owner_id,c.permissions,c.active,c.deleted_at,u.disabled,u.role FROM contacts c JOIN users u ON u.id=c.owner_id WHERE c.child_user_id=$1',
      [actor.id],
    );
    if (delegated.rowCount) {
      const contact = delegated.rows[0];
      if (!contact.active || contact.deleted_at || contact.disabled)
        throw new UnauthorizedException('子账号授权已停用');
      if (
        key ||
        sensitivePermission(permission) ||
        (!['GET /api/v1/auth/me', 'POST /api/v1/auth/logout'].includes(
          permission,
        ) &&
          !contact.permissions.includes(permission))
      )
        throw new ForbiddenException('主账号未委托此操作');
      request.user = {
        ...request.user,
        id: contact.owner_id,
        role: 'customer',
        ownerId: contact.owner_id,
        delegated: true,
      };
    }
    const roles = reflector.getAllAndOverride<string[]>('roles', [
      handler,
      controller,
    ]);
    if (roles && !roles.includes(request.user.role))
      throw new ForbiddenException('当前账号没有此操作权限');
    if (
      !key &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== process.env.PUBLIC_ORIGIN
    )
      throw new ForbiddenException('请求来源校验失败，请从狐岚云页面重新操作');
    if (key || request.user.delegated) {
      request.apiKeyId = key?.id;
      await transaction(async (connection) => {
        if (key)
          await connection.query(
            'UPDATE api_keys SET last_used_at=now() WHERE id=$1',
            [key.id],
          );
        await record(
          connection,
          key ? `apikey:${key.id}` : `contact:${actor.id}`,
          'access.authorized',
          request.user.id,
          {
            actorId: actor.id,
            keyId: key?.id,
            permission,
            requestId: request.requestId,
          },
        );
      }); // 身份审计不持业务行锁
    }
    return true;
  }
}
