/* 管理角色：从真实控制器发现权限，角色与管理员分配均需本人证明。
 * 调用：GET /admin/permissions；POST /admin/roles {name,permissions,password,...factor}。
 * 既有admin_role_id为空的管理员是owner，最后一位启用owner不能降级或停用。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants.js';
import { readdir } from 'node:fs/promises';
import { hash, argon2id } from 'argon2';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  Roles,
  interactive,
  permissionFor,
  sensitivePermission,
  type SessionRequest,
} from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { verifyIdentity, factorFields, type FactorProof } from './security.js';
export const identityProofFields = {
  password: z.string().min(1).max(128),
  ...factorFields,
};
export async function identityProof(
  request: SessionRequest,
  input: {
    password: string;
  } & FactorProof,
  scope: string,
) {
  interactive(request);
  await verifyIdentity(request, input, scope); // 证明先提交，业务随后按自己的行锁顺序执行
}
export async function permissionCatalog() {
  const result: {
    key: string;
    subject: string;
    admin: boolean;
    delegable: boolean;
    api: boolean;
  }[] = [];
  for (const file of (await readdir(new URL('./', import.meta.url))).sort()) {
    if (!/\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue;
    const module = await import(new URL(file, import.meta.url).href),
      controller = module.default;
    if (!controller?.prototype) continue;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (
        typeof handler !== 'function' ||
        !Reflect.hasMetadata(METHOD_METADATA, handler) ||
        Reflect.getMetadata('public', handler) ||
        Reflect.getMetadata('public', controller)
      )
        continue;
      const roles: string[] | undefined =
          Reflect.getMetadata('roles', handler) ??
          Reflect.getMetadata('roles', controller),
        key = permissionFor(controller, handler),
        admin =
          key.split(' ')[1]!.startsWith('/api/v1/admin/') ||
          (!!roles && !roles.includes('customer'));
      result.push({
        key,
        subject: file.replace(/\.(ts|js)$/, ''),
        admin,
        delegable: !admin && !sensitivePermission(key),
        api: !sensitivePermission(key) && key !== 'POST /api/v1/auth/logout',
      });
    }
  }
  return [...new Map(result.map((item) => [item.key, item])).values()].sort(
    (a, b) => a.key.localeCompare(b.key),
  );
}
/** 在业务事务中复核当前管理权限，防止当次证明后角色已被撤销。 */
export async function adminActor(
  connection: PoolClient,
  request: SessionRequest,
) {
  const found = await connection.query(
    "SELECT u.id,u.admin_role_id,r.permissions,r.disabled FROM users u LEFT JOIN admin_roles r ON r.id=u.admin_role_id WHERE u.id=$1 AND u.role='admin' AND NOT u.disabled",
    [request.actorId ?? request.user.id],
  );
  if (
    !found.rowCount ||
    (found.rows[0].admin_role_id &&
      (found.rows[0].disabled ||
        !found.rows[0].permissions?.includes(request.permission)))
  )
    throw new ForbiddenException('管理员权限已变化，请重新确认');
  return found.rows[0] as {
    id: string;
    admin_role_id: string | null;
    permissions: string[] | null;
  };
}
export function grantSubset(
  actor: {
    admin_role_id: string | null;
    permissions: string[] | null;
  },
  permissions: string[],
) {
  if (
    actor.admin_role_id &&
    permissions.some((permission) => !actor.permissions?.includes(permission))
  )
    throw new ForbiddenException('不能授予超出自己范围的权限');
}
async function validatePermissions(permissions: string[]) {
  const known = new Set((await permissionCatalog()).map((item) => item.key));
  if (permissions.some((item) => !known.has(item)))
    throw new ConflictException('权限列表已变化，请重新选择实际存在的接口');
}
const roleInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).default(''),
    permissions: z
      .array(z.string().max(250))
      .max(1000)
      .transform((value) => [...new Set(value)]),
    disabled: z.boolean().default(false),
    ...identityProofFields,
  })
  .strict();
const roleColumns =
  'id,name,description,permissions,disabled,created_at AS "createdAt",updated_at AS "updatedAt"';
