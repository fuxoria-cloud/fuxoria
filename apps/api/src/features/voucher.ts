/* 开票：客户保存抬头并按真实已付账单申请，管理员记录实际开票结果。
 * 调用：/tax-profiles；POST /tax-requests {profileId,invoiceIds,note} + Idempotency-Key。
 * 处理：POST /admin/tax-requests/:id/process {action,reason?,invoiceNumber?,documentUrl?,password,totp?}。
 * 本模块记录实际票号与外部交付地址，不把申请凭证当成税务机关发票。
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Headers,
  Param,
  Req,
  Res,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Response } from "express";
import type { PoolClient } from "pg";
import { pool, transaction } from "./store.js";
import { record } from "./audit.js";
import { factorFields, verifyIdentity } from "./security.js";
import { Roles, type SessionRequest } from "../utils/access.js";
import { read, uuid } from "../utils/input.js";
import { pdf } from "../utils/pdf.js";

const profile = z
  .object({
    title: z.string().trim().min(1).max(200),
    type: z.enum(["person", "company"]),
    taxNumber: z.string().trim().max(50).default(""),
    invoiceType: z.enum(["ordinary", "special"]),
    bank: z.string().trim().max(200).default(""),
    bankAccount: z.string().trim().max(100).default(""),
    address: z.string().trim().max(500).default(""),
    phone: z.string().trim().max(40).default(""),
    email: z.email().max(254),
    shippingAddress: z.string().trim().max(1000).default(""),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "company" && !value.taxNumber)
      context.addIssue({ code: "custom", message: "企业抬头需要税号" });
    if (
      value.invoiceType === "special" &&
      (value.type !== "company" ||
        !value.bank ||
        !value.bankAccount ||
        !value.address ||
        !value.phone)
    )
      context.addIssue({
        code: "custom",
        message: "专用发票需要企业税号、银行账户、地址和电话",
      });
  });
const profileColumns =
  'id,title,type,tax_number AS "taxNumber",invoice_type AS "invoiceType",bank,bank_account AS "bankAccount",address,phone,email,shipping_address AS "shippingAddress"';
const columns = `v.id,v.number::text,v.profile,v.amount_cents::text AS "amountCents",v.currency,(SELECT decimals FROM currencies WHERE code=v.currency) AS "currencyDecimals",v.status,v.note,v.invoice_number AS "invoiceNumber",v.document_url AS "documentUrl",v.tracking_number AS "trackingNumber",v.decision_reason AS "decisionReason",v.issued_at AS "issuedAt",v.created_at AS "createdAt",(SELECT jsonb_build_object('invoiceNumber',red.invoice_number,'documentUrl',red.document_url,'reason',red.reason,'createdAt',red.created_at) FROM tax_red_documents red WHERE red.request_id=v.id) AS "redDocument"`;

/** @param connection 已锁定原账单的事务。@param invoiceId 原账单。@returns 没有未解决的开票占额，实际退款才可出站。 */
export async function assertTaxRefundable(
  connection: PoolClient,
  invoiceId: string,
) {
  const blocked = await connection.query(
    "SELECT 1 FROM tax_request_invoices l JOIN tax_requests v ON v.id=l.request_id LEFT JOIN tax_red_documents red ON red.request_id=v.id WHERE l.invoice_id=$1 AND (v.status IN ('pending','approved') OR (v.status='issued' AND red.id IS NULL)) LIMIT 1",
    [invoiceId],
  ); // 票据与退款共同占同一账单锁
  if (blocked.rowCount)
    throw new ConflictException(
      "请先撤回待开票申请，或由商户登记实际已开具的全额红字发票，再申请退款",
    ); // 不把资金退回与发票更正混成一件事
}

