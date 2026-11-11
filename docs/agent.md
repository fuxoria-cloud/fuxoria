# 开通与调度守护进程

Go 进程只消费主业务已写入 PostgreSQL 的资源任务。支付入账、账单和订单状态仍由 NestJS 处理。Redis 用于主业务会话、缓存或唤醒；队列的持久状态只有 PostgreSQL 一份，Redis 重启不会使已入队任务消失。

## 运行

```bash
cd agent
go build -o /tmp/yunzou-agent .
# AUDIT_KEY 已从受控环境载入，与 NestJS 主业务使用同一个值。
DATABASE_URL='postgresql://yunzou@127.0.0.1:5432/yunzou' \
  /tmp/yunzou-agent --plugins "$PWD/plugins" --concurrency 4 --lease 2m
```

`AUDIT_KEY` 至少 32 字符，缺失或过短时进程拒绝消费任务。实际密码通过受控环境配置注入，不写进命令历史、插件清单或仓库。默认插件目录位于可执行文件旁的 `plugins`；开发时显式传入绝对路径，换启动目录也不会换一套配置。

`--concurrency` 为 1 至 32，默认 4；`--lease` 至少 30 秒，默认 2 分钟；`--poll` 至少 100 毫秒，默认 500 毫秒。数据库连接数上限为并发数加 6，为资源回调、心跳和调度留出连接。收到 SIGINT 或 SIGTERM 后停止领取新任务，中止执行中的子进程，并给结果写回最多 5 秒。

每次启动生成独立节点 UUID，立即登记实际插件能力，此后每 30 秒更新 `agent_presence`。心跳只包含版本和插件的 `id`、`mode`、`actions`，不包含程序路径、环境变量或密钥。退出后不删除记录，后台按最近 90 秒心跳判定在线。

容器构建与运行：

```bash
docker build -f agent/Dockerfile -t yunzou-agent agent
docker run --rm --name yunzou-agent \
  -e DATABASE_URL -e AUDIT_KEY \
  -v /opt/yunzou/plugins:/opt/yunzou/plugins:ro \
  yunzou-agent
```

镜像以非 root 用户运行，不包含 shell。外部插件如依赖动态库或解释器，部署方应制作包含对应受信任依赖的镜像；默认镜像适合静态可执行插件。

## 插件

启动时扫描插件目录的 `*.json`，ID 就是文件名。安装新供应商只添加一份清单及其程序；卸载时删除该清单后重启，不改中央注册表。

仓库自带 `manual.json`。人工任务会保持 `queued`，注明 `manual_required` 和 `manualRequired: true`，延后自动领取且不消耗失败重试次数。管理员核实真实资源后从后台确认；这个插件本身不会激活客户服务。

外部程序清单示例：

```json
{
  "mode": "command",
  "executable": "./bin/provider",
  "arguments": ["--json"],
  "actions": ["provision", "suspend", "resume", "terminate", "renew"],
  "environment": ["PROVIDER_API_URL", "PROVIDER_API_TOKEN"],
  "timeoutSeconds": 60,
  "callback": false
}
```

`executable` 相对清单所在位置解析。参数直接进入 `argv`，不进行 shell 展开，也不执行命令字符串。清单与程序必须是普通文件，且不可被组或其他用户写入；程序还必须可执行。目录的安装和维护权限也应只授予受信任的运维人员。插件拥有调用外部平台的权限，不是用于运行不受信任代码的沙箱。

插件默认只得到 `PATH`，其余环境变量必须在清单列出名字。密钥值由运行环境提供。程序从 stdin 读取一个 JSON，载荷最大 256 KiB：

```json
{
  "id": "26aa73f8-d82b-4ac1-86d2-0f45a2e81f44",
  "serviceId": "99f68b0f-934d-4c27-8caf-ea598078226e",
  "action": "provision",
  "provider": "example",
  "payload": {},
  "attempt": 1,
  "externalId": null,
  "name": "客户服务名称",
  "callbackReference": "本次领取生成的64位随机hex",
  "callbackUrl": "https://cloud.example/callbacks/jobs/26aa73f8-d82b-4ac1-86d2-0f45a2e81f44"
}
```

stdout 只能返回一个 JSON 对象，最大 64 KiB。开通成功必须返回供应商真实资源 ID：

```json
{"externalId":"vm-123","data":{"region":"cn-east"}}
```

暂停、恢复、销毁和续费可返回 `{}`。同步程序应在供应商已确认该动作完成时退出成功；失败时用非零退出码。不要在结果中存密码或访问令牌。stderr 不写入客户可见错误，避免供应商诊断意外暴露凭据。

插件超时必须比租约短至少 10 秒，留出事务提交时间。守护进程会拒绝未知字段、第二份 JSON、空开通资源 ID、未声明动作和未知供应商，失败按队列规则重试。

