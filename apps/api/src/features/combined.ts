/* 合并账单：把本人尚未发起付款的业务账单合为一笔真实支付，保留原始订单价格。
 * 调用：GET /combined-invoices/eligible；POST /combined-invoices {invoiceIds} + Idempotency-Key。
 * 父单收款只记一次收入，结清与开通每张子单均与父单收款同事务。
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Headers,
  Req,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, transaction } from "./store.js";
import { record } from "./audit.js";
import { fulfill } from "./settlement.js";
import { captureCommission } from "./affiliate.js";
import { captureSales } from "./sales.js";
import { read, uuid } from "../utils/input.js";
import type { SessionRequest } from "../utils/access.js";

/** 在持有目标账单/订单锁后调用，合并中和已由父单结清的子单都不能另行付款或取消。 */
export async function assertInvoiceUncombined(
  connection: PoolClient,
  invoiceId: string,
) {
  const found = await connection.query(
    "SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=$1 AND locked",
    [invoiceId],
  );
  if (found.rowCount)
    throw new ConflictException(
      `这张账单已合并，请打开合并父账单处理（${found.rows[0].parent_invoice_id}）`,
    );
}
async function lockChildren(connection: PoolClient, parent: string) {
  const rows = (
    await connection.query(
      "SELECT i.id,i.order_id FROM combined_invoice_items x JOIN invoices i ON i.id=x.invoice_id WHERE x.parent_invoice_id=$1 ORDER BY i.id",
      [parent],
    )
  ).rows;
  await connection.query(
    "SELECT id FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [rows.map((item) => item.order_id)],
  );
  return (
    await connection.query(
      "SELECT i.*,x.position FROM combined_invoice_items x JOIN invoices i ON i.id=x.invoice_id WHERE x.parent_invoice_id=$1 ORDER BY x.position FOR UPDATE OF i",
      [parent],
    )
  ).rows;
}
/** 父账单已实际入账后调用；返回false表示普通账单，true表示所有子单已在本事务处理。 */
export async function fulfillCombined(
  connection: PoolClient,
  invoice: { id: string; order_id: string },
  allowReview = true,
): Promise<boolean> {
  const found = await connection.query(
    "SELECT * FROM combined_invoices WHERE parent_invoice_id=$1 FOR UPDATE",
    [invoice.id],
  );
  if (!found.rowCount) return false;
  const group = found.rows[0];
  if (group.status === "paid") return true;
  if (group.status !== "pending")
    throw new ConflictException("此合并账单已取消，请核对原付款");
  const children = await lockChildren(connection, invoice.id);
  await connection.query(
    `SELECT s.id FROM services s WHERE s.order_id=ANY($1::uuid[]) OR s.id IN(SELECT service_id FROM renewals WHERE order_id=ANY($1::uuid[]) UNION SELECT service_id FROM service_upgrades WHERE order_id=ANY($1::uuid[])) ORDER BY s.id FOR UPDATE`,
    [children.map((item) => item.order_id)],
  ); // 所有资源锁必须先于首条审计，和开通进程保持相同锁序
  if (children.some((item) => item.status !== "unpaid"))
    throw new ConflictException("合并子账单状态已变化，请联系服务商核对");
  await connection.query(
    "UPDATE combined_invoices SET status='paid' WHERE parent_invoice_id=$1",
    [invoice.id],
  );
  for (const child of children) {
    await connection.query(
      "UPDATE invoices SET status='paid',paid_at=(SELECT paid_at FROM invoices WHERE id=$2) WHERE id=$1",
      [child.id, invoice.id],
    );
    await connection.query("UPDATE orders SET status='paid' WHERE id=$1", [
      child.order_id,
    ]);
    await fulfill(connection, child, allowReview);
    await captureCommission(connection, child.id);
    await captureSales(connection, child.id);
    await record(
      connection,
      "combined:settlement",
      "combined.child.paid",
      child.id,
      { parentInvoiceId: invoice.id, amountCents: child.amount_cents },
    );
  }
  return true;
}
/** 未生成二维码或付款链接的父单可取消并释放子单；旧付款意图不会与重新单付并行。 */
export async function cancelCombined(
  connection: PoolClient,
  invoice: { id: string; order_id: string },
): Promise<boolean> {
  const found = await connection.query(
    "SELECT * FROM combined_invoices WHERE parent_invoice_id=$1 FOR UPDATE",
    [invoice.id],
  );
  if (!found.rowCount) return false;
  if (found.rows[0].status === "cancelled") return true;
  if (found.rows[0].status !== "pending")
    throw new ConflictException("已付款的合并账单不能取消");
  if (
    (
      await connection.query(
        "SELECT 1 FROM payment_attempts WHERE invoice_id=$1",
        [invoice.id],
      )
    ).rowCount
  )
    throw new ConflictException(
      "此合并账单已发起付款，请等待结果或联系客服核对",
    );
  await lockChildren(connection, invoice.id);
  await connection.query(
    "UPDATE combined_invoices SET status='cancelled' WHERE parent_invoice_id=$1",
    [invoice.id],
  );
  await connection.query(
    "UPDATE combined_invoice_items SET locked=false WHERE parent_invoice_id=$1",
    [invoice.id],
  );
  await connection.query(
    "UPDATE invoices SET status='cancelled' WHERE id=$1 AND status='unpaid'",
    [invoice.id],
  );
  await connection.query(
    "UPDATE orders SET status='cancelled' WHERE id=$1 AND status='unpaid'",
    [invoice.order_id],
  );
  return true;
}