/** 在已锁定账单后核对净收款、在途退款和已用开票额度。 */
async function eligible(
  connection: PoolClient,
  ids: string[],
  userId: string,
  ignore?: string,
) {
  await connection.query(
    "SELECT id FROM invoices WHERE id=ANY($1::uuid[]) AND user_id=$2 ORDER BY id FOR UPDATE",
    [ids, userId],
  ); // 先等待竞争者提交，下一条语句再读取最新已占额度
  const found = await connection.query(
    `SELECT i.id,i.status,o.kind,i.currency,i.amount_cents::text,COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE p.invoice_id=i.id AND r.status='succeeded'),0)::text AS refunded,
 EXISTS(SELECT 1 FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE p.invoice_id=i.id AND r.status NOT IN('rejected','failed','succeeded')) AS refund_pending,
 EXISTS(SELECT 1 FROM combined_invoice_items WHERE invoice_id=i.id AND locked) OR EXISTS(SELECT 1 FROM tax_request_invoices l JOIN tax_requests v ON v.id=l.request_id WHERE l.invoice_id=i.id AND v.status NOT IN('rejected','cancelled') AND NOT EXISTS(SELECT 1 FROM tax_red_documents red WHERE red.request_id=v.id) AND ($3::uuid IS NULL OR v.id<>$3)) AS used
 FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.id=ANY($1::uuid[]) AND i.user_id=$2 ORDER BY i.id`,
    [ids, userId, ignore ?? null],
  );
  if (found.rowCount !== ids.length)
    throw new NotFoundException("所选账单不存在或不属于当前账号");
  for (const row of found.rows)
    if (
      row.status !== "paid" ||
      !["new", "renew", "upgrade", "combined"].includes(row.kind) ||
      row.refund_pending ||
      row.used ||
      BigInt(row.amount_cents) <= BigInt(row.refunded)
    )
      throw new ConflictException(
        "所选账单未付款、正在退款、已开票或没有可开票金额",
      );
  return found.rows.map((row) => ({
    id: row.id,
    currency: row.currency,
    amountCents: (BigInt(row.amount_cents) - BigInt(row.refunded)).toString(),
  }));
}

