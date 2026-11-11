/* 批量续费：先保存客户命令，再逐项走Service.renew；结果逐项反馈，不把失败项目冒充成交。
 * 调用：POST /renewal-batches {items:[{serviceId,period}]} + Idempotency-Key；GET /renewal-batches/:id。
 * PostgreSQL租约负责重启恢复，子幂等键由批次ID与服务ID决定，免费续费重放也不再延长。
 */
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Headers,
  Req,
  HttpException,
  ConflictException,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common"; // 批量表单仍有可核对的持久结果
import { createHash, randomUUID } from "node:crypto"; // 稳定子键和独立任务追踪号
import { z } from "zod"; // 只接受自己的服务和服务端支持的周期
import { pool, transaction } from "./store.js"; // 命令与审计一并提交
import { record } from "./audit.js"; // 每项续费由原服务主体审计，本主体记录整批意图
import { periodSchema } from "./catalogue.js"; // 周期名不复制一份清单
import Service from "./service.js"; // 库存、价格与资源事实都来自原续费主线
import { interactive, type SessionRequest } from "../utils/access.js"; // 后台命令只由主账号本人创建
import { read, uuid } from "../utils/input.js"; // 入口整理UUID与正文

const columns =
  'id,status,items,results,created_at AS "createdAt",updated_at AS "updatedAt"'; // 租约令牌不进入浏览器