## 租约与状态

领取任务使用 PostgreSQL `FOR UPDATE SKIP LOCKED`，同时锁定任务和所属服务。同一服务处于 `running`、`waiting` 或 `manual_review` 时，后续动作不能并行领取；其他服务仍能并发执行。每次领取生成新 `lease_token` 和独立 `callback_reference`，并增加尝试次数。内部租约令牌不会序列化给外部程序。

成功、失败和人工等待的写回都要求 token 仍一致且租约未过期。成功写回在同一事务内完成任务、服务状态和审计链追加。失败、重试、人工等待与租约耗尽也会追加审计。签名使用与主业务共用的 `AUDIT_KEY`，并保存原文字段 `canonical_body`，供 TypeScript 和 Go 按同一字节验证。过期消费者即使晚到，也不能覆盖新 owner 的结果。最后一次尝试失联后，租约回收会将任务转为 `failed`，避免永久停在 `running`。

失败等待时间为 `min(3600, 5 × 2^attempts)` 秒；超过 `max_attempts` 后进入 `failed` 死信状态。失败的首次开通会把尚未激活的服务标为 `failed`；暂停等操作失败时保留资源原状态。

开通成功将服务设为 `active` 并记录真实外部 ID，首次到期默认一个日历月。暂停设为 `suspended`，恢复设为 `active`，销毁设为 `cancelled`。续费在当前到期日和当前时间的较晚者上增加一个日历月；续费失败不提前延长到期时间。

## 异步资源回调

异步供应商在清单中设置 `"callback": true`。运行前必须显式启用回调监听，配置该供应商的独立密钥和可访问来源。没有这些配置时进程拒绝启动异步插件，不会先向供应商发送无法确认结果的请求。

```bash
# 在主机上生成并注入环境；同一供应商的签名端需要配置相同密钥。
export PROVISION_CALLBACK_KEYS_JSON="$(node -e 'process.stdout.write(JSON.stringify({example:require("node:crypto").randomBytes(32).toString("hex")}))')"
/tmp/yunzou-agent --plugins /opt/yunzou/plugins \
  --callback-listen 127.0.0.1:3310 \
  --callback-origin https://cloud.example \
  --callback-wait 30m
```

`PROVISION_CALLBACK_KEYS_JSON` 是供应商文件名到 64 位 hex 密钥的 JSON 对象。每个供应商单独配置，不复用 `AUDIT_KEY` 或支付密钥。`--callback-origin` 也可通过 `PROVISION_CALLBACK_ORIGIN` 提供，只允许不带路径、查询和凭据的 HTTPS 来源；本机开发可用 HTTP。

`--callback-listen` 默认值是 `127.0.0.1:3310`，但只有命令中显式提供这个参数才打开监听。没有密钥时不能开启。容器内部如需被反向代理连接，可显式监听 `0.0.0.0:3310`。将 `/callbacks/jobs/*` 原样转发到该端口，保持路径和正文原始字节，不添加 `/api/v1` 前缀。监听与资金支付通知相互独立，微信、支付宝等资金通知仍由 NestJS 验签入账。

机构只确认受理时，插件退出成功并返回：

```json
{
  "pending": true,
  "callbackReference": "原样回显stdin中的callbackReference",
  "data": {"region": "cn-east"}
}
```

守护进程先将任务保存为 `waiting`，清除执行租约，并记录等待截止时间。默认等待 30 分钟，`--callback-wait` 范围为 1 分钟至 24 小时。若机构在受理时已经返回资源 ID，完成通知必须回传同一个 ID。

完成通知发送到 `POST /callbacks/jobs/:id`，正文不超过 64 KiB：

```json
{
  "provider": "example",
  "jobId": "26aa73f8-d82b-4ac1-86d2-0f45a2e81f44",
  "reference": "本次任务提供的64位callbackReference",
  "status": "succeeded",
  "result": {"externalId": "vm-123", "data": {"region": "cn-east"}}
}
```

暂停、恢复等动作的 `result` 可为 `{}`；开通成功必须有真实 `externalId`。失败通知使用 `"status":"failed"`，可附脱敏的 `error` 字段。不要在回调中再发送 `pending`，也不要发送内部 `lease_token`。

四个单值请求头为：

| 请求头 | 内容 |
| --- | --- |
| `X-Yunzou-Provider` | 供应商文件名，与正文及任务一致 |
| `X-Yunzou-Timestamp` | 当前 Unix 秒时间戳，允许前后 5 分钟 |
| `X-Yunzou-Nonce` | 新事件的 16 至 128 位字母、数字、下划线或连字符随机值 |
| `X-Yunzou-Signature` | HMAC-SHA256 的 64 位 hex 结果 |

签名原文由以下字节顺序组成，最后也有一个换行：

