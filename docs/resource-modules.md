# 资源控制与客户活动

服务详情中的“控制与状态”打开 `/console/resources/:id`。页面从最近 90 秒内仍在心跳的 Go 节点读取插件能力，显示状态、监控、自定义动作、短期控制台和登录凭据。插件未声明的能力没有按钮；没有在线适配器时，页面说明当前无法在线控制。

每次查询供应商都先保存 PostgreSQL 任务，接口返回任务 ID，界面通过 AJAX 更新进度。服务当前主人、真实执行人、账号版本和提交标识分别保存。相同账号、相同标识和相同参数返回原任务；同标识换参数返回冲突。服务转移、取消或配置变更期间暂停控制，单个服务已有未决任务时等待其处理。

## 安装适配器

文件名决定供应商 ID。商品的 `provider` 应与该文件名一致。以下清单描述一个安装在 `/opt/yunzou/providers/cloud-agent` 的受控程序；程序路径、机构地址和机构凭据由部署者配置。

```json
{
  "mode": "command",
  "executable": "/opt/yunzou/providers/cloud-agent",
  "actions": ["provision", "suspend", "resume", "terminate", "renew", "upgrade", "resource"],
  "environment": ["CLOUD_API_URL", "CLOUD_API_TOKEN"],
  "timeoutSeconds": 30,
  "resource": {
    "clientActions": [
      {"id": "reboot", "label": "重启", "destructive": true},
      {
        "id": "resetPassword",
        "label": "修改资源密码",
        "fields": [{"key": "password", "label": "新密码", "secret": true, "required": true}]
      }
    ],
    "inspect": [{"key": "status", "label": "运行状态"}, {"key": "ip", "label": "地址"}],
    "metrics": [{"key": "traffic", "label": "流量", "unit": "Mbps"}],
    "consoleOrigins": ["https://console.example.com"],
    "credentialFields": [{"key": "username", "label": "用户名"}, {"key": "password", "label": "密码"}]
  }
}
```

Go 直接启动清单程序，以 JSON stdin/stdout 通信，不经过 shell。清单和程序须为普通文件，且不能由组或其他用户改写。动作名和字段名均有白名单。`RESOURCE_KEY` 不能列入子进程环境。

本节点只领取自己实际加载的供应商和动作。资源任务还要求能力快照、操作和自定义动作匹配；节点版本不一致时不会互相消耗不支持任务的重试次数。外部适配器必须使用 `job.id` 作为稳定幂等键，重试先查询机构已完成的操作。

## 输入与结果

普通任务继续使用既有 `action`。资源扩展的 `action` 固定为 `resource`，执行程序收到的 `payload` 为：

```json
{"operation":"action","actionId":"resetPassword","input":{"password":"本次输入"}}
```

操作为 `action`、`inspect`、`metrics`、`console` 或 `credentials`。只有自定义动作接收其声明的字段。监控另可接收 `metric`、`from`、`to`，时间使用 ISO 8601；起止时间同时填写，单次跨度最长 31 天。留空时适配器使用自己的默认时间段。

结果只接受当前操作的结构。状态是声明字段组成的文本对象；监控是声明指标组成的有序时间序列，每个指标最多 300 点。示例：

```json
{"data":{"fields":{"status":"running","ip":"192.0.2.38"}}}
```

```json
{"data":{"metrics":{"traffic":[{"at":"2026-11-11T00:00:00Z","value":1.25}]}}}
```

```json
{"data":{"console":{"url":"https://console.example.com/session/短期授权","expiresAt":"2026-11-11T00:05:00Z"}}}
```

```json
{"data":{"credentials":{"username":"机构实际返回的用户名","password":"机构实际返回的密码"}}}
```

自定义动作确认成功返回 `{}`。页面不接收供应商 HTML、脚本或嵌入页面。控制台必须使用声明的 HTTPS 来源，不能带 URL 用户名或密码，有效期不得超过五分钟。凭据字段必须已声明。

异步适配器在清单启用 `callback`，按 [供应商回调](agent.md#异步资源回调) 提交签名结果。等待态丢弃返回的 `data`，最终回调与同步结果共用验证、脱敏和加密步骤。供应商失败正文不进入客户错误、任务错误或审计。资源私有回调的重放摘要另以 `RESOURCE_KEY` 做HMAC，数据库中的摘要不能直接用来离线猜测供应商返回的弱密码。

## 私有数据

`RESOURCE_KEY` 是独立生成的 32 字节 hex 密钥，由 API 与 Go 共同持有。API 在任务入库前使用 AES-256-GCM 加密全部本次输入，Go 只在调用程序前解密。认证附加数据绑定服务、任务和输入或输出方向，复制密文到其他任务不能通过验证。

Go 在首次写入结果前分离控制台和凭据，独立加密后写入 `resource_private_outputs`；`jobs.result` 只保存白名单公共结果、私有结果可用标志和到期时间。任务和审计中不复制输入值、密码、控制台令牌或供应商失败正文。

破坏性动作、带敏感字段的动作、获取控制台和凭据都需要主账号当前密码及已启用的第二因素。读取私有结果再次复核本人，只能读取一次，最长保留五分钟的读取窗口。发起账号和当前服务主人必须同时匹配；服务转移后，双方都不能读取旧私有结果，新主人可以发起新的查询。

密钥须与数据库分开备份。更换密钥前应安排既有加密任务和结果的迁移，丢失密钥不能恢复这些密文。

## 客户活动

`/console/activity` 可按事件、关键词和北京时间日期筛选，以审计序号加载更早记录。查询先确定账号自己的订单、账单、当前服务、工单和合同，再通过 `audit(target,id)` 索引读取公开事件。返回事件名称、时间、对象和是否本人操作，不返回审计 `details`、原始供应商结果或其他账号事件。

## 验证

```bash
node --env-file=.env --import tsx --test apps/api/tests/resource.integration.test.ts
```

本轮 13 个测试通过，包含父测试。每次建立独立 PostgreSQL 库，启动生产 API、真实 Redis 会话、生产 Go 入口和本地可执行适配器，通过 HTTP 验证 HMAC 回调。检查覆盖输入加密、异步结果、重放、来源、子账号、Bearer、实际服务转移、真实 MFA 设置和恢复码单次消费，并共同验证 Go 与 TypeScript 的审计链。不连接真实云机构。

Go 的 `TestResource` 六个用例另检查密文绑定、未声明结果拒绝、控制台来源与期限、主密钥环境隔离，以及不同能力节点不能领取任务或消耗重试。浏览器使用真实 Nuxt/KIMA 和严格 API 拦截，检查 390px 手机操作、结构化监控、敏感表单、私有结果隐藏、离线能力及连续切页。截图保存到 `artifacts/v376-resource-*.png` 和 `artifacts/v376-activity-*.png`。