@Controller()
export default class Voucher {
  @Get("tax-profiles") async profiles(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `SELECT ${profileColumns} FROM tax_profiles WHERE user_id=$1 ORDER BY created_at DESC`,
        [request.user.id],
      )
    ).rows;
  }
  @Post("tax-profiles") async createProfile(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    const p = read(profile, body);
    return transaction(async (connection) => {
      const saved = (
        await connection.query(
          `INSERT INTO tax_profiles(user_id,title,type,tax_number,invoice_type,bank,bank_account,address,phone,email,shipping_address) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${profileColumns}`,
          [
            request.user.id,
            p.title,
            p.type,
            p.taxNumber,
            p.invoiceType,
            p.bank,
            p.bankAccount,
            p.address,
            p.phone,
            p.email,
            p.shippingAddress,
          ],
        )
      ).rows[0];
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.profile.create",
        saved.id,
        { type: p.type },
      );
      return saved;
    });
  }
  @Put("tax-profiles/:id") async updateProfile(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const p = read(profile, body);
    return transaction(async (connection) => {
      const saved = await connection.query(
        `UPDATE tax_profiles SET title=$3,type=$4,tax_number=$5,invoice_type=$6,bank=$7,bank_account=$8,address=$9,phone=$10,email=$11,shipping_address=$12 WHERE id=$1 AND user_id=$2 RETURNING ${profileColumns}`,
        [
          id,
          request.user.id,
          p.title,
          p.type,
          p.taxNumber,
          p.invoiceType,
          p.bank,
          p.bankAccount,
          p.address,
          p.phone,
          p.email,
          p.shippingAddress,
        ],
      );
      if (!saved.rowCount) throw new NotFoundException("发票抬头不存在");
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.profile.update",
        id,
        {},
      );
      return saved.rows[0];
    });
  }
  @Delete("tax-profiles/:id") async deleteProfile(
    @Param("id") id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    return transaction(async (connection) => {
      const saved = await connection.query(
        "DELETE FROM tax_profiles WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, request.user.id],
      );
      if (!saved.rowCount) throw new NotFoundException("发票抬头不存在");
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.profile.delete",
        id,
        {},
      );
      return { ok: true };
    });
  }
  @Get("tax-eligible-invoices") async invoices(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `WITH eligible AS (
   SELECT i.id,i.number::text,i.currency,i.paid_at AS "paidAt",i.amount_cents-COALESCE((SELECT sum(r.amount_cents) FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE p.invoice_id=i.id AND r.status='succeeded'),0) AS net
   FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.user_id=$1 AND i.status='paid' AND o.kind IN ('new','renew','upgrade','combined')
    AND NOT EXISTS(SELECT 1 FROM combined_invoice_items WHERE invoice_id=i.id AND locked)
    AND NOT EXISTS(SELECT 1 FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id WHERE p.invoice_id=i.id AND r.status NOT IN('rejected','failed','succeeded'))
    AND NOT EXISTS(SELECT 1 FROM tax_request_invoices l JOIN tax_requests v ON v.id=l.request_id WHERE l.invoice_id=i.id AND v.status NOT IN('rejected','cancelled') AND NOT EXISTS(SELECT 1 FROM tax_red_documents red WHERE red.request_id=v.id))
  ) SELECT id,number,currency,(SELECT decimals FROM currencies WHERE code=eligible.currency) AS "currencyDecimals","paidAt",net::text AS "amountCents" FROM eligible WHERE net>0 ORDER BY "paidAt" DESC LIMIT 200`,
        [request.user.id],
      )
    ).rows; // 展示金额与提交边界都使用实际净收款
  }
  @Get("tax-requests") async list(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `SELECT ${columns} FROM tax_requests v WHERE v.user_id=$1 ORDER BY v.created_at DESC LIMIT 200`,
        [request.user.id],
      )
    ).rows;
  }
  @Roles("admin") @Get("admin/tax-requests") async all() {
    return (
      await pool.query(
        `SELECT ${columns},u.email FROM tax_requests v JOIN users u ON u.id=v.user_id ORDER BY v.created_at DESC LIMIT 200`,
      )
    ).rows;
  }
  @Post("tax-requests") async create(
    @Body() body: unknown,
    @Headers("idempotency-key") token: unknown,
    @Req() request: SessionRequest,
  ) {
    const input = read(
      z
        .object({
          profileId: uuid,
          invoiceIds: z.array(uuid).min(1).max(100),
          note: z.string().trim().max(1000).default(""),
        })
        .strict(),
      body,
    );
    read(z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), token);
    const ids = [...new Set(input.invoiceIds)].sort();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...input, invoiceIds: ids }))
      .digest("hex");
    return transaction(async (connection) => {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`tax:${request.user.id}:${token}`],
      );
      const prior = (
        await connection.query(
          "SELECT id,request_hash FROM tax_requests WHERE user_id=$1 AND idempotency_key=$2",
          [request.user.id, token],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new ConflictException("提交标识已用于另一份开票申请");
        return { id: prior.id };
      }
      const p = (
        await connection.query(
          `SELECT ${profileColumns} FROM tax_profiles WHERE id=$1 AND user_id=$2 FOR SHARE`,
          [input.profileId, request.user.id],
        )
      ).rows[0];
      if (!p) throw new NotFoundException("发票抬头不存在");
      const lines = await eligible(connection, ids, request.user.id);
      if (new Set(lines.map((line) => line.currency)).size !== 1)
        throw new ConflictException("不同币种的账单请分别申请开票"); // 不把不同货币直接求和
      const currency = lines[0]!.currency;
      const amount = lines.reduce(
        (sum, line) => sum + BigInt(line.amountCents),
        0n,
      );
      const saved = (
        await connection.query(
          "INSERT INTO tax_requests(user_id,profile,amount_cents,currency,note,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            request.user.id,
            p,
            amount.toString(),
            currency,
            input.note,
            token,
            fingerprint,
          ],
        )
      ).rows[0];
      for (const line of lines)
        await connection.query(
          "INSERT INTO tax_request_invoices(request_id,invoice_id,amount_cents) VALUES($1,$2,$3)",
          [saved.id, line.id, line.amountCents],
        );
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.request",
        saved.id,
        { invoiceIds: ids, amountCents: amount.toString() },
      );
      return saved;
    });
  }
  @Post("tax-requests/:id/cancel") async cancel(
    @Param("id") id: string,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    return transaction(async (connection) => {
      const found = await connection.query(
        "UPDATE tax_requests SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",
        [id, request.user.id],
      );
      if (!found.rowCount)
        throw new ConflictException("只能撤回待处理的本人申请");
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.cancel",
        id,
        {},
      );
      return { ok: true };
    });
  }
  @Roles("admin") @Post("admin/tax-requests/:id/process") async process(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({
          action: z.enum(["approve", "reject", "issue"]),
          reason: z.string().trim().max(1000).default(""),
          invoiceNumber: z.string().trim().max(100).optional(),
          documentUrl: z
            .url()
            .refine(
              (value) => new URL(value).protocol === "https:",
              "票据交付链接需要HTTPS",
            )
            .optional(),
          trackingNumber: z.string().trim().max(100).optional(),
          password: z.string().min(1).max(128),
          ...factorFields,
        })
        .strict(),
      body,
    );
    if (input.action === "reject" && !input.reason)
      throw new ConflictException("驳回需要说明原因");
    if (input.action === "issue" && !input.invoiceNumber)
      throw new ConflictException("请填写实际已开具的发票号码");
    await verifyIdentity(request, input, "tax.process", "admin");
    return transaction(async (connection) => {
      const targets = (
        await connection.query(
          "SELECT invoice_id FROM tax_request_invoices WHERE request_id=$1 ORDER BY invoice_id",
          [id],
        )
      ).rows.map((line) => line.invoice_id);
      await connection.query(
        "SELECT id FROM invoices WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [targets],
      ); // 和退款/红冲保持账单→申请锁顺序
      const row = (
        await connection.query(
          "SELECT * FROM tax_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("开票申请不存在");
      if (!["pending", "approved"].includes(row.status))
        throw new ConflictException("此申请已处理，请刷新记录");
      if (input.action !== "reject") {
        const ids = (
          await connection.query(
            "SELECT invoice_id FROM tax_request_invoices WHERE request_id=$1 ORDER BY invoice_id",
            [id],
          )
        ).rows.map((line) => line.invoice_id);
        const lines = await eligible(connection, ids, row.user_id, id);
        if (lines.some((line) => line.currency !== row.currency))
          throw new ConflictException("账单币种与原开票申请不一致");
        if (
          lines.reduce((sum, line) => sum + BigInt(line.amountCents), 0n) !==
          BigInt(row.amount_cents)
        )
          throw new ConflictException(
            "退款改变了可开票金额，请驳回后按实际金额重新申请",
          );
      }
      const status =
        input.action === "approve"
          ? "approved"
          : input.action === "reject"
            ? "rejected"
            : "issued";
      await connection.query(
        "UPDATE tax_requests SET status=$2,decision_reason=$3,invoice_number=$4,document_url=$5,tracking_number=$6,handled_by=$7,issued_at=CASE WHEN $2='issued' THEN now() ELSE NULL END WHERE id=$1",
        [
          id,
          status,
          input.reason,
          input.invoiceNumber ?? null,
          input.documentUrl ?? null,
          input.trackingNumber ?? null,
          request.user.id,
        ],
      );
      await record(
        connection,
        request.actorId ?? request.user.id,
        `tax.${input.action}`,
        id,
        { invoiceNumber: input.invoiceNumber, status },
      );
      return { ok: true, status };
    });
  }
  /** @returns 保存的全额红字发票登记，原发票记录保持只读。 */
  @Roles("admin") @Post("admin/tax-requests/:id/red-letter") async redLetter(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ) {
    read(uuid, id);
    const input = read(
      z
        .object({
          invoiceNumber: z.string().trim().min(1).max(100),
          documentUrl: z
            .url()
            .refine(
              (value) => new URL(value).protocol === "https:",
              "票据交付链接需要HTTPS",
            )
            .optional(),
          reason: z.string().trim().min(1).max(1000),
          password: z.string().min(1).max(128),
          ...factorFields,
        })
        .strict(),
      body,
    ); // 这里只记录商户已开具事实，不生成或代开发票
    await verifyIdentity(request, input, "tax.red_letter", "admin");
    return transaction(async (connection) => {
      const invoiceIds = (
        await connection.query(
          "SELECT invoice_id FROM tax_request_invoices WHERE request_id=$1 ORDER BY invoice_id",
          [id],
        )
      ).rows.map((row) => row.invoice_id); // 和退款保持账单锁在前
      await connection.query(
        "SELECT id FROM invoices WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [invoiceIds],
      );
      const original = (
        await connection.query(
          "SELECT * FROM tax_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!original) throw new NotFoundException("开票申请不存在");
      if (original.status !== "issued")
        throw new ConflictException("只能登记已开具发票的红冲事实"); // 不让待开票记录变成虚构红字发票
      const prior = (
        await connection.query(
          "SELECT invoice_number,document_url,reason FROM tax_red_documents WHERE request_id=$1",
          [id],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.invoice_number !== input.invoiceNumber ||
          prior.document_url !== (input.documentUrl ?? null) ||
          prior.reason !== input.reason
        )
          throw new ConflictException("此发票已登记红冲，请核对已有记录");
        return { ok: true };
      } // 网络重试不增加第二份更正
      const saved = (
        await connection.query(
          "INSERT INTO tax_red_documents(request_id,invoice_number,document_url,reason,recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            id,
            input.invoiceNumber,
            input.documentUrl ?? null,
            input.reason,
            request.user.id,
          ],
        )
      ).rows[0];
      await record(
        connection,
        request.actorId ?? request.user.id,
        "tax.red_letter",
        id,
        {
          redDocumentId: saved.id,
          invoiceNumber: input.invoiceNumber,
          amountCents: original.amount_cents,
          currency: original.currency,
          reason: input.reason,
        },
      );
      return { ok: true }; // 原票号、金额、抬头不重写
    });
  }
  @Get("tax-requests/:id/document") async document(
    @Param("id") id: string,
    @Req() request: SessionRequest,
    @Res() response: Response,
  ) {
    const row = (
      await pool.query(
        `SELECT ${columns} FROM tax_requests v WHERE v.id=$1 AND (v.user_id=$2 OR $3='admin')`,
        [read(uuid, id), request.user.id, request.user.role],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("开票申请不存在");
    const definition = (
      await pool.query("SELECT symbol,decimals FROM currencies WHERE code=$1", [
        row.currency,
      ])
    ).rows[0];
    if (!definition)
      throw new ConflictException("票据币种定义不存在，请联系商户核对"); // 文档与账单使用同一货币精度
    const units = BigInt(row.amountCents),
      scale = 10n ** BigInt(definition.decimals),
      printedAmount = `${row.currency} ${definition.symbol}${units / scale}${definition.decimals ? "." + (units % scale).toString().padStart(definition.decimals, "0") : ""}`; // PDF同样不经过浮点运算
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="tax-request-${row.number}.pdf"`,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response
      .type("application/pdf")
      .send(
        pdf("开票申请记录", [
          `申请编号：${row.number}`,
          `抬头：${row.profile.title}`,
          `税号：${row.profile.taxNumber}`,
          `金额：${printedAmount}`,
          `状态：${row.status}`,
          `实际发票号码：${row.invoiceNumber ?? "尚未开具"}`,
          `交付地址：${row.documentUrl ?? "—"}`,
          `寄送单号：${row.trackingNumber ?? "—"}`,
          row.decisionReason ?? "",
          ...(row.redDocument
            ? [
                `原发票已全额红冲，红字票号：${row.redDocument.invoiceNumber}`,
                `红冲登记时间：${row.redDocument.createdAt}`,
                `更正说明：${row.redDocument.reason}`,
                `红字票据地址：${row.redDocument.documentUrl ?? "—"}`,
              ]
            : []),
        ]),
      );
  }
}