@Controller("combined-invoices")
export default class Combined {
  @Get("eligible") async eligible(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `SELECT i.id,i.number::text,i.order_id AS "orderId",i.amount_cents::text AS "amountCents",i.currency,(SELECT decimals FROM currencies WHERE code=i.currency) AS "currencyDecimals",i.due_at AS "dueAt",o.kind,COALESCE(p.name,'业务账单') AS "productName" FROM invoices i JOIN orders o ON o.id=i.order_id LEFT JOIN products p ON p.id=o.product_id
      WHERE i.user_id=$1 AND i.status='unpaid' AND o.status='unpaid' AND o.kind IN('new','renew','upgrade') AND i.amount_cents>0
      AND NOT EXISTS(SELECT 1 FROM combined_invoice_items WHERE invoice_id=i.id AND locked)
      AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE invoice_id=i.id)
      AND NOT EXISTS(SELECT 1 FROM credit_payments WHERE invoice_id=i.id)
      ORDER BY i.number LIMIT 200`,
        [request.user.id],
      )
    ).rows;
  }
  @Get() async list(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `SELECT g.parent_invoice_id AS id,i.number::text,g.amount_cents::text AS "amountCents",g.currency,(SELECT decimals FROM currencies WHERE code=g.currency) AS "currencyDecimals",g.status,g.created_at AS "createdAt",(SELECT count(*)::int FROM combined_invoice_items WHERE parent_invoice_id=g.parent_invoice_id) AS "itemCount",NOT EXISTS(SELECT 1 FROM payment_attempts WHERE invoice_id=i.id) AND g.status='pending' AS cancellable FROM combined_invoices g JOIN invoices i ON i.id=g.parent_invoice_id WHERE g.user_id=$1 ORDER BY g.created_at DESC LIMIT 100`,
        [request.user.id],
      )
    ).rows;
  }
  @Post() async create(
    @Body() body: unknown,
    @Headers("idempotency-key") token: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
        z.object({ invoiceIds: z.array(uuid).min(2).max(50) }).strict(),
        body,
      ),
      ids = [...new Set(input.invoiceIds)].sort(),
      key = read(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), token);
    if (ids.length < 2) throw new ConflictException("至少选择两张不同的账单");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(ids))
      .digest("hex");
    return transaction(async (connection) => {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${request.user.id}:${key}`],
      );
      const prior = (
        await connection.query(
          'SELECT o.id,i.id AS "invoiceId",o.kind,o.request_hash,o.amount_cents::text AS "amountCents",o.currency FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.idempotency_key=$2',
          [request.user.id, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.kind !== "combined" || prior.request_hash !== fingerprint)
          throw new ConflictException("此提交标识已用于另一份订单");
        return {
          id: prior.id,
          invoiceId: prior.invoiceId,
          amountCents: prior.amountCents,
          currency: prior.currency,
        };
      }
      const initial = (
        await connection.query(
          "SELECT id,order_id FROM invoices WHERE id=ANY($1::uuid[]) AND user_id=$2",
          [ids, request.user.id],
        )
      ).rows;
      if (initial.length !== ids.length)
        throw new NotFoundException("所选账单不存在或不属于当前账号");
      await connection.query(
        "SELECT id FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [initial.map((item) => item.order_id)],
      );
      const children = (
        await connection.query(
          "SELECT i.*,o.kind,o.status AS order_status FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=ANY($1::uuid[]) ORDER BY i.number FOR UPDATE OF i",
          [ids],
        )
      ).rows;
      const currency = children[0].currency; // 父单保留原合同币种，不做隐式换汇
      for (const child of children) {
        await assertInvoiceUncombined(connection, child.id);
        if (
          child.status !== "unpaid" ||
          child.order_status !== "unpaid" ||
          !["new", "renew", "upgrade"].includes(child.kind) ||
          BigInt(child.amount_cents) <= 0n ||
          child.currency !== currency
        )
          throw new ConflictException("只能合并本人同币种、尚未付款的业务账单");
        if (
          (
            await connection.query(
              "SELECT 1 FROM payment_attempts WHERE invoice_id=$1 UNION ALL SELECT 1 FROM payment_receipts WHERE invoice_id=$1 UNION ALL SELECT 1 FROM wallet_payments WHERE invoice_id=$1 UNION ALL SELECT 1 FROM credit_payments WHERE invoice_id=$1",
              [child.id],
            )
          ).rowCount
        )
          throw new ConflictException("所选账单已发起付款，请先核对付款结果");
      }
      const total = children.reduce(
        (sum, child) => sum + BigInt(child.amount_cents),
        0n,
      );
      if (total > 999999999999n)
        throw new ConflictException("合并金额超过单笔支持范围");
      const order = (
        await connection.query(
          "INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,currency,kind,items_explicit) VALUES($1,NULL,$2,$3,$4,$5,'combined',true) RETURNING id",
          [request.user.id, key, fingerprint, total.toString(), currency],
        )
      ).rows[0];
      await connection.query(
        "INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,billing_months,original_unit_price_cents) VALUES($1,NULL,$2,1,'onetime',$3,$3,0,$3)",
        [order.id, `合并支付（${children.length}张账单）`, total.toString()],
      );
      const parent = (
        await connection.query(
          "INSERT INTO invoices(order_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4) RETURNING id",
          [order.id, request.user.id, total.toString(), currency],
        )
      ).rows[0];
      await connection.query(
        "INSERT INTO combined_invoices(parent_invoice_id,user_id,amount_cents,currency) VALUES($1,$2,$3,$4)",
        [parent.id, request.user.id, total.toString(), currency],
      );
      for (const [index, child] of children.entries())
        await connection.query(
          "INSERT INTO combined_invoice_items(parent_invoice_id,invoice_id,amount_cents,position) VALUES($1,$2,$3,$4)",
          [parent.id, child.id, child.amount_cents, index + 1],
        );
      await record(
        connection,
        request.actorId ?? request.user.id,
        "combined.create",
        parent.id,
        {
          invoiceIds: children.map((item) => item.id),
          amountCents: total.toString(),
          currency,
        },
      );
      return {
        id: order.id,
        invoiceId: parent.id,
        amountCents: total.toString(),
        currency,
      };
    });
  }
  @Post(":id/cancel") async cancel(
    @Param("id") id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    return transaction(async (connection) => {
      const target = (
        await connection.query(
          "SELECT order_id FROM invoices WHERE id=$1 AND user_id=$2",
          [id, request.user.id],
        )
      ).rows[0];
      if (!target) throw new NotFoundException("合并账单不存在");
      await connection.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE", [
        target.order_id,
      ]);
      await connection.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      if (
        !(await cancelCombined(connection, { id, order_id: target.order_id }))
      )
        throw new NotFoundException("合并账单不存在");
      await record(
        connection,
        request.actorId ?? request.user.id,
        "combined.cancel",
        id,
        {},
      );
      return { ok: true };
    });
  }
}