@Controller('admin')
@Roles('admin')
export default class Role {
  @Get('permissions')
  permissions() {
    return permissionCatalog();
  }
  @Get('roles')
  async list() {
    return (
      await pool.query(
        `SELECT ${roleColumns},(SELECT count(*)::int FROM users WHERE admin_role_id=admin_roles.id) AS "memberCount" FROM admin_roles ORDER BY created_at,id`,
      )
    ).rows;
  }
  @Post('roles')
  async create(
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    const input = read(roleInput, body);
    await validatePermissions(input.permissions);
    await identityProof(request, input, 'role.create');
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request);
      grantSubset(actor, input.permissions);
      const found = await connection.query(
        `INSERT INTO admin_roles(name,description,permissions,disabled) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING RETURNING ${roleColumns}`,
        [input.name, input.description, input.permissions, input.disabled],
      );
      if (!found.rowCount) throw new ConflictException('角色名称已存在');
      await record(connection, actor.id, 'role.create', found.rows[0].id, {
        permissions: input.permissions,
      });
      return found.rows[0];
    });
  }
  @Put('roles/:id')
  async update(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(roleInput, body);
    await validatePermissions(input.permissions);
    await identityProof(request, input, 'role.update');
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request);
      grantSubset(actor, input.permissions);
      if (actor.admin_role_id === id)
        throw new ForbiddenException('不能修改自己当前使用的角色');
      const prior = await connection.query(
        'SELECT permissions FROM admin_roles WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!prior.rowCount) throw new NotFoundException('角色不存在');
      grantSubset(actor, prior.rows[0].permissions);
      if (
        (
          await connection.query(
            'SELECT 1 FROM admin_roles WHERE name=$1 AND id<>$2',
            [input.name, id],
          )
        ).rowCount
      )
        throw new ConflictException('角色名称已存在');
      const found = await connection.query(
        `UPDATE admin_roles SET name=$2,description=$3,permissions=$4,disabled=$5,updated_at=now() WHERE id=$1 RETURNING ${roleColumns}`,
        [id, input.name, input.description, input.permissions, input.disabled],
      );
      await record(connection, actor.id, 'role.update', id, {
        permissions: input.permissions,
        disabled: input.disabled,
      });
      return found.rows[0];
    });
  }
  @Post('roles/:id/copy')
  async copy(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({
          name: z.string().trim().min(1).max(80),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'role.copy');
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request),
        prior = await connection.query(
          'SELECT * FROM admin_roles WHERE id=$1',
          [id],
        );
      if (!prior.rowCount) throw new NotFoundException('角色不存在');
      grantSubset(actor, prior.rows[0].permissions);
      const found = await connection.query(
        `INSERT INTO admin_roles(name,description,permissions,disabled) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING RETURNING ${roleColumns}`,
        [
          input.name,
          prior.rows[0].description,
          prior.rows[0].permissions,
          prior.rows[0].disabled,
        ],
      );
      if (!found.rowCount) throw new ConflictException('角色名称已存在');
      await record(connection, actor.id, 'role.copy', found.rows[0].id, {
        from: id,
      });
      return found.rows[0];
    });
  }
  @Delete('roles/:id')
  async remove(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, input, 'role.delete');
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request),
        prior = await connection.query(
          'SELECT permissions FROM admin_roles WHERE id=$1 FOR UPDATE',
          [id],
        );
      if (!prior.rowCount) throw new NotFoundException('角色不存在');
      grantSubset(actor, prior.rows[0].permissions);
      if (
        (
          await connection.query(
            'SELECT 1 FROM users WHERE admin_role_id=$1 LIMIT 1',
            [id],
          )
        ).rowCount
      )
        throw new ConflictException('角色仍有管理员使用');
      await connection.query('DELETE FROM admin_roles WHERE id=$1', [id]);
      await record(connection, actor.id, 'role.delete', id, {});
      return { ok: true };
    });
  }
  @Get('administrators')
  async administrators() {
    return (
      await pool.query(
        'SELECT u.id,u.email,u.name,u.role,u.disabled,u.admin_role_id AS "roleId",r.name AS "roleName",u.created_at AS "createdAt" FROM users u LEFT JOIN admin_roles r ON r.id=u.admin_role_id WHERE u.role IN (\'admin\',\'support\') ORDER BY u.created_at DESC',
      )
    ).rows;
  }
  @Post('administrators')
  async addAdministrator(
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    const input = read(
      z
        .object({
          name: z.string().trim().min(1).max(60),
          email: z.string().trim().toLowerCase().email().max(254),
          newPassword: z.string().min(12).max(128),
          role: z.enum(['admin', 'support']).default('admin'),
          roleId: uuid.nullable().default(null),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'administrator.create');
    const digest = await hash(input.newPassword, { type: argon2id });
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request);
      await this.checkAssignment(connection, actor, input.roleId, input.role);
      const found = await connection.query(
        'INSERT INTO users(email,name,password,role,admin_role_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING RETURNING id,email,name,role,admin_role_id AS "roleId",disabled',
        [input.email, input.name, digest, input.role, input.roleId],
      );
      if (!found.rowCount) throw new ConflictException('邮箱已经注册');
      await record(
        connection,
        actor.id,
        'administrator.create',
        found.rows[0].id,
        { role: input.role, roleId: input.roleId },
      );
      return found.rows[0];
    });
  }
  @Put('administrators/:id')
  async assign(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({
          roleId: uuid.nullable(),
          disabled: z.boolean(),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'administrator.assign');
    return transaction(async (connection) => {
      await connection.query('SELECT pg_advisory_xact_lock(812450)');
      const actor = await adminActor(connection, request),
        prior = await connection.query(
          "SELECT id,role,admin_role_id,disabled FROM users WHERE id=$1 AND role IN ('admin','support') FOR UPDATE",
          [id],
        );
      if (!prior.rowCount) throw new NotFoundException('管理员不存在');
      await this.checkAssignment(
        connection,
        actor,
        input.roleId,
        prior.rows[0].role,
      );
      if (
        id === actor.id &&
        (input.disabled || input.roleId !== actor.admin_role_id)
      )
        throw new ForbiddenException('不能停用或改变自己当前使用的管理角色');
      if (
        prior.rows[0].role === 'admin' &&
        !prior.rows[0].disabled &&
        !prior.rows[0].admin_role_id &&
        (input.disabled || input.roleId)
      ) {
        const count = await connection.query(
          "SELECT count(*)::int AS n FROM users WHERE role='admin' AND NOT disabled AND admin_role_id IS NULL",
        );
        if (count.rows[0].n <= 1)
          throw new ConflictException('至少保留一位启用的最高管理员');
      }
      if (
        actor.admin_role_id &&
        prior.rows[0].role === 'admin' &&
        !prior.rows[0].admin_role_id
      )
        throw new ForbiddenException('当前角色不能更改最高管理员');
      const found = await connection.query(
        'UPDATE users SET admin_role_id=$2,disabled=$3,session_version=session_version+1,updated_at=now() WHERE id=$1 RETURNING id,email,name,role,admin_role_id AS "roleId",disabled',
        [id, input.roleId, input.disabled],
      );
      await record(connection, actor.id, 'administrator.assign', id, {
        roleId: input.roleId,
        disabled: input.disabled,
      });
      return found.rows[0];
    });
  }
  private async checkAssignment(
    connection: PoolClient,
    actor: {
      admin_role_id: string | null;
      permissions: string[] | null;
    },
    id: string | null,
    role: string,
  ) {
    if (role === 'support') {
      if (id) throw new ConflictException('客服使用部门授权，不分配管理员角色');
      return;
    }
    if (!id) {
      if (actor.admin_role_id)
        throw new ForbiddenException('当前角色不能授予最高管理员');
      return;
    }
    const found = await connection.query(
      'SELECT permissions,disabled FROM admin_roles WHERE id=$1',
      [id],
    );
    if (!found.rowCount || found.rows[0].disabled)
      throw new ConflictException('请选择启用的管理角色');
    grantSubset(actor, found.rows[0].permissions);
  }
}
