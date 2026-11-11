/* 客户与客户组：可查可改的资料、分组折扣、停用与内部备注，不允许借此改管理员角色。
 * 调用：GET/POST /admin/clients；PUT /admin/clients/:id；/admin/client-groups管理客户组。
 * 写操作复核当前密码/MFA，停用立即递增会话版本；客户看不到内部备注。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { hash, argon2id } from 'argon2';
import { z } from 'zod';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { adminActor, identityProof, identityProofFields } from './role.js';
const group = z
  .object({
    name: z.string().trim().min(1).max(80),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#61afef'),
    discountPercent: z.number().int().min(0).max(100).default(0),
    suspendExempt: z.boolean().default(false),
    separateInvoices: z.boolean().default(false),
    ...identityProofFields,
  })
  .strict();
const groupColumns =
  'id,name,color,discount_percent AS "discountPercent",suspend_exempt AS "suspendExempt",separate_invoices AS "separateInvoices",created_at AS "createdAt"';
const clientColumns =
  'u.id,u.email,u.name,u.disabled,u.client_group_id AS "groupId",g.name AS "groupName",u.admin_notes AS notes,u.phone,u.company,u.country,u.address,u.created_at AS "createdAt",u.last_login_at AS "lastLoginAt"';
@Controller('admin')
@Roles('admin')
export default class Client {
  @Get('client-groups')
  async groups() {
    return (
      await pool.query(
        `SELECT ${groupColumns},(SELECT count(*)::int FROM users WHERE client_group_id=client_groups.id) AS "clientCount" FROM client_groups ORDER BY name,id`,
      )
    ).rows;
  }
  @Post('client-groups')
  async createGroup(
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    const input = read(group, body);
    await identityProof(request, input, 'client-group.create');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      const found = await connection.query(
        `INSERT INTO client_groups(name,color,discount_percent,suspend_exempt,separate_invoices) VALUES($1,$2,$3,$4,$5) ON CONFLICT(name) DO NOTHING RETURNING ${groupColumns}`,
        [
          input.name,
          input.color,
          input.discountPercent,
          input.suspendExempt,
          input.separateInvoices,
        ],
      );
      if (!found.rowCount) throw new ConflictException('客户组名称已存在');
      await record(
        connection,
        actor.id,
        'client-group.create',
        found.rows[0].id,
        {
          discountPercent: input.discountPercent,
          suspendExempt: input.suspendExempt,
          separateInvoices: input.separateInvoices,
        },
      );
      return found.rows[0];
    });
  }
  @Put('client-groups/:id')
  async updateGroup(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(group, body);
    await identityProof(request, input, 'client-group.update');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      if (
        (
          await connection.query(
            'SELECT 1 FROM client_groups WHERE name=$1 AND id<>$2',
            [input.name, id],
          )
        ).rowCount
      )
        throw new ConflictException('客户组名称已存在');
      const found = await connection.query(
        `UPDATE client_groups SET name=$2,color=$3,discount_percent=$4,suspend_exempt=$5,separate_invoices=$6 WHERE id=$1 RETURNING ${groupColumns}`,
        [
          id,
          input.name,
          input.color,
          input.discountPercent,
          input.suspendExempt,
          input.separateInvoices,
        ],
      );
      if (!found.rowCount) throw new NotFoundException('客户组不存在');
      await record(connection, actor.id, 'client-group.update', id, {
        discountPercent: input.discountPercent,
        suspendExempt: input.suspendExempt,
        separateInvoices: input.separateInvoices,
      });
      return found.rows[0];
    });
  }
  @Delete('client-groups/:id')
  async deleteGroup(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, input, 'client-group.delete');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      await connection.query(
        'SELECT id FROM client_groups WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (
        (
          await connection.query(
            'SELECT 1 FROM users WHERE client_group_id=$1 LIMIT 1',
            [id],
          )
        ).rowCount
      )
        throw new ConflictException('客户组仍有客户，请先调整分组');
      if (
        !(
          await connection.query(
            'DELETE FROM client_groups WHERE id=$1 RETURNING id',
            [id],
          )
        ).rowCount
      )
        throw new NotFoundException('客户组不存在');
      await record(connection, actor.id, 'client-group.delete', id, {});
      return { ok: true };
    });
  }
  @Get('clients')
  async list(
    @Query()
    query: unknown,
  ) {
    const input = read(
      z
        .object({
          page: z.coerce.number().int().min(1).max(100000).default(1),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          keyword: z.string().trim().max(100).default(''),
          groupId: uuid.optional(),
        })
        .strict(),
      query,
    );
    const where =
      "FROM users u LEFT JOIN client_groups g ON g.id=u.client_group_id WHERE u.role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id) AND ($1::text='' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%') AND ($2::uuid IS NULL OR u.client_group_id=$2)";
    const [items, count] = await Promise.all([
      pool.query(
        `SELECT ${clientColumns} ${where} ORDER BY u.created_at DESC,u.id LIMIT $3 OFFSET $4`,
        [
          input.keyword,
          input.groupId ?? null,
          input.limit,
          (input.page - 1) * input.limit,
        ],
      ),
      pool.query(`SELECT count(*)::int AS total ${where}`, [
        input.keyword,
        input.groupId ?? null,
      ]),
    ]);
    return {
      items: items.rows,
      total: count.rows[0].total,
      page: input.page,
      limit: input.limit,
    };
  }
  @Get('clients/:id')
  async get(
    @Param('id')
    id: string,
  ) {
    read(uuid, id);
    const found = await pool.query(
      `SELECT ${clientColumns},(SELECT count(*)::int FROM orders WHERE user_id=u.id) AS "orderCount",(SELECT count(*)::int FROM services s WHERE COALESCE((to_jsonb(s)->>'current_owner_id')::uuid,s.user_id)=u.id) AS "serviceCount" FROM users u LEFT JOIN client_groups g ON g.id=u.client_group_id WHERE u.id=$1 AND u.role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id)`,
      [id],
    );
    if (!found.rowCount) throw new NotFoundException('客户不存在');
    return found.rows[0];
  }
  @Post('clients')
  async create(
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
          groupId: uuid.nullable().default(null),
          notes: z.string().trim().max(10000).default(''),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'client.create');
    const digest = await hash(input.newPassword, { type: argon2id });
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      await this.groupExists(connection, input.groupId);
      const found = await connection.query(
        'INSERT INTO users(email,name,password,client_group_id,admin_notes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING RETURNING id,email,name,disabled,client_group_id AS "groupId"',
        [input.email, input.name, digest, input.groupId, input.notes],
      );
      if (!found.rowCount) throw new ConflictException('邮箱已经注册');
      await record(connection, actor.id, 'client.create', found.rows[0].id, {
        groupId: input.groupId,
      });
      return found.rows[0];
    });
  }
  @Put('clients/:id')
  async update(
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
          name: z.string().trim().min(1).max(60),
          groupId: uuid.nullable(),
          disabled: z.boolean(),
          notes: z.string().trim().max(10000),
          ...identityProofFields,
        })
        .strict(),
      body,
    );
    await identityProof(request, input, 'client.update');
    return transaction(async (connection) => {
      const actor = await adminActor(connection, request);
      await this.groupExists(connection, input.groupId);
      const found = await connection.query(
        'UPDATE users u SET name=$2,client_group_id=$3,disabled=$4,admin_notes=$5,session_version=session_version+CASE WHEN disabled IS DISTINCT FROM $4::boolean THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 AND role=\'customer\' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id) RETURNING id,email,name,disabled,client_group_id AS "groupId",admin_notes AS notes',
        [id, input.name, input.groupId, input.disabled, input.notes],
      );
      if (!found.rowCount) throw new NotFoundException('客户不存在');
      await record(connection, actor.id, 'client.update', id, {
        groupId: input.groupId,
        disabled: input.disabled,
        fields: ['name', 'groupId', 'disabled', 'notes'],
      });
      return found.rows[0];
    });
  }
  private async groupExists(
    connection: import('pg').PoolClient,
    id: string | null,
  ) {
    if (
      id &&
      !(await connection.query('SELECT 1 FROM client_groups WHERE id=$1', [id]))
        .rowCount
    )
      throw new ConflictException('客户组不存在');
  }
}
