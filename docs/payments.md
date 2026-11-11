# 支付接入

四个通道的下单和通知验签已实现。支付宝、微信、易支付 RSA V2 支持签名查单、退款和退款结果查询；虎皮椒支持验签的全额退款。离线测试不连接真实商户，正式收款前仍需验证下单、付款、重复通知、异常金额、退款与补偿。

原项目包含微信 `wx_pay` 和支付宝当面付 `ali_pay_dmf`。狐岚云保留扫码付款方式，微信改用 APIv3。原仓库没有易支付、虎皮椒，这两个插件根据公开协议新增。

## 配置

密钥放在进程环境或部署平台的密钥存储中。不要把值写进插件代码、数据库日志或前端配置。PEM 密钥可以保留实际换行，也支持以 `\n` 表示换行。

| 插件文件 | 必填环境变量 | 可选项 |
| --- | --- | --- |
| `packages/payments/plugins/alipay.ts` | `ALIPAY_APP_ID`、`ALIPAY_SELLER_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` | `ALIPAY_URL`，默认支付宝正式网关 |
| `packages/payments/plugins/wechat.ts` | `WECHAT_APP_ID`、`WECHAT_MCH_ID`、`WECHAT_SERIAL`、`WECHAT_PRIVATE_KEY`、`WECHAT_API_V3_KEY`，另提供可信平台公钥 | 单公钥用 `WECHAT_PLATFORM_SERIAL` + `WECHAT_PLATFORM_PUBLIC_KEY`，多公钥用 `WECHAT_PLATFORM_KEYS_JSON` |
| `packages/payments/plugins/epay.ts`，V1 | `EPAY_URL`、`EPAY_PID`、`EPAY_KEY` | `EPAY_TYPE`，省略时由收银台选择 |
| `packages/payments/plugins/epay.ts`，V2 | `EPAY_VERSION=2`、`EPAY_URL`、`EPAY_PID`、`EPAY_PRIVATE_KEY`、`EPAY_PUBLIC_KEY` | `EPAY_TYPE` |
| `packages/payments/plugins/hupijiao.ts` | `HUPIJIAO_URL`、`HUPIJIAO_APPID`、`HUPIJIAO_SECRET` | 无 |

易支付 V1 的 `EPAY_URL` 填完整 HTTPS `submit.php` 地址；V2 填完整 HTTPS `/api/pay/submit` 地址，查询和退款访问同目录的对应接口。`HUPIJIAO_URL` 填后台提供的完整 HTTPS `/payment/do.html` 地址。微信平台公钥及其标识必须从可信渠道取得，插件不会使用通知请求传来的公钥，也不会自动下载替换本地公钥。

微信的 `WECHAT_SERIAL` 是商户证书序列号；`WECHAT_PLATFORM_SERIAL` 是验签平台证书序列号或支付公钥标识，二者不能互换。`WECHAT_API_V3_KEY` 必须正好 32 字节。

## 调用

```ts
import { PaymentPlugins } from '@fuxoria/payments';

const payments = await PaymentPlugins.load();
const available = payments.list();
const plugin = payments.get('alipay');
const checkout = await plugin.create({
  invoiceId: '75c90e16-fb30-4abf-b31c-f080005d24ce',
  amountCents: '123',
  currency: 'CNY',
  subject: '云服务账单',
  notifyUrl: 'https://cloud.example/api/v1/payments/alipay/notify',
  returnUrl: 'https://cloud.example/console/invoices',
});
```

金额一律使用十进制整数分字符串。上例是人民币 1.23 元。外部商户订单号使用去掉连字符的 UUID，验签结果会恢复原 UUID；同一账单重试继续使用原订单号。

`url` 是付款跳转地址，`qrCode` 是需要展示成二维码的内容或机构二维码地址。支付宝返回二维码链接，微信返回 `weixin://` 二维码内容，易支付返回收银台链接。虎皮椒依网关响应返回跳转链接和二维码地址。浏览器返回页面只用于展示结果，不能据此入账。

通知处理顺序为：保留原始正文、调用 `verify`、在数据库事务中核对账单金额和币种、依据机构交易号去重、写入账本和开通任务、提交事务，最后返回 `acknowledgment`。验签失败或事务失败时不能返回成功应答。

易支付 V1 通知使用 GET，HTTP 入口必须拒绝重复查询字段。其他三个通道使用 POST。表单正文由插件拒绝重复字段；JSON 正文中的嵌套重复字段也会被拒绝。正文上限为 64 KiB，支付请求超时为 10 秒。

新增通道只需要在 `plugins/` 新建一个导出默认创建函数的文件，函数返回 `PaymentPlugin`。启动时按文件名发现插件，不需要维护中央名单。删除通道文件后，重新构建并重启进程即可；已有付款记录仍保留在账本。

## 查询与退款

```ts
const payment = await plugin.query!({ invoiceId });
const application = {
  invoiceId,
  transactionId: payment.transactionId,
  refundId: '9fc120bf-a27f-4a82-9303-a7e125fa31d1',
  amountCents: '20',
  totalCents: '123',
  reason: '客户申请',
};
const accepted = await plugin.refund!(application);
if (accepted.status === 'pending') {
  // 在后续调度中查询原申请，不生成新的退款号。
  const confirmed = await plugin.queryRefund!(application);
}
```