```text
POST\n
/callbacks/jobs/<jobId>\n
<timestamp>\n
<nonce>\n
<原始JSON正文>\n
```

供应商先把正文序列化成一份固定字节，再同时用于签名和发送。验签使用常量时间比较。任务 ID、供应商、当前随机引用、等待状态和截止时间都通过后，服务状态、任务完成、nonce 及审计在同一事务提交。

同供应商的相同 nonce 与完全相同正文重复发送会得到 `200`，不会重复改变资源；同 nonce 改正文返回 `409`。重新签名重试时可更新时间戳，保留原 nonce 和原始正文。重复 JSON 字段，包括嵌套对象和通过 Unicode 转义伪装的同名键，会被拒绝。

若供应商推送比插件返回 `pending` 更快，任务尚为 `running`，服务端返回 `503` 要求保留原 nonce 和正文稍后重试，不提前消费事件。进入 `waiting` 后，同一事件可以正常完成。`409` 表示旧引用、超时或已结束任务冲突，不能据此创建新的资源。

等待超时、失败通知或异步程序已经运行但没有可确认结果时，任务转为 `manual_review`，不自动重开资源，并继续阻挡该服务的后续动作。迟到通知不能直接完成已经超时的任务。管理员须核对供应商真实状态后再处理，不能通过普通失败重试或伪造完成按钮消除未知资源事实。

## 到期暂停

只有显式传入 `--schedule` 才会安排到期任务：

```bash
/tmp/yunzou-agent --plugins /opt/yunzou/plugins --schedule
```

启动后检查一次，此后每 60 秒为 `due_at < now()` 且仍为 `active` 的服务排 `suspend`。已保存终止意图的资源，或已有queued、running、waiting、manual_review任务的资源，不会再安排逾期暂停；人工插件保持的queued等待也属于未处理完的操作。去重键包含服务 ID 和精确到期时点，多进程不会为同一次到期重复创建任务。载荷标记 `reason: overdue` 和原到期时间。

调度不会直接把服务改成已暂停。只有供应商确认成功后，服务才变为 `suspended`，并保存 `suspend_type=overdue`、说明和暂停时间。恢复成功会清除这些标记。逾期销毁没有自动调度开关。

排队后已续费，或终止意图已先提交的旧暂停任务，在领取时会被拒绝。尚未移交人工的动作由维护流程记录跳过原因及审计；已经保存 `manualRequired` 的动作仍待管理员核对，不能推断人工操作尚未执行并自动写成功。如果续费发生在供应商执行暂停期间，守护进程保存真实已暂停状态，同时持久化一次 `resume` 补偿；只有供应商确认恢复，界面才会重新显示 `active`。

人工核实供应商尚未执行旧暂停时，可调用 `POST /api/v1/admin/jobs/:id/skip`，提交核实说明 `reason`、当前 `password`，以及账号启用MFA时的 `totp` 或 `recoveryCode`。入口只关闭已过时的人工逾期暂停待办，不改变资源状态和到期，也不产生恢复任务；核实记录进入审计。重复提交仍须通过当前身份复核，但不会重复关闭。已经跳过的任务不能再确认为实际暂停。若实际已经暂停，则应确认完成，让续费后的资源通过恢复任务继续交付。

自动逾期动作同时具有 `reason: overdue` 和调度器保存的 `dueAt`。管理员自由说明恰好写成 `overdue` 而没有到期快照时，仍是人工暂停；续费不会越过人工核查自动恢复。

租约解决数据库的旧 owner 回写问题，无法撤销已经送到云平台的请求。供应商插件必须把任务 `id` 作为幂等键，在超时和重试时先查原请求或原资源，再决定是否创建。若供应商不支持幂等、查单或可核对的资源标识，需要人工复核，不能声称外部操作“恰好一次”。

PostgreSQL 的队列锁语义见 [SELECT 锁定条款](https://www.postgresql.org/docs/current/sql-select.html)，驱动使用 [pgxpool](https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool)。

## 验证

```bash
cd agent
go test -race ./...
YUNZOU_TEST_DATABASE_URL='postgresql://yunzou@127.0.0.1:55480/yunzou_agent_test' \
  go test -race ./features -run TestQueue -count=1 -v
```

队列测试在指定数据库内创建独立随机 schema，执行 `database/migrations/*.sql` 的完整迁移序列，结束后清理。不要指向生产库。未设置测试数据库变量时，队列集成测试会明确跳过；插件协议测试仍会执行。

测试覆盖并发争抢只领取一次、同服务不同动作串行、过期 owner 的结果被拒绝、退避、死信、人工等待、审计链、插件协议、进程组超时、异步程序异常、签名回调并发重放、等待超时、到期调度去重、续费竞争与运行节点能力白名单。真实供应商开通仍需使用隔离账号完成外部联调。
