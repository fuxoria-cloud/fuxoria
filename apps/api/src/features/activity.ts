/* 客户活动记录：仅当前账号可归属的实体和明确公开事件，不返回审计details、IP、密钥或供应商结果。
 * 调用：GET /activity?before=审计序号&action=事件名；最多50条，序号分页。
 */
import { Controller, Get, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { pool } from './store.js';
import { read } from '../utils/input.js';
import type { SessionRequest } from '../utils/access.js';
const labels: Record<string, string> = {
  'account.register': '创建账号',
  'account.login': '登录账号',
  'account.logout': '退出登录',
  'account.profile': '修改个人资料',
  'account.password.change': '修改密码',
  'account.sessions.revoke': '撤销登录会话',
  'account.logout.all': '退出所有设备',
  'order.create': '创建订单',
  'order.free': '确认免费订单',
  'order.cancel': '取消订单',
  'service.renew': '提交服务续费',
  'service.updated': '修改服务资料',
  'resource.requested': '提交资源操作',
  'resource.completed': '资源操作完成',
  'resource.private_read': '读取私有资源结果',
  'ticket.create': '创建工单',
  'ticket.reply': '回复工单',
  'ticket.close': '关闭工单',
  'ticket.reopen': '重新打开工单',
  'ticket.evaluate': '评价工单',
  'contract.request': '申请合同',
  'contract.sign': '签署合同',
  'contract.cancel': '撤回合同',
  'contract.void': '合同作废',
  'invoice.settle': '付款入账',
  'wallet.pay': '使用余额付款',
  'combined.create': '合并账单',
  'combined.cancel': '解除合并账单',
};
@Controller('activity')
export default class Activity {
  @Get() async list(@Query() query: unknown, @Req() request: SessionRequest) {
    const input = read(
      z
        .object({
          before: z
            .string()
            .regex(/^\d{1,19}$/)
            .refine((value) => BigInt(value) <= 9223372036854775807n)
            .optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          q: z.string().trim().max(80).optional(),
          action: z
            .string()
            .refine((value) => Object.hasOwn(labels, value))
            .optional(),
        })
        .strict()
        .refine(
          (value) => !value.from || !value.to || value.to >= value.from,
          '结束日期不能早于开始日期',
        ),
      query,
    );
    const found = await pool.query(
      `WITH visible AS (
 SELECT $1::uuid::text AS target,'account'::text AS domain
 UNION ALL SELECT id::text,'order' FROM orders WHERE user_id=$1
 UNION ALL SELECT id::text,'service' FROM services WHERE COALESCE(current_owner_id,user_id)=$1
 UNION ALL SELECT id::text,'ticket' FROM tickets WHERE user_id=$1
 UNION ALL SELECT id::text,'contract' FROM contracts WHERE user_id=$1
 UNION ALL SELECT id::text,'invoice' FROM invoices WHERE user_id=$1
 UNION ALL SELECT r.job_id::text,'resourcejob' FROM resource_requests r JOIN services s ON s.id=r.service_id WHERE r.user_id=$1 AND COALESCE(s.current_owner_id,s.user_id)=$1
 ) SELECT a.id::text,a.action,a.target,a.created_at AS "createdAt",a.actor=$3 AS "bySelf" FROM visible v JOIN audit a ON a.target=v.target WHERE a.action=ANY($2::text[]) AND ($4::bigint IS NULL OR a.id<$4::bigint) AND ($5::text IS NULL OR a.action=$5)
 AND ($6::date IS NULL OR a.created_at>=($6::date::timestamp AT TIME ZONE 'Asia/Shanghai')) AND ($7::date IS NULL OR a.created_at<(($7::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) AND a.action=ANY($8::text[]) AND (
 (v.domain='account' AND a.action LIKE 'account.%') OR (v.domain='order' AND a.action LIKE 'order.%')
 OR (v.domain='service' AND a.action=ANY(ARRAY['service.renew','service.updated','resource.requested','resource.private_read']))
 OR (v.domain='resourcejob' AND a.action='resource.completed') OR (v.domain='ticket' AND a.action LIKE 'ticket.%')
 OR (v.domain='contract' AND a.action LIKE 'contract.%') OR (v.domain='invoice' AND a.action=ANY(ARRAY['invoice.settle','wallet.pay','combined.create','combined.cancel']))
 ) ORDER BY a.id DESC LIMIT 51`,
      [
        request.user.id,
        Object.keys(labels),
        request.actorId ?? request.user.id,
        input.before ?? null,
        input.action ?? null,
        input.from ?? null,
        input.to ?? null,
        Object.entries(labels)
          .filter(
            ([key, label]) =>
              !input.q || label.includes(input.q) || key.includes(input.q),
          )
          .map(([key]) => key),
      ],
    );
    const rows = found.rows
      .slice(0, 50)
      .map((item) => ({ ...item, label: labels[item.action] }));
    return {
      items: rows,
      next: found.rows.length > 50 ? rows.at(-1)?.id : null,
      actions: Object.entries(labels).map(([value, label]) => ({
        value,
        label,
      })),
    };
  }
}