调用前先检查插件是否提供对应方法。通道不支持的行为会抛出带 `501` 或 `422` 状态的业务错误，不能当作付款未发生或退款成功。`pending` 只能表示仍待确认；主业务需要保存原退款号和金额，预留累计可退余额，并在调度中确认最终结果。

| 通道 | 主动查询 | 退款 | 退款最终确认 |
| --- | --- | --- | --- |
| 支付宝 | RSA2 验签，绑定原订单；签名请求限定应用访问范围，回传商户字段也逐项核对 | 支持部分退款，固定 `out_request_no` | 明确资金变动，或退款查询返回 `REFUND_SUCCESS` |
| 微信 | 平台签名、商户、应用、金额与原订单核对 | 支持部分退款，固定 `out_refund_no` | 独立退款查询，`PROCESSING` 保持待确认 |
| 易支付 RSA V2 | 平台签名、时间、商户、金额和原订单核对 | 固定 `out_refund_no`，具体通道的部分退款能力由网关确认 | 独立退款查询返回成功 |
| 易支付 V1 | 无签名的查询响应不用于自动改账，返回 `501` | 无签名结果及统一幂等保障，返回 `501` | 升级 RSA V2 或从商户后台核对 |
| 虎皮椒 1.1 | 只有已验签且包含商户、订单、金额和交易号的完整文本结果可用于补偿；嵌套 `data` 对象返回 `501` | 仅全额退款，机构返回签名及订单金额必须核对一致 | `CD` 明确已退款；`RD` 保持待确认，需商户后台核对 |

虎皮椒官方查询文档给出嵌套 `data` 对象，公开 SDK 没有验证该查询响应，公开签名规则也没有定义对象的序列化。狐岚云不会自行选一种对象编码方式再称为官方验签。其退款请求不提供商户退款号参数，网络超时后不要自动创建另一笔退款，也不要把订单查询的 `CD` 取消状态当作已退款。

## 微信公钥轮换

平台新公钥应先通过微信商户后台或官方工具取得并核对标识，再将新旧两把公钥一起放入 `WECHAT_PLATFORM_KEYS_JSON`。例如，准备一个只包含公钥的文件：

```json
{
  "OLD_SERIAL": "-----BEGIN PUBLIC KEY-----\n旧公钥内容\n-----END PUBLIC KEY-----",
  "NEW_SERIAL": "-----BEGIN PUBLIC KEY-----\n新公钥内容\n-----END PUBLIC KEY-----"
}
```

在环境变量中加载后重启服务：

```bash
export WECHAT_PLATFORM_KEYS_JSON="$(cat /etc/yunzou/wechat-platform-keys.json)"
npm run dev:api
```

现有的单公钥配置可与 JSON 集合并存。同一标识配了两份不同公钥会使启动失败，防止静默覆盖信任。新旧响应都验证通过后，再根据微信平台通知与保留窗口移除旧公钥。生产环境由部署平台将同一变量注入 API 进程；上例仅展示本地启动方式。

## 验证与边界

```bash
npm run build --workspace=@fuxoria/payments
npm run test --workspace=@fuxoria/payments
npm run typecheck --workspace=@fuxoria/payments
```

测试覆盖精确金额、UUID 映射、支付签名、商户身份、重复字段、过期通知、出站请求、主动查询、退款幂等号、待确认状态和多公钥轮换。测试使用独立生成的商户与机构 RSA 密钥和离线响应，不提供生产环境模拟付款通道。

微信签名时间窗口为 5 分钟，易支付 V2 的主动查询响应也使用 5 分钟窗口。虎皮椒和易支付 V2 通知保留 48 小时窗口，给机构重试留出时间。易支付 V1 没有时间戳字段，支付宝通知也不靠本地短时间窗口去重；这些通知仍需依靠机构交易号唯一约束和账单状态防止重复入账。

自动补偿的调度、累计退款限额和账本入账由主业务负责；本包只返回验签后的机构结果。微信公钥采用人工建立信任后平滑轮换，未实现自动下载替换。超出通知窗口的付款需使用有签名的主动查询确认；没有真实商户验证前，不能把离线测试通过表述为支付接入已经验收。

易支付 V1 与虎皮椒 1.1 使用协议规定的 MD5 签名，虎皮椒使用直接拼接密钥的 MD5，并非 HMAC。这些旧协议的安全性质不能等同于非对称数字签名。使用者需要自己选择接受的通道；插件不会把算法静默替换成机构无法识别的版本。

协议来源：[支付宝异步通知](https://opendocs.alipay.com/open/270/105902)、[支付宝官方 Node SDK](https://github.com/alipay/alipay-sdk-nodejs-all)、[微信订单查询](https://pay.wechatpay.cn/doc/v3/merchant/4012791880)、[微信退款流程](https://pay.wechatpay.cn/doc/v3/merchant/4013071031)、[微信资源解密](https://pay.wechatpay.cn/doc/v3/merchant/4012071382)、[易支付 V1](https://api.zhunfu.cn/doc/v1_legacy_api.html)、[易支付 V2 签名](https://api.zhunfu.cn/doc/sign_note.html)、[易支付退款](https://api.zhunfu.cn/doc/pay_refund.html)、[虎皮椒 1.1](https://www.xunhupay.com/doc/api/pay.html)、[虎皮椒查询](https://www.xunhupay.com/doc/api/search.html)、[虎皮椒退款](https://www.xunhupay.com/doc/api/refund.html)。
