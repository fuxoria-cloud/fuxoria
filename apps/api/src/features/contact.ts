/* 联系人和子账号：主账号保存联系资料，按真实路由授权，可启停独立登录。
 * 调用：GET/POST /contacts；PUT/DELETE /contacts/:id。写操作需要主账号当前密码/MFA。
 * 既有邮箱不能被接管为子账号；删除联系人会停用其独立登录并撤销旧会话。
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
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { hash, argon2id } from 'argon2';
import { z } from 'zod';
import { interactive, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import {
  identityProof,
  identityProofFields,
  permissionCatalog,
} from './role.js';
const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(40).default(''),
    company: z.string().trim().max(120).default(''),
    address: z.string().trim().max(500).default(''),
    notifications: z
      .array(z.enum(['general', 'product', 'invoice', 'support', 'affiliate']))
      .max(5)
      .default([]),
    permissions: z
      .array(z.string().max(250))
      .max(500)
      .transform((value) => [...new Set(value)])
      .default([]),
    active: z.boolean().default(true),
    loginEnabled: z.boolean().default(false),
    newPassword: z.string().min(12).max(128).optional(),
    ...identityProofFields,
  })
  .strict();
const columns =
  'c.id,c.name,c.email,c.phone,c.company,c.address,c.notifications,c.permissions,c.active,c.child_user_id AS "childUserId",(c.child_user_id IS NOT NULL AND NOT COALESCE(u.disabled,true)) AS "loginEnabled",c.created_at AS "createdAt",c.updated_at AS "updatedAt"';
@Controller('contacts')
export default class Contact {
  @Get('permissions')
  async permissions(
    @Req()
    request: SessionRequest,
  ) {
    interactive(request);
    return (await permissionCatalog()).filter((item) => item.delegable);
  }
  @Get()
  async list(
    @Req()
    request: SessionRequest,
  ) {
    interactive(request);
    return (
      await pool.query(
        `SELECT ${columns} FROM contacts c LEFT JOIN users u ON u.id=c.child_user_id WHERE c.owner_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC`,
        [request.user.id],
      )
    ).rows;
  }
  @Post()
  create(
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    return this.save(null, body, request);
  }
  @Put(':id')
  update(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    return this.save(id, body, request);
  }
  private async save(
    id: string | null,
    body: unknown,
    request: SessionRequest,
  ) {
    const input = read(inputSchema, body);
    const known = new Set(
      (await this.permissions(request)).map((item) => item.key),
    );
    if (input.permissions.some((item) => !known.has(item)))
      throw new ForbiddenException('子账号只能使用可委托的客户接口');
    await identityProof(
      request,
      input,
      id ? 'contact.update' : 'contact.create',
    );
    const digest = input.newPassword
      ? await hash(input.newPassword, { type: argon2id })
      : null;
    return transaction(async (connection) => {
      await connection.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`contacts:${request.user.id}`],
      );
      const previous = id
        ? (
            await connection.query(
              'SELECT * FROM contacts WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',
              [id, request.user.id],
            )
          ).rows[0]
        : undefined;
      if (id && !previous) throw new NotFoundException('联系人不存在');
      if (
        (
          await connection.query(
            'SELECT 1 FROM contacts WHERE owner_id=$1 AND email=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id<>$3)',
            [request.user.id, input.email, id],
          )
        ).rowCount
      )
        throw new ConflictException('这个邮箱已在联系人中');
      let child = previous?.child_user_id ?? null;
      if (input.loginEnabled && !child) {
        if (!digest)
          throw new ConflictException('首次启用独立登录请设置至少12位密码');
        const created = await connection.query(
          "INSERT INTO users(email,name,password,role,disabled) VALUES($1,$2,$3,'customer',$4) ON CONFLICT(email) DO NOTHING RETURNING id",
          [input.email, input.name, digest, !input.active],
        );
        if (!created.rowCount)
          throw new ConflictException(
            '此邮箱已有账号，请使用未注册的联系人邮箱',
          );
        child = created.rows[0].id;
      } else if (child) {
        if (
          (
            await connection.query(
              'SELECT 1 FROM users WHERE email=$1 AND id<>$2',
              [input.email, child],
            )
          ).rowCount
        )
          throw new ConflictException('此邮箱已有其他账号');
        await connection.query(
          'UPDATE users SET email=$2,name=$3,password=COALESCE($4,password),disabled=$5,session_version=session_version+1,updated_at=now() WHERE id=$1',
          [
            child,
            input.email,
            input.name,
            digest,
            !(input.active && input.loginEnabled),
          ],
        ); // 调整委托或密码后撤销旧登录
      }
      const values = [
        request.user.id,
        child,
        input.name,
        input.email,
        input.phone,
        input.company,
        input.address,
        input.notifications,
        input.permissions,
        input.active,
      ];
      const found = id
        ? await connection.query(
            'UPDATE contacts SET name=$3,email=$4,phone=$5,company=$6,address=$7,notifications=$8,permissions=$9,active=$10,child_user_id=$2,updated_at=now() WHERE id=$11 AND owner_id=$1 RETURNING id',
            [...values, id],
          )
        : await connection.query(
            'INSERT INTO contacts(owner_id,child_user_id,name,email,phone,company,address,notifications,permissions,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
            values,
          );
      const target = found.rows[0].id;
      await record(
        connection,
        request.actorId ?? request.user.id,
        id ? 'contact.update' : 'contact.create',
        target,
        {
          childUserId: child,
          loginEnabled: input.loginEnabled,
          active: input.active,
          permissions: input.permissions,
        },
      );
      return (
        await connection.query(
          `SELECT ${columns} FROM contacts c LEFT JOIN users u ON u.id=c.child_user_id WHERE c.id=$1`,
          [target],
        )
      ).rows[0];
    });
  }
  @Delete(':id')
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
    await identityProof(request, input, 'contact.delete');
    return transaction(async (connection) => {
      const found = await connection.query(
        'SELECT child_user_id FROM contacts WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [id, request.user.id],
      );
      if (!found.rowCount) throw new NotFoundException('联系人不存在');
      if (found.rows[0].child_user_id)
        await connection.query(
          'UPDATE users SET disabled=true,session_version=session_version+1,updated_at=now() WHERE id=$1',
          [found.rows[0].child_user_id],
        );
      await connection.query(
        "UPDATE contacts SET active=false,permissions='{}',deleted_at=now(),updated_at=now() WHERE id=$1",
        [id],
      );
      await record(
        connection,
        request.actorId ?? request.user.id,
        'contact.delete',
        id,
        {},
      );
      return { ok: true };
    });
  }
}
