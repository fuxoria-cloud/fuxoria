/* 客户资源模块：在线受控插件声明动作、状态、监控、短期控制台及凭据。
 * 调用：GET /services/:id/resource；POST /services/:id/resource/jobs + Idempotency-Key；POST /resource-jobs/:id/private。
 * 输入入队前AES-GCM加密，公共结果仅含白名单字段；私有结果本人复核后一次读取。
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { identityProof, identityProofFields } from './role.js';
import { type SessionRequest, interactive } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const keyName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/),
  label = z.string().trim().min(1).max(80);
const field = z
  .object({
    key: keyName,
    label,
    secret: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict();
const capabilitySchema = z
  .object({
    clientActions: z
      .array(
        z
          .object({
            id: keyName,
            label,
            destructive: z.boolean().optional(),
            fields: z.array(field).max(20).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    inspect: z
      .array(field.omit({ secret: true, required: true }))
      .max(30)
      .optional(),
    metrics: z
      .array(
        z
          .object({ key: keyName, label, unit: z.string().max(20).optional() })
          .strict(),
      )
      .max(12)
      .optional(),
    consoleOrigins: z.array(z.string().url().max(300)).max(10).optional(),
    credentialFields: z
      .array(field.omit({ secret: true, required: true }))
      .max(20)
      .optional(),
  })
  .strict();
export type ResourceCapability = z.infer<typeof capabilitySchema>;
const operation = z.enum([
  'action',
  'inspect',
  'metrics',
  'console',
  'credentials',
]);
const submit = z
  .object({
    operation,
    actionId: keyName.optional(),
    input: z.record(keyName, z.string().max(4096)).default({}),
    password: z.string().min(1).max(128).optional(),
    totp: z.string().max(20).optional(),
    recoveryCode: z.string().max(100).optional(),
  })
  .strict();
function resourceKey() {
  const value = process.env.RESOURCE_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new ServiceUnavailableException('资源控制的独立加密密钥尚未配置');
  return Buffer.from(value, 'hex');
}
export function resourceEncrypt(
  value: unknown,
  serviceId: string,
  jobId: string,
  direction: 'input' | 'output',
) {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', resourceKey(), nonce);
  cipher.setAAD(
    Buffer.from(`yunzou-resource:v1:${serviceId}:${jobId}:${direction}`),
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}
function decrypt(ciphertext: string, serviceId: string, jobId: string) {
  try {
    const [v, n, c, t, ...extra] = ciphertext.split('.');
    if (v !== 'v1' || extra.length) throw Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      resourceKey(),
      Buffer.from(n!, 'base64url'),
    );
    decipher.setAAD(
      Buffer.from(`yunzou-resource:v1:${serviceId}:${jobId}:output`),
    );
    decipher.setAuthTag(Buffer.from(t!, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(c!, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    ) as unknown;
  } catch {
    throw new ServiceUnavailableException(
      '私有资源结果无法解密，请核对资源密钥',
    );
  }
}
async function owned(
  connection: Pick<PoolClient, 'query'>,
  id: string,
  userId: string,
  lock = false,
) {
  const found = await connection.query(
    `SELECT s.id,s.name,s.status,s.external_id AS "externalId",p.provider,COALESCE(s.current_owner_id,s.user_id) AS "ownerId" FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 AND COALESCE(s.current_owner_id,s.user_id)=$2 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [id, userId],
  );
  if (!found.rowCount) throw new NotFoundException('服务不存在');
  return found.rows[0];
}
async function idle(connection: Pick<PoolClient, 'query'>, id: string) {
  const result = await connection.query(
    `SELECT 1 FROM services s WHERE s.id=$1 AND s.status IN ('active','suspended') AND s.external_id IS NOT NULL AND s.termination_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM service_transfers t WHERE t.service_id=s.id AND t.status='pending') AND NOT EXISTS(SELECT 1 FROM service_cancellations c WHERE c.service_id=s.id AND c.status IN ('pending','approved','executing')) AND NOT EXISTS(SELECT 1 FROM service_upgrades u WHERE u.service_id=s.id AND u.status IN ('quoted','unpaid','queued','review'))`,
    [id],
  );
  if (!result.rowCount)
    throw new ConflictException(
      '服务正在转移、取消或变更配置，请先处理当前操作',
    );
}
async function liveCapability(
  provider: string,
): Promise<ResourceCapability | null> {
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.RESOURCE_KEY ?? '')) return null;
  const result = await pool.query(
    `SELECT p->'resource' AS capability FROM agent_presence n CROSS JOIN LATERAL jsonb_array_elements(n.plugins) p WHERE n.heartbeat_at>now()-interval '90 seconds' AND p->>'id'=$1 AND p->>'mode'='command' AND p->'actions' ? 'resource' AND p ? 'resource' ORDER BY n.heartbeat_at DESC LIMIT 20`,
    [provider],
  );
  const values = result.rows
    .map((row) => capabilitySchema.safeParse(row.capability))
    .filter((item) => item.success)
    .map((item) => item.data!);
  if (!values.length) return null;
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : v && typeof v === 'object'
        ? '{' +
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, val]) => JSON.stringify(k) + ':' + canonical(val))
            .join(',') +
          '}'
        : JSON.stringify(v);
  if (values.some((value) => canonical(value) !== canonical(values[0])))
    throw new ConflictException(
      '供应商运行节点的资源能力不一致，请管理员统一插件版本',
    );
  return values[0]!;
}
function authorize(
  capability: ResourceCapability,
  input: z.infer<typeof submit>,
) {
  const selected = capability.clientActions?.find(
    (item) => item.id === input.actionId,
  );
  if (input.operation === 'action' && !selected)
    throw new ConflictException('插件没有声明此客户动作');
  if (input.operation !== 'action' && input.actionId)
    throw new ConflictException('此操作不接受动作名');
  if (
    (input.operation === 'inspect' && !capability.inspect?.length) ||
    (input.operation === 'metrics' && !capability.metrics?.length) ||
    (input.operation === 'console' && !capability.consoleOrigins?.length) ||
    (input.operation === 'credentials' && !capability.credentialFields?.length)
  )
    throw new ConflictException('插件没有声明此能力');
  if (input.operation === 'metrics') {
    const range = read(
      z
        .object({
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          metric: keyName.optional(),
        })
        .strict()
        .refine(
          (value) => Boolean(value.from) === Boolean(value.to),
          '请选择完整监控时间段',
        ),
      input.input,
    );
    if (
      range.metric &&
      !capability.metrics?.some((item) => item.key === range.metric)
    )
      throw new ConflictException('请选择插件声明的监控指标');
    if (range.from && range.to) {
      const from = Date.parse(range.from),
        to = Date.parse(range.to);
      if (from >= to || to > Date.now() + 60000 || to - from > 31 * 86400000)
        throw new ConflictException('监控单次查询最长31天，结束时间需晚于开始且不能在未来');
    }
    return false;
  }
  const fields = selected?.fields ?? [];
  if (
    Object.keys(input.input).some(
      (key) => !fields.some((field) => field.key === key),
    ) ||
    fields.some((field) => field.required && !input.input[field.key])
  )
    throw new ConflictException('请按插件声明填写操作参数');
  return (
    input.operation === 'console' ||
    input.operation === 'credentials' ||
    !!selected?.destructive ||
    !!selected?.fields?.some((field) => field.secret)
  );
}
const jobsColumns = `r.service_id AS "serviceId",j.id,j.state,CASE WHEN j.result->'data' ? 'privateAvailable' THEN jsonb_set(j.result,'{data,privateAvailable}',to_jsonb(EXISTS(SELECT 1 FROM resource_private_outputs private WHERE private.job_id=j.id AND private.revealed_at IS NULL AND private.expires_at>now()))) ELSE j.result END AS result,j.created_at AS "createdAt",j.updated_at AS "updatedAt",r.operation,r.action_id AS "actionId",CASE WHEN j.last_error IS NOT NULL THEN '资源操作未完成，请联系管理员核对实际状态' ELSE NULL END AS "error"`;
@Controller()
export default class Resource {
  @Get('services/:id/resource') async get(
    @Param('id') id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const service = await owned(pool, id, request.user.id);
    await idle(pool, id);
    const capability = await liveCapability(service.provider);
    return {
      service: { id: service.id, name: service.name, status: service.status },
      capability,
      jobs: (
        await pool.query(
          `SELECT ${jobsColumns} FROM resource_requests r JOIN jobs j ON j.id=r.job_id WHERE r.service_id=$1 AND r.user_id=$2 ORDER BY r.created_at DESC LIMIT 30`,
          [id, request.user.id],
        )
      ).rows,
    };
  }
  @Post('services/:id/resource/jobs') async create(
    @Param('id') id: string,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(submit, body),
      token = read(
        z
          .string()
          .min(8)
          .max(100)
          .regex(/^[a-zA-Z0-9_-]+$/),
        key,
      );
    const service = await owned(pool, id, request.user.id),
      capability = await liveCapability(service.provider);
    if (!capability)
      throw new ConflictException('供应商当前没有在线资源控制能力');
    if (authorize(capability, input)) {
      interactive(request);
      if (!input.password)
        throw new ConflictException('此动作需要当前密码和已启用的第二因素');
      await identityProof(
        request,
        { ...input, password: input.password },
        'resource.execute',
      );
    }
    const fingerprint = createHmac('sha256', resourceKey())
      .update(
        JSON.stringify({
          id,
          operation: input.operation,
          actionId: input.actionId ?? '',
          input: Object.fromEntries(Object.entries(input.input).sort()),
        }),
      )
      .digest('hex');
    return transaction(async (connection) => {
      await connection.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`resource:${request.user.id}:${token}`],
      );
      const prior = await connection.query(
        'SELECT job_id AS id,request_hash FROM resource_requests WHERE user_id=$1 AND idempotency_key=$2',
        [request.user.id, token],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== fingerprint)
          throw new ConflictException('此提交标识已用于其它资源操作');
        return { id: prior.rows[0].id };
      }
      await owned(connection, id, request.user.id, true);
      await idle(connection, id);
      if (
        (
          await connection.query(
            "SELECT 1 FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review') LIMIT 1",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException('请先等待当前服务操作完成');
      const actor = (
        await connection.query(
          'SELECT session_version FROM users WHERE id=$1 AND NOT disabled FOR SHARE',
          [request.actorId ?? request.user.id],
        )
      ).rows[0];
      if (!actor) throw new ConflictException('账号授权已变化，请重新登录');
      const jobId = randomUUID(),
        payload = {
          operation: input.operation,
          actionId: input.actionId ?? '',
          capability,
          encryptedInput: resourceEncrypt(input.input, id, jobId, 'input'),
        };
      await connection.query(
        "INSERT INTO jobs(id,service_id,action,provider,payload,dedup_key,max_attempts) VALUES($1,$2,'resource',$3,$4,$5,3)",
        [
          jobId,
          id,
          service.provider,
          payload,
          `resource:${request.user.id}:${token}`,
        ],
      );
      await connection.query(
        'INSERT INTO resource_requests(job_id,service_id,user_id,actor_id,actor_version,idempotency_key,request_hash,operation,action_id,api_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          jobId,
          id,
          request.user.id,
          request.actorId ?? request.user.id,
          actor.session_version,
          token,
          fingerprint,
          input.operation,
          input.actionId ?? '',
          request.apiKeyId ?? null,
        ],
      );
      await record(
        connection,
        request.actorId ?? request.user.id,
        'resource.requested',
        id,
        { jobId, operation: input.operation, actionId: input.actionId ?? '' },
      );
      return { id: jobId };
    });
  }
  @Get('resource-jobs/:id') async job(
    @Param('id') id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const result = await pool.query(
      `SELECT ${jobsColumns} FROM resource_requests r JOIN jobs j ON j.id=r.job_id JOIN services s ON s.id=r.service_id WHERE j.id=$1 AND r.user_id=$2 AND COALESCE(s.current_owner_id,s.user_id)=$2`,
      [id, request.user.id],
    );
    if (!result.rowCount) throw new NotFoundException('资源任务不存在');
    await idle(pool, result.rows[0].serviceId);
    return result.rows[0];
  }
  @Post('resource-jobs/:id/private') async private(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(z.object(identityProofFields).strict(), body);
    await identityProof(request, input, 'resource.private');
    return transaction(async (connection) => {
      const found = await connection.query(
        `SELECT o.*,r.service_id,r.operation FROM resource_private_outputs o JOIN resource_requests r ON r.job_id=o.job_id JOIN services s ON s.id=r.service_id JOIN jobs j ON j.id=r.job_id WHERE o.job_id=$1 AND r.user_id=$2 AND COALESCE(s.current_owner_id,s.user_id)=$2 AND j.state='succeeded' AND o.expires_at>now() AND o.revealed_at IS NULL FOR UPDATE OF o,s`,
        [id, request.user.id],
      );
      if (!found.rowCount)
        throw new NotFoundException('私有结果已读取、过期或不属于当前账号');
      const row = found.rows[0];
      await idle(connection, row.service_id);
      const value = decrypt(row.ciphertext, row.service_id, id);
      await connection.query(
        'UPDATE resource_private_outputs SET revealed_at=now() WHERE job_id=$1',
        [id],
      );
      await record(
        connection,
        request.actorId ?? request.user.id,
        'resource.private_read',
        row.service_id,
        { jobId: id, operation: row.operation },
      );
      return value;
    });
  }
}
