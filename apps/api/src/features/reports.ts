/* 经营报表：按实际账本、原订单与资源队列生成可筛选统计，所有金额按币种分组。
 * 调用：GET /admin/reports?from=2026-01-01&to=2026-12-31；GET /admin/reports/operations。
 * 收款、收入、退款和应收分别保留来源，不把充值或信用借用当作实收。
 */
import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { Roles } from '../utils/access.js';
import { read } from '../utils/input.js';

const filters = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    bucket: z.enum(['day', 'month']).default('month'),
    timezone: z
      .string()
      .max(80)
      .default('Asia/Shanghai')
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, '时区名称无效'),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.to) >= Date.parse(value.from) &&
      Date.parse(value.to) - Date.parse(value.from) <=
        (value.bucket === 'day' ? 366 : 3660) * 86400000,
    '按日报表最多一年，按月最多十年，结束日不能早于开始日',
  );
/** 只读业务实收视图；原子账单沿用现金/余额、信用真实还款和合并父收款来源。 */
export const businessPayments = `WITH business AS (
 SELECT i.id,i.order_id,i.user_id,i.amount_cents,i.currency,o.kind,affiliate_invoice_payment_at(i.id) AS paid_at,
 LEAST(i.amount_cents,COALESCE((SELECT sum(f.amount_cents) FROM affiliate_invoice_refunds(i.id) f WHERE f.status='succeeded'),0))::bigint AS refunded_cents
 FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.status='paid' AND i.amount_cents>0 AND o.kind IN('new','renew','upgrade') AND affiliate_invoice_payment_at(i.id) IS NOT NULL
)`;
@Controller('admin/reports')
@Roles('admin')
export default class Reports {
  @Get() async get(@Query() query: unknown) {
    const input = read(filters, query),
      values = [input.from, input.to, input.currency ?? null, input.timezone];
    return transaction(async (connection) => {
      await connection.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      ); // 同一张报表不混用同时变化的账本快照
      const range =
          't.created_at>=($1::date::timestamp AT TIME ZONE $4) AND t.created_at<(($2::date+1)::timestamp AT TIME ZONE $4) AND ($3::text IS NULL OR t.currency=$3)',
        businessRange =
          'b.paid_at>=($1::date::timestamp AT TIME ZONE $4) AND b.paid_at<(($2::date+1)::timestamp AT TIME ZONE $4) AND ($3::text IS NULL OR b.currency=$3)';
      const metrics = `COALESCE(sum(e.amount_cents) FILTER(WHERE e.account LIKE 'cash:%' AND e.amount_cents>0),0)::text AS "cashInCents",(-COALESCE(sum(e.amount_cents) FILTER(WHERE e.account LIKE 'cash:%' AND e.amount_cents<0),0))::text AS "cashOutCents",(-COALESCE(sum(e.amount_cents) FILTER(WHERE e.account LIKE 'income:%'),0))::text AS "incomeNetCents",(-COALESCE(sum(e.amount_cents) FILTER(WHERE e.account LIKE 'wallet:%'),0))::text AS "walletChangeCents",COALESCE(sum(e.amount_cents) FILTER(WHERE e.account LIKE 'receivable:%'),0)::text AS "receivableChangeCents"`;
      const summary = (
        await connection.query(
          `SELECT t.currency,${metrics} FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id WHERE ${range} GROUP BY t.currency ORDER BY t.currency`,
          values,
        )
      ).rows;
      const timeline = (
        await connection.query(
          `SELECT t.currency,to_char(date_trunc($5,t.created_at AT TIME ZONE $4),'YYYY-MM-DD') AS period,${metrics} FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id WHERE ${range} GROUP BY t.currency,period ORDER BY t.currency,period`,
          [...values, input.bucket],
        )
      ).rows;
      const newCustomers = (
        await connection.query(
          "SELECT to_char(date_trunc($3,u.created_at AT TIME ZONE $4),'YYYY-MM-DD') AS period,count(*)::int AS count FROM users u WHERE u.role='customer' AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=u.id) AND u.created_at>=($1::date::timestamp AT TIME ZONE $4) AND u.created_at<(($2::date+1)::timestamp AT TIME ZONE $4) GROUP BY period ORDER BY period",
          [input.from, input.to, input.bucket, input.timezone],
        )
      ).rows;
      const customers = (
        await connection.query(
          `${businessPayments}, ranked AS (SELECT b.currency,b.user_id AS id,u.name,u.email,count(*)::int AS "invoiceCount",sum(b.amount_cents)::text AS "grossCents",sum(b.refunded_cents)::text AS "refundedCents",sum(b.amount_cents-b.refunded_cents)::text AS "netCents",row_number() OVER(PARTITION BY b.currency ORDER BY sum(b.amount_cents-b.refunded_cents) DESC,b.user_id) AS rank FROM business b JOIN users u ON u.id=b.user_id WHERE ${businessRange} GROUP BY b.currency,b.user_id,u.name,u.email) SELECT * FROM ranked WHERE rank<=20 ORDER BY currency,rank`,
          values,
        )
      ).rows;
      const products = (
        await connection.query(
          `${businessPayments}, lines AS (SELECT b.*,item.product_id,item.product_name,item.amount_cents AS line_cents,COALESCE(sum(item.amount_cents) OVER(PARTITION BY b.id ORDER BY item.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS before_cents FROM business b JOIN order_items item ON item.order_id=b.order_id WHERE ${businessRange}), ranked AS (SELECT currency,product_id AS id,max(product_name) AS name,count(*)::int AS "lineCount",sum(line_cents)::text AS "grossCents",sum(LEAST(line_cents,GREATEST(refunded_cents-before_cents,0)))::text AS "refundedCents",sum(line_cents-LEAST(line_cents,GREATEST(refunded_cents-before_cents,0)))::text AS "netCents",row_number() OVER(PARTITION BY currency ORDER BY sum(line_cents-LEAST(line_cents,GREATEST(refunded_cents-before_cents,0))) DESC,product_id) AS rank FROM lines GROUP BY currency,product_id) SELECT * FROM ranked WHERE rank<=50 ORDER BY currency,rank`,
          values,
        )
      ).rows;
      return {
        filters: input,
        summary,
        timeline,
        newCustomers,
        customers,
        products,
      };
    });
  }
  @Get('operations') async operations(@Query() query: unknown) {
    const input = read(filters, query),
      values = [input.from, input.to, input.bucket, input.timezone];
    const range =
        'created_at>=($1::date::timestamp AT TIME ZONE $3) AND created_at<(($2::date+1)::timestamp AT TIME ZONE $3)',
      compact = [input.from, input.to, input.timezone];
    const [states, trend, recent] = await Promise.all([
      pool.query(
        `SELECT state,action,provider,count(*)::int AS count,max(attempts)::int AS "maxAttempts" FROM jobs WHERE ${range} GROUP BY state,action,provider ORDER BY state,action,provider`,
        compact,
      ),
      pool.query(
        `SELECT to_char(date_trunc($4,created_at AT TIME ZONE $3),'YYYY-MM-DD') AS period,state,count(*)::int AS count FROM jobs WHERE ${range} GROUP BY period,state ORDER BY period,state`,
        [...compact, input.bucket],
      ),
      pool.query(
        `SELECT id,service_id AS "serviceId",action,provider,state,attempts,last_error AS "lastError",created_at AS "createdAt",updated_at AS "updatedAt" FROM jobs WHERE ${range} ORDER BY created_at DESC,id LIMIT 100`,
        compact,
      ),
    ]);
    return {
      filters: input,
      states: states.rows,
      trend: trend.rows,
      recent: recent.rows,
    };
  }
}
