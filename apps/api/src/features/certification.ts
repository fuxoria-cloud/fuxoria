/* 实名：个人/企业申请保留历史，证件与私有材料加密；人工审核明确记录凭据与结论。
 * 调用：POST /certifications；GET /certifications；管理 /admin/certifications。
 * 对照：3.7.6 CertificationController personCertifiPost/companyCertifiPost/personToCompany。
 */
import { Body, Controller, Get, Post, Param, Req, Res, Query, ConflictException, NotFoundException, BadRequestException, ForbiddenException, PayloadTooLargeException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Response, Request } from "express";
import { z } from "zod";
import { pool, transaction } from "./store.js";
import { record } from "./audit.js";
import { factorFields, verifyIdentity } from "./security.js";
import { Roles, interactive, type SessionRequest } from "../utils/access.js";
import { read, uuid } from "../utils/input.js";
const proof = z.object({
  password: z.string().min(1).max(128),
  ...factorFields
}).strict();
const application = z.object({
  kind: z.enum(["personal", "enterprise"]),
  name: z.string().trim().min(2).max(120),
  documentType: z.enum(["identity", "passport", "other"]).default("identity"),
  documentNumber: z.string().trim().min(3).max(80),
  country: z.string().regex(/^[A-Z]{2}$/).default("CN"),
  company: z.string().trim().max(200).default(""),
  registrationNumber: z.string().trim().max(80).default(""),
  method: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).default("manual"),
  ...proof.shape
}).strict().refine(value => value.kind !== "enterprise" || value.company.length >= 2 && value.registrationNumber.length >= 3, "企业认证请填写企业名称与登记号码");
const columns = "c.id,c.user_id AS \"userId\",c.kind,c.method,c.status,c.masked_name AS \"maskedName\",c.masked_document AS \"maskedDocument\",c.previous_id AS \"previousId\",c.decision_reason AS \"decisionReason\",c.review_reference AS \"reviewReference\",c.decided_at AS \"decidedAt\",c.created_at AS \"createdAt\"";
type ManualChannel = {
  id: string;
  name: string;
  kinds: string[];
  mode: "manual";
};
/** 文件即核验渠道；随包的manual只产生人工待审事实。 */
async function channels() {
  const directory = fileURLToPath(new URL("../verification-plugins/", import.meta.url)),
    found: ManualChannel[] = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!/\.(ts|js)$/.test(file) || file.endsWith(".d.ts")) continue;
    const plugin = (await import(pathToFileURL(join(directory, file)).href)).default as ManualChannel;
    if (plugin?.mode === "manual" && plugin.id) found.push(plugin);
  }
  return found;
}
function key() {
  const value = process.env.CERTIFICATION_KEY;
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new ConflictException("实名认证申请暂未开放");
  return Buffer.from(value, "hex");
}
/** AES-GCM的附加认证数据绑定记录和用途，交换密文无法通过校验。 */
function encrypt(data: Buffer, scope: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
}
function decrypt(data: Buffer, scope: string) {
  const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(scope));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
}
function storage() {
  const directory = resolve(process.env.CERTIFICATION_STORAGE_DIR || join(homedir(), ".local/share/yunzou/certifications")),
    project = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  if (directory === project || directory.startsWith(project + sep)) throw new ConflictException("实名材料须保存在部署数据目录");
  return directory;
}
async function receive(request: Request) {
  if (!request.is("application/octet-stream")) throw new BadRequestException("材料请使用原始文件内容");
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > 5242880)) throw new PayloadTooLargeException("实名材料不能超过5MiB");
  return new Promise<Buffer>((resolve_, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      finished = false;
    const timer = setTimeout(() => finish(new BadRequestException("材料上传超时，请重新上传")), 15000);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("aborted", aborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve_(Buffer.concat(chunks, size));
    }
    function data(chunk: Buffer) {
      size += chunk.length;
      if (size > 5242880) return finish(new PayloadTooLargeException("实名材料不能超过5MiB"));
      chunks.push(chunk);
    }
    function end() {
      finish(size ? undefined : new BadRequestException("材料不能为空"));
    }
    function failed(error: Error) {
      finish(error);
    }
    function aborted() {
      finish(new BadRequestException("材料上传已中断"));
    }
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("aborted", aborted);
  });
}
function typeOf(data: Buffer) {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return {
    media: "image/png",
    suffix: "png"
  };
  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return {
    media: "image/jpeg",
    suffix: "jpg"
  };
  if (data.subarray(0, 5).toString() === "%PDF-") return {
    media: "application/pdf",
    suffix: "pdf"
  };
  throw new BadRequestException("实名材料请使用PNG、JPEG或PDF");
}
@Controller()
export default class Certification {
  @Get("certification-channels")
  async methods() {
    const configured = /^[a-fA-F0-9]{64}$/.test(process.env.CERTIFICATION_KEY ?? "");
    return {
      configured,
      channels: configured ? await channels() : []
    };
  }
  @Get("certifications")
  async list(@Req()
  request: SessionRequest) {
    interactive(request);
    return (await pool.query(`SELECT ${columns},(SELECT count(*)::int FROM certification_files f WHERE f.certification_id=c.id) AS "fileCount" FROM certifications c WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [request.user.id])).rows;
  }
  @Post("certifications")
  async submit(@Body()
  body: unknown, @Req()
  request: SessionRequest) {
    interactive(request);
    const input = read(application, body);
    key();
    if (!(await channels()).some(channel => channel.id === input.method && channel.kinds.includes(input.kind))) throw new BadRequestException("这个核验渠道不支持所选认证类型");
    await verifyIdentity(request, input, "certification.submit");
    const id = randomUUID(),
      details = {
        name: input.name,
        documentType: input.documentType,
        documentNumber: input.documentNumber,
        country: input.country,
        company: input.company,
        registrationNumber: input.registrationNumber
      };
    const identifier = input.kind === "enterprise" ? input.registrationNumber : input.documentNumber;
    const digest = createHmac("sha256", key()).update(input.kind + ":" + identifier.toUpperCase()).digest("hex");
    return transaction(async connection => {
      await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [request.user.id]);
      await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`certification:${digest}`]);
      const old = (await connection.query("SELECT * FROM certifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [request.user.id])).rows[0];
      if (old?.status === "pending") throw new ConflictException("已有资料正在审核，请先查看这次申请");
      if (old?.status === "approved" && old.kind === input.kind) throw new ConflictException("这个类型的认证已经通过，资料变更请联系支持");
      if ((await connection.query("SELECT 1 FROM certifications WHERE document_hash=$1 AND user_id<>$2 AND status IN('pending','approved')", [digest, request.user.id])).rowCount) throw new ConflictException("这份证件已有认证申请，请联系支持核对");
      const masked = (input.kind === "enterprise" ? input.company : input.name).slice(0, 1) + "**",
        maskedDocument = identifier.slice(0, 1) + "*".repeat(Math.min(16, Math.max(2, identifier.length - 2))) + identifier.slice(-1);
      await connection.query("INSERT INTO certifications(id,user_id,kind,method,encrypted_details,masked_name,masked_document,document_hash,previous_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id, request.user.id, input.kind, input.method, encrypt(Buffer.from(JSON.stringify(details)), id + ":details").toString("base64"), masked, maskedDocument, digest, old?.id ?? null]);
      await record(connection, request.user.id, "certification.submit", id, {
        kind: input.kind,
        method: input.method,
        previousId: old?.id ?? null
      });
      return {
        id,
        status: "pending",
        verificationSource: "manual"
      };
    });
  }
  @Post("certifications/:id/files")
  async upload(@Param("id")
  id: string, @Req()
  request: SessionRequest) {
    interactive(request);
    read(uuid, id);
    const data = await receive(request),
      type = typeOf(data),
      fileId = randomUUID(),
      path = join(storage(), fileId + ".enc");
    let written = false;
    try {
      return await transaction(async connection => {
        const found = (await connection.query("SELECT status FROM certifications WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, request.user.id])).rows[0];
        if (!found) throw new NotFoundException("认证申请不存在");
        if (found.status !== "pending") throw new ConflictException("这次认证已结束，不能替换材料");
        if ((await connection.query("SELECT count(*)::int AS n FROM certification_files WHERE certification_id=$1", [id])).rows[0].n >= 6) throw new ConflictException("每次认证最多保存六份材料");
        await mkdir(storage(), {
          recursive: true,
          mode: 448
        });
        await writeFile(path, encrypt(data, id + ":" + fileId), {
          flag: "wx",
          mode: 384
        });
        written = true;
        const saved = (await connection.query("INSERT INTO certification_files(id,certification_id,name,media_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,size_bytes AS \"sizeBytes\"", [fileId, id, "认证材料." + type.suffix, type.media, data.length, createHash("sha256").update(data).digest("hex")])).rows[0];
        await record(connection, request.user.id, "certification.file.upload", id, {
          fileId,
          sizeBytes: data.length
        });
        return saved;
      });
    } catch (error) {
      if (written) await rm(path, {
        force: true
      });
      throw error;
    }
  }
  @Post("certifications/:id/withdraw")
  async withdraw(@Param("id")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest) {
    interactive(request);
    read(uuid, id);
    const input = read(proof, body);
    await verifyIdentity(request, input, "certification.withdraw");
    return transaction(async connection => {
      const changed = await connection.query("UPDATE certifications SET status='withdrawn' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id", [id, request.user.id]);
      if (!changed.rowCount) throw new ConflictException("只能撤回自己的待审申请");
      await record(connection, request.user.id, "certification.withdraw", id, {});
      return {
        ok: true
      };
    });
  }
  @Roles("admin")
  @Get("admin/certifications")
  async admin(@Query("status")
  status: unknown) {
    const state = read(z.enum(["pending", "approved", "rejected", "withdrawn", "all"]).default("pending"), status);
    return (await pool.query(`SELECT ${columns},u.email,(SELECT count(*)::int FROM certification_files f WHERE f.certification_id=c.id) AS "fileCount" FROM certifications c JOIN users u ON u.id=c.user_id WHERE ($1='all' OR c.status=$1) ORDER BY c.created_at DESC,c.id LIMIT 200`, [state])).rows;
  }
  @Roles("admin")
  @Post("admin/certifications/:id/reveal")
  async reveal(@Param("id")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest) {
    read(uuid, id);
    const input = read(proof.extend({
      reason: z.string().trim().min(3).max(500)
    }), body);
    await verifyIdentity(request, input, "certification.reveal", "admin");
    return transaction(async connection => {
      const found = (await connection.query("SELECT * FROM certifications WHERE id=$1", [id])).rows[0];
      if (!found) throw new NotFoundException("认证申请不存在");
      const details = JSON.parse(decrypt(Buffer.from(found.encrypted_details, "base64"), id + ":details").toString());
      const files = (await connection.query("SELECT id,name,media_type AS \"mediaType\",size_bytes AS \"sizeBytes\" FROM certification_files WHERE certification_id=$1 ORDER BY created_at,id", [id])).rows;
      await record(connection, request.user.id, "certification.reveal", id, {
        reason: input.reason
      });
      return {
        details,
        files,
        verificationSource: "manual"
      };
    });
  }
  @Roles("admin")
  @Post("admin/certifications/:id/files/:fileId/open")
  async material(@Param("id")
  id: string, @Param("fileId")
  fileId: string, @Body()
  body: unknown, @Req()
  request: SessionRequest, @Res()
  response: Response) {
    read(uuid, id);
    read(uuid, fileId);
    const input = read(proof.extend({
      reason: z.string().trim().min(3).max(500)
    }), body);
    await verifyIdentity(request, input, "certification.material", "admin");
    const file = (await pool.query("SELECT * FROM certification_files WHERE id=$1 AND certification_id=$2", [fileId, id])).rows[0];
    if (!file) throw new NotFoundException("实名材料不存在");
    let data: Buffer;
    try {
      data = decrypt(await readFile(join(storage(), fileId + ".enc")), id + ":" + fileId);
    } catch {
      throw new ConflictException("材料完整性核对失败，请重新核对部署存储");
    }
    if (data.length !== file.size_bytes || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new ConflictException("材料完整性核对失败，请重新核对部署存储");
    await transaction(connection => record(connection, request.user.id, "certification.material.read", id, {
      fileId,
      reason: input.reason
    }));
    response.setHeader("Content-Type", file.media_type);
    response.setHeader("Content-Disposition", `attachment; filename="evidence-${fileId}.${file.media_type === "application/pdf" ? "pdf" : file.media_type === "image/png" ? "png" : "jpg"}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(data);
  }
  @Roles("admin")
  @Post("admin/certifications/:id/decision")
  async decide(@Param("id")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest) {
    read(uuid, id);
    const input = read(proof.extend({
      decision: z.enum(["approved", "rejected"]),
      reason: z.string().trim().min(3).max(2000),
      reviewReference: z.string().trim().min(3).max(200),
      reviewedEvidence: z.literal(true)
    }), body);
    await verifyIdentity(request, input, "certification.decide", "admin");
    return transaction(async connection => {
      const found = (await connection.query("SELECT * FROM certifications WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!found) throw new NotFoundException("认证申请不存在");
      if (found.status !== "pending") throw new ConflictException("这次申请已经有处理结论");
      if (input.decision === "approved" && !(await connection.query("SELECT 1 FROM certification_files WHERE certification_id=$1 LIMIT 1", [id])).rowCount) throw new ConflictException("通过审核前必须有实际核对的私有证明材料");
      await connection.query("UPDATE certifications SET status=$2,decision_reason=$3,review_reference=$4,decided_by=$5,decided_at=now() WHERE id=$1", [id, input.decision, input.reason, input.reviewReference, request.user.id]);
      await record(connection, request.user.id, "certification.decision", id, {
        decision: input.decision,
        verificationSource: "manual",
        reviewReference: input.reviewReference
      });
      return {
        ok: true,
        status: input.decision,
        verificationSource: "manual"
      };
    });
  }
}
