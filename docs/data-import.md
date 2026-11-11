# 原系统数据迁移

工具先把旧 MySQL 导出为可校验的只读快照，再离线预检，最后在明确指定的空 PostgreSQL 库中原子导入。原库始终只读；新库导入不会覆盖现有客户，也不会触发任何实例开通。

## 导出

依赖 `mysql2` 已登记在 API 包依赖中，安装项目依赖后运行：

```bash
LEGACY_SOURCE_ID=old-site-01 \
LEGACY_DATABASE_URL='mysql://只读用户:密码@127.0.0.1:3306/旧库' \
  npm exec tsx -- scripts/export.ts --out /secure/old-site.ndjson
```

实际凭据应由受控环境注入，避免进入终端历史。`LEGACY_SOURCE_ID` 是稳定的原站点标识，使用 1 至 80 位英文、数字、点、短横线或下划线。以后重导同一站点必须保持它不变，否则确定性 ID 也会改变。表前缀默认 `idcsmart_`，可用 `LEGACY_TABLE_PREFIX` 指定。

导出器使用 `REPEATABLE READ` 与 `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`，以 MySQL 5.6 及以上支持的语法读表。只接受 InnoDB，遇到其他引擎就停止，避免把不受同一事务保护的金融数据混在一起。导出期间仍应停止结构变更；最终切换前冻结原系统资金与资源写入，再取最终快照。

本机连接默认不启用 TLS，适合使用受控的本机数据库或 SSH 隧道。远程默认要求 TLS 并校验证书；私有 CA 可通过 `LEGACY_MYSQL_CA` 指定文件。`LEGACY_MYSQL_TLS` 仅接受 `required` 或显式的 `disabled`。MySQL 驱动的十进制和大整数选项保证金额与大主键以文本传递，不经过 JavaScript 浮点数。

快照包含原库中指定前缀下全部基础表的字段定义、原字段行、实际行数和 SHA-256 尾部摘要。第一行是 manifest，`source.version` 记录 MySQL 服务端版本；业务字段基线来自仓库 `reference/inventory.json` 的原 10.4.6 安装表证据。它不会仅假定线上只有这 182 张表。

文件可能含个人资料、旧密码摘要和平台配置，应按敏感备份管理。导出文件以 `0600` 创建，临时文件写完并同步后才原子创建最终文件名，已有文件拒绝覆盖。脚本不读取 PHP 中的 `AUTHCODE`；若数据库中有明确命名的 AUTHCODE 配置，也会停止导出并清理临时文件，该密钥应另走受控配置流程。

## 先做离线预检

映射文件把币种、支付通道、原实例 ID 和工单状态中需要人确认的含义写明：

```json
{
  "currency": "CNY",
  "gateways": {"AliPayDmf": "alipay", "WxPay": "wechat"},
  "providers": {"3": "manual"},
  "externalIds": {"10": "供应商确认的真实实例ID"},
  "ticketStatuses": {"1": "open", "2": "open", "3": "answered", "4": "closed", "5": "open"},
  "countries": {"CHINA": "CN"},
  "unpaidDeadline": "2027-01-01T00:00:00Z"
}
```

这里的数字和时间仅展示字段格式，实际值须对照原站点核对。`providers` 按原商品 ID 映射新供应商插件名，商品导入后仍保持下架；`externalIds` 按原 host ID 指定真实平台实例。没有显式实例映射时，工具只会从已支持的原平台关联表取唯一的真实 `rel_id`。

工单状态必须显式映射。原系统数字状态可由插件自定义，不能靠数字或名称猜完结含义。没有付款截止时间的未付订单，需要明确的 `unpaidDeadline` 策略；已付历史订单无此期限时使用其原创建时间作为账单展示日期，不改变其已结清状态。原站币种必须核对为 CNY；其他币种不会被自动折算。

```bash
npm exec tsx -- scripts/import.ts \
  --file /secure/old-site.ndjson \
  --map /secure/mapping.json
```

默认只生成离线 dryrun 报告，即使配置了 `IMPORT_DATABASE_URL` 也不连接目标库。报告包含来源、来源密钥编号、各类数量、期初余额总额和可定位的阻断原因，不输出客户资料、密码摘要或正文。存在阻断时退出码为 2。

文件权限过宽、符号链接、缺失 footer、SHA-256 不符、行数不符、行字段与 manifest 不一致都会停止读取。当前核心规划器上限为两百万行、单行 8 MiB，超过时需要按业务边界重新规划迁移批次，不能截断文件。

## 核心业务映射

| 原记录 | 新业务表与处理 |
| --- | --- |
| `client` | 正常 `users` 客户资料、原启停状态、原密码专用兼容字段 |
| `admin` | 停用的 support 作者，用于保留历史工单身份；不会自动复制旧管理员权限 |
| `product` | 正常 `products`，仅接受已确认的自然月预付价；原 ID、分组 ID、周期与付款类型明确保留，先下架 |
| `order`、`order_item` | 单商品单资源的新购或续费订单，以及正常 `invoices`；原价、创建与支付时间、备注和原 ID 保留 |
| `host`、原平台关联表 | 正常 `services`，保留真实外部 ID、当前状态、到期、暂停原因、备注与合同续费价，不写 `jobs` |
| `transaction` | 有原渠道、原交易号且能逐笔核对的单笔全额已付收款，进入正常 `payment_receipts` 与现金/收入平衡双分录 |
| `client_credit` | 独立不可变的 `wallet_history`；历史变更用于对账与查询，不再次重放到可用余额 |
| 客户最终余额 | 独立 `opening_balances` 事实及专用期初会计来源；不伪造支付回调或新收款 |
| 工单与回复 | 正常 `tickets`、`ticket_replies`，包括首条说明、后续作者、原工单号和内部备注 |

