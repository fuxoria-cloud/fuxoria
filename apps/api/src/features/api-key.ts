/* 开发者密钥：明文仅创建响应出现一次，数据库保存摘要、范围、到期与安全版本。
 * 调用：GET/POST /api-keys；DELETE /api-keys/:id携带当前密码及第二因素。
 * Bearer yz_...由Access核验，密钥不能再创建密钥或改动凭据和资源归属。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { read, uuid } from '../utils/input.js';
import {
  interactive,
  tokenHash,
  type SessionRequest,
} from '../utils/access.js';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import {
  identityProof,
  identityProofFields,
  permissionCatalog,
  grantSubset,
} from './role.js';
const columns =
  'id,name,prefix,permissions,expires_at AS "expiresAt",revoked_at AS "revokedAt",last_used_at AS "lastUsedAt",created_at AS "createdAt"';
@Controller('api-keys')
export default class ApiKey {
  @Get('permissions')
  async permissions(
    @Req()
    request: SessionRequest,
  ) {
    interactive(request);
    const found = await pool.query(
      'SELECT u.admin_role_id,r.permissions FROM users u LEFT JOIN admin_roles r ON r.id=u.admin_role_id WHERE u.id=$1',
      [request.user.id],
    );
    return (await permissionCatalog()).filter(
      (item) =>
        item.api &&
        (!item.admin || request.user.role === 'admin') &&
        (!found.rows[0].admin_role_id ||
          found.rows[0].permissions.includes(item.key)),
    );
  }
  @Get()
  async list(
    @Req()
    request: SessionRequest,
  ) {
    interactive(request);
    return (
      await pool.query(
        `SELECT ${columns} FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [request.user.id],
      )
    ).rows;
  }
  @Post()
  async create(
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    const input = read(
      z
        .object({
          name: z.string().trim().min(1).max(80),
          permissions: z
            .array(z.string().max(250))
            .min(1)
            .max(500)
            .transform((value) => [...new Set(value)]),
          expiresDays: z.number().int().min(1).max(365).default(90),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    const allowed = new Set(
      (await this.permissions(request)).map((item) => item.key),
    );
    if (input.permissions.some((permission) => !allowed.has(permission)))
      throw new ForbiddenException('只能选择当前身份获准的接口范围');
    await identityProof(request, input, 'api-key.create');
    const token = 'yz_' + randomBytes(32).toString('base64url'); // 256位随机秘密，不由用户名或时间推导
    const result = await transaction(async (connection) => {
      const actor = (
        await connection.query(
          'SELECT u.id,u.session_version,u.admin_role_id,r.permissions,r.disabled FROM users u LEFT JOIN admin_roles r ON r.id=u.admin_role_id WHERE u.id=$1 AND NOT u.disabled FOR UPDATE OF u',
          [request.user.id],
        )
      ).rows[0];
      if (!actor || actor.disabled)
        throw new ForbiddenException('账号或角色已经停用');
      if (actor.admin_role_id) {
        if (!actor.permissions.includes(request.permission))
          throw new ForbiddenException('管理角色权限已变化');
        grantSubset(actor, input.permissions);
      }
      if (
        (
          await connection.query(
            'SELECT count(*)::int AS n FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()',
            [actor.id],
          )
        ).rows[0].n >= 20
      )
        throw new ConflictException(
          '最多保留20个有效密钥，请先撤销不再使用的密钥',
        );
      const found = await connection.query(
        `INSERT INTO api_keys(user_id,name,token_hash,prefix,permissions,session_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7)) RETURNING ${columns}`,
        [
          actor.id,
          input.name,
          tokenHash(token),
          token.slice(0, 11),
          input.permissions,
          actor.session_version,
          input.expiresDays,
        ],
      );
      await record(
        connection,
        request.actorId ?? actor.id,
        'api-key.create',
        found.rows[0].id,
        { permissions: input.permissions, expiresDays: input.expiresDays },
      );
      return found.rows[0];
    });
    return { ...result, token }; // 此后列表与日志均不会再返回明文
  }
  @Delete(':id')
  async revoke(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, input, 'api-key.revoke');
    return transaction(async (connection) => {
      const found = await connection.query(
        'SELECT revoked_at FROM api_keys WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [id, request.user.id],
      );
      if (!found.rowCount) throw new NotFoundException('密钥不存在');
      if (!found.rows[0].revoked_at) {
        await connection.query(
          'UPDATE api_keys SET revoked_at=now() WHERE id=$1',
          [id],
        );
        await record(
          connection,
          request.actorId ?? request.user.id,
          'api-key.revoke',
          id,
          {},
        );
      }
      return { ok: true };
    });
  }
}