@Controller("renewal-batches")
export default class Batch implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false; // 进程内只跑一批，跨节点由数据库领取
  onModuleInit() {
    if (process.env.RUN_BATCHES === "false") return;
    this.timer = setInterval(
      () =>
        void this.run().catch((error) =>
          console.error(
            JSON.stringify({
              feature: "renewal-batch",
              error: error instanceof Error ? error.message : "批量续费失败",
            }),
          ),
        ),
      5000,
    );
    this.timer.unref();
  } // 数据库命令在进程重启后继续可领取
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  } // 不在停机后启动新批次
  @Get() async list(@Req() request: SessionRequest) {
    return (
      await pool.query(
        `SELECT ${columns} FROM renewal_batches WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [request.user.id],
      )
    ).rows;
  } // 历史只读
  @Get(":id") async get(
    @Param("id") id: string,
    @Req() request: SessionRequest,
  ) {
    const found = await pool.query(
      `SELECT ${columns} FROM renewal_batches WHERE id=$1 AND user_id=$2`,
      [read(uuid, id), request.user.id],
    );
    if (!found.rowCount) throw new NotFoundException("批次不存在");
    return found.rows[0];
  } // 不泄露其他账号的命令
  @Post() async create(
    @Body() body: unknown,
    @Headers("idempotency-key") key: unknown,
    @Req() request: SessionRequest,
  ) {
    interactive(request);
    const input = read(
      z
        .object({
          items: z
            .array(
              z
                .object({
                  serviceId: uuid.transform((value) => value.toLowerCase()),
                  period: periodSchema,
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict()
        .refine(
          (value) =>
            new Set(value.items.map((item) => item.serviceId)).size ===
            value.items.length,
          "同一服务只选择一次",
        ),
      body,
    );
    const token = read(z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), key); // 不让一次选中重复续期同一服务
    const items = [...input.items].sort((a, b) =>
        a.serviceId.localeCompare(b.serviceId),
      ),
      fingerprint = createHash("sha256")
        .update(JSON.stringify(items))
        .digest("hex"); // 选择顺序不改变提交含义
    return transaction(async (connection) => {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`renewal-batch:${request.user.id}:${token}`],
      ); // 相同提交只保存一份命令
      const old = (
        await connection.query(
          "SELECT id,request_hash,status FROM renewal_batches WHERE user_id=$1 AND idempotency_key=$2",
          [request.user.id, token],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== fingerprint)
          throw new ConflictException("此提交标识已用于其他服务选择");
        return { id: old.id, status: old.status };
      } // 不重复免费续费
      const user = (
        await connection.query(
          "SELECT session_version FROM users WHERE id=$1 AND NOT disabled FOR SHARE",
          [request.user.id],
        )
      ).rows[0];
      if (!user) throw new ConflictException("账号当前不可用"); // 退出全部会话和停用可撤销尚未执行的批次
      const owned = await connection.query(
        "SELECT id FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(current_owner_id,user_id)=$2",
        [items.map((item) => item.serviceId), request.user.id],
      );
      if (owned.rowCount !== items.length)
        throw new NotFoundException("所选服务不存在"); // 整批越权在保存前拒绝
      const saved = (
        await connection.query(
          "INSERT INTO renewal_batches(user_id,session_version,idempotency_key,request_hash,items) VALUES($1,$2,$3,$4,$5) RETURNING id,status",
          [
            request.user.id,
            user.session_version,
            token,
            fingerprint,
            JSON.stringify(items),
          ],
        )
      ).rows[0];
      await record(
        connection,
        request.actorId ?? request.user.id,
        "service.batch_requested",
        saved.id,
        { items },
      );
      return saved; // 不等待多个独立资源事务，避免连接池被等待者占满
    });
  }
  /** @returns 本轮领取的批次ID；测试可在真实数据库调用，不依赖时钟等待。 */
  async run(): Promise<string | null> {
    if (this.running) return null;
    this.running = true; // 上一轮未结束不重入
    let claimed:
      | {
          id: string;
          user_id: string;
          session_version: number;
          items: { serviceId: string; period: z.infer<typeof periodSchema> }[];
          lease_token: string;
        }
      | undefined;
    try {
      claimed = (
        await pool.query(
          "WITH next AS (SELECT id FROM renewal_batches WHERE status='pending' OR (status='running' AND lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE renewal_batches SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=(SELECT id FROM next) RETURNING *",
        )
      ).rows[0];
      if (!claimed) return null; // 已领取令牌约束后续状态提交
      const account = (
        await pool.query(
          "SELECT id,email,name,role,disabled,session_version FROM users WHERE id=$1",
          [claimed.user_id],
        )
      ).rows[0]; // 保存命令不等于永久授权
      if (
        !account ||
        account.disabled ||
        account.session_version !== claimed.session_version
      ) {
        await transaction(async (connection) => {
          const stopped = await connection.query(
            "UPDATE renewal_batches SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING id",
            [claimed!.id, claimed!.lease_token],
          );
          if (stopped.rowCount)
            await record(
              connection,
              "renewal-batch",
              "service.batch_cancelled",
              claimed!.id,
              { reason: "authorization_revoked" },
            );
        });
        return claimed.id;
      } // 撤销后不再动资源
      const results: Record<string, unknown>[] = [],
        request = {
          user: account,
          actorId: account.id,
          requestId: randomUUID(),
        } as SessionRequest; // 实际客户主账号仍是资源归属
      for (const item of claimed.items) {
        const key =
          "batch_" +
          createHash("sha256")
            .update(`${claimed.id}:${item.serviceId}`)
            .digest("hex"); // 即使进程在成交后退出，下次也返回原账单
        try {
          const order = await new Service().renew(
            item.serviceId,
            key,
            { period: item.period },
            request,
            undefined,
            claimed.session_version,
          );
          results.push({ ok: true, ...order });
        } catch (error) {
          // 使用服务当前合同计价，不汇总不同币种
          if (!(error instanceof HttpException)) throw error;
          results.push({
            serviceId: item.serviceId,
            ok: false,
            statusCode: error.getStatus(),
            message: error.message,
          });
        } // 某件服务不可续费不会被报告为成功
      }
      await transaction(async (connection) => {
        const saved = await connection.query(
          "UPDATE renewal_batches SET status='completed',results=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_until>now() RETURNING id",
          [claimed!.id, claimed!.lease_token, JSON.stringify(results)],
        );
        if (saved.rowCount)
          await record(
            connection,
            "renewal-batch",
            "service.batch_completed",
            claimed!.id,
            { results },
          );
      });
      return claimed.id; // 旧租约不能覆盖后来批次结果
    } catch (error) {
      if (claimed)
        await pool.query(
          "UPDATE renewal_batches SET status='pending',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",
          [claimed.id, claimed.lease_token],
        );
      throw error; // 数据库故障保留可恢复命令，不把未知结果写成失败终态
    } finally {
      this.running = false;
    } // 下一轮可继续领取
  }
}
