# 币种与期初迁入

在 `/admin/currencies` 创建三位大写代码、名称、币符、小数位与汇率。小数位表示每个主单位包含多少位最小单位，例如JPY为0，CNY为2。创建后代码与小数位固定；改变其含义会破坏历史金额，所以调整时使用新的币种定义。

汇率口径为：1个该币种主单位等于 `rateNumerator / rateDenominator` 个CNY主单位。USD使用7/1时，1001分人民币转换为143美分，转换向上取目标币种最小单位。汇率的两个字段均接受正整数，金额运算使用BigInt。管理员可把已选商品转换到另一启用币种；商品全部周期、配置与专属价一起换算，已有订单、服务合同、税票、优惠码金额与资金保持原快照。

一张订单、一张合并账单和一笔还款只能包含同币种金额。钱包和授信可以同时存在多个币种，余额互不兑换或抵扣。服务续费按最初合同币种开单；如果目标方案币种不同，方案变更会拒绝报价。

默认支付插件声明支持CNY。外币账单可以用已有同币种钱包或授信结清；外币充值只在安装并配置真实支持该币种的支付插件后开放。页面读取服务端 `currencyDecimals`，缺少自定义币种精度时保留最小单位显示，金额输入会要求刷新元数据。

## 核对并迁入外币余额

`node --env-file=.env --import tsx scripts/opening.ts --file /secure/opening.json` 默认只检查，不写余额。文件必须位于私有目录，是不超过1MiB、权限0600的普通JSON文件。数据应来自原站逐户核对后的余额事实：

```json
{
  "sourceId": "original-usd-opening-2026",
  "sourceKey": "0123456789ABCDEF",
  "sourceHash": "填写已核对原始余额证据文件的64位SHA-256",
  "asOf": "2026-11-01T00:00:00Z",
  "reason": "与原站冻结时的逐户美元余额及汇总记录核对一致",
  "balances": [
    { "userId": "填写现有客户主账号UUID", "currency": "USD", "amountCents": "12345" }
  ]
}
```

`sourceHash` 需要替换为真实64位小写十六进制摘要，`userId` 使用目标库已存在的主账号。金额为该币种最小单位，不写浮点。先在币种管理中定义精度；每份文件中同一主账号与币种只能出现一行。

预检通过后，显式指定目标库写入：

```sh
IMPORT_DATABASE_URL='postgres://受控连接' node --env-file=.env --import tsx scripts/opening.ts \
  --file /secure/opening.json --apply --database yunzou
```

`--database` 必须与连接地址中的数据库名一致。写入事务保存来源、来源摘要、期初事实、迁移权益与钱包负债分录及审计。相同 `sourceId` 与内容重试返回原结果；同一来源换内容会拒绝。账户已经出现该币种钱包流水时拒绝追加期初，避免把迁移余额与正式运营流水重复相加。

原10.4.6完整快照导入工具 `scripts/import.ts` 保持其已核对的CNY映射协议。外币余额通过本工具提供独立的币种与来源核对，不从旧界面语言推断币种。

## 验证

```sh
node --env-file=.env --import tsx --test apps/api/tests/currency.integration.test.ts
```

测试启动真实Nest HTTP、随机PostgreSQL和Redis会话，检查币种精度、0位与8位金额、钱包与信用并发、原合同币种、批量有理数换价、充值退款占额、混币拒绝及期初工具重放。支付机构响应只使用隔离测试配置，不发起外部资金操作。