`server`、商品分组、工单类型与状态、平台关联表用于核对身份和关系。原平台凭据不复制到新服务执行环境，须在新插件中重新配置。源快照始终保留这些表的完整原字段；这不表示其后台管理、模块计价和全部插件功能已经在新系统完成迁移。

每个新 ID 用原站点、实体名、旧 ID 生成标准 UUIDv5，并写入 `import_ids`。同一旧用户与同一旧订单不会因为重跑 dryrun 或重新导出而换 ID，不同站点同号记录也不会碰撞。

期初正余额对应公司负债：`wallet:<用户ID>` 记负分录，`migration:equity` 记等额正分录。客户可用余额为钱包账户分录的负合计。原真实收款另外有现金正分录与收入负分录，期初余额不会再增加支付收入。历史交易号也会保留，但旧平台商户订单号不一定等于新账单 UUID；原路退款还必须核对原平台订单标识，不能用新 UUID 猜旧单号。非零余额按用户核对历史连续性和最终余额，不只对全站总数。

## 会阻断的内容

工具不会把所有原表塞进 JSONB 后称为移植完成。源快照中非空且尚无业务映射的表会列为阻断；原 182 表证据之外新增的核心字段也会要求解释含义。

当前核心映射还会拒绝：多商品或多资源订单、升降级与人工订单、部分支付、余额抵扣、退款中状态、锁定或回收订单、原支付证据缺失、同渠道交易号冲突、非月付或后付计价、在途开通、比例续费、上下游资源、无法确认的外部实例、工单附件及未知状态。旧账号无有效邮箱、使用未识别密码算法、已有操作密码，或资料超出新版字段限制时同样停止。

这些记录保持在原快照里，报告会给出原表和记录 ID，不能靠忽略错误开关强行导入。需要为对应业务补齐映射和实际功能，再重新预检。

## 写入专用空库

先在另一份新数据库执行完整迁移，并只用 bootstrap CLI 创建一个必要的首位管理员。不要在导入目标提前创建商品、客户、文章、余额或其他业务数据。目标必须有独立名称，不能使用当前 dev 库名，即使改用另一个 DNS 别名也会被拒绝。

```bash
IMPORT_DATABASE_URL='postgresql://受控连接/全新库名' \
  npm exec tsx -- scripts/import.ts \
  --file /secure/old-site.ndjson \
  --map /secure/mapping.json \
  --apply --target-empty --database 全新库名
```

实际库名使用 PostgreSQL 支持的英文、数字与下划线。`IMPORT_DATABASE_URL` 与 `--database` 必须一致，连接后的实际数据库名也会复核；根 `DATABASE_URL` 只用于识别禁止覆盖的 dev 库。

工具在一个串行化事务内锁定目标业务表，检查实际空库状态，然后插入标准业务行、映射、历史收款、期初分录和一笔导入审计。只允许保留一个未导入的 bootstrap 管理员，其邮箱与原账号不能冲突；完整迁移写入的精确初始联盟设置与CNY币种锚种子可以保留；字段值改变或增加其他配置仍会拒绝。其余表出现任何业务记录都会拒绝。没有 `ON CONFLICT UPDATE`，不会覆盖或合并客户。

任一行、外键、会计约束或审计失败都会回滚整轮。已经导入过的目标不再是空库，重复 apply 会被拒绝，不能重复记账。这是整库首次切换工具，不是线上增量同步器。

## 旧密码与上线

旧 V10 密码为 `###` 加 `md5(md5(AUTHCODE + password))`。原摘要只进入 `users.legacy_password`；`users.password` 放随机不可知明文的 Argon2id 摘要，不把旧 MD5 当成新哈希使用。

`legacy_authcode_id` 是原站点标识 SHA-256 的前 16 个十六进制字符，转为大写。其编号会出现在 dryrun 报告中。原 AUTHCODE 通过 `LEGACY_AUTHCODE_<编号>` 提供，也可为单源配置 `LEGACY_AUTHCODE`；不要放进导出文件、映射文件、数据库或仓库。登录兼容分支核对成功后，使用用户此次输入的密码生成 Argon2id，并清除两项 legacy 字段。缺失原 AUTHCODE 时拒绝登录，不能退回不带盐的猜测算法。

导入提交后先核对来源行数、新旧 ID、逐用户余额、原收款、服务外部 ID、历史合同价、工单和审计链，再开放入口。商品默认下架，需确认供应商配置和实际计价后再逐项上架。已有平台资源不重新开通；旧支付通知、旧任务和新守护进程的切换需按 [迁移流程](migration.md) 完成冻结与最终对账。

## 验证范围

```bash
npm exec tsx -- --test apps/api/tests/import.test.ts
```

本轮8个测试通过、0失败、0跳过，包含父测试及7个子场景。真实 PostgreSQL 验证了全部目标迁移、晚期外键错误整轮回滚、保留 bootstrap 管理员、重复导入拒绝、原收款与期初负债对账、历史合同价与明确的CNY月付合同、初始配置种子与修改后配置的区分、标准 HMAC 验链，以及期初事实不可修改。测试库 `yunzou_import_test` 和含资料的临时文件在结束后清理。

源端使用协议记录器检查实际发出的只读 SQL、分页、十进制文本、0600 文件和摘要；本环境没有实际 MySQL 5.6 实例，未把这项检查称为旧生产库联调。连接正式旧库前应先用只读账号在隔离恢复库完成一次导出与全量对账。

MySQL 驱动选项参考 [MySQL2 文档](https://sidorares.github.io/node-mysql2/docs)，新库的事务语义参考 [PostgreSQL 事务隔离说明](https://www.postgresql.org/docs/current/sql-set-transaction.html)。
