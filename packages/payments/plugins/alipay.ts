/**
 * 支付宝当面付：预下单、通知验签、主动查单和幂等退款。
 * 调用：const plugin = createPlugin(process.env); await plugin.query!({invoiceId});
 * 退款：await plugin.refund!({invoiceId,transactionId,refundId,amountCents:'100',totalCents:'123',reason:'客户申请'});
 * 配置：ALIPAY_APP_ID、ALIPAY_SELLER_ID、ALIPAY_PRIVATE_KEY、ALIPAY_PUBLIC_KEY。
 * 协议：https://opendocs.alipay.com/open/270/105902 ，原代码见reference中的ali_pay_dmf。
 */
import { sign, verify } from 'node:crypto';                     // 使用标准RSA-SHA256实现RSA2
import type { PaymentPlugin, PaymentRefund } from '../index.js'; // 对主业务提供同一份支付合同
import { cents, configured, fail, form, httpsUrl, invoiceId, json, jsonPart, requireConfigured, shortId, tradeId, within, yuan } from '../utils/input.js'; // 支付机构边界检查
import { body } from '../utils/http.js';                       // 限制外部响应大小

/** @param environment 商户密钥与身份。 @param send HTTP传输，测试可替换。 @returns 支付宝当面付实现。 */
export default function createPlugin(environment: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch): PaymentPlugin {
  const ready = configured([environment.ALIPAY_APP_ID, environment.ALIPAY_SELLER_ID, environment.ALIPAY_PRIVATE_KEY, environment.ALIPAY_PUBLIC_KEY]); // 应用和收款人身份都必须配置
  const privateKey = environment.ALIPAY_PRIVATE_KEY?.replace(/\\n/g, '\n'); // 兼容环境变量中的换行写法
  const publicKey = environment.ALIPAY_PUBLIC_KEY?.replace(/\\n/g, '\n'); // 支付宝公钥来自商户后台

  // --- 请求支付宝并验证机构响应 ---
  async function request(method: string, content: Record<string, unknown>, notifyUrl?: string) {
    requireConfigured(ready);                                 // 所有出站操作都需要完整商户配置
    const fields: Record<string, string> = {
      app_id: environment.ALIPAY_APP_ID!, method, format: 'JSON', charset: 'utf-8', // 商户身份包含在请求签名中
      sign_type: 'RSA2', version: '1.0', timestamp: shanghaiTime(), // 不依赖主机本地时区
      biz_content: JSON.stringify(content),                    // 每次请求只发送当前接口所需内容
    };
    if (notifyUrl) fields.notify_url = httpsUrl(notifyUrl).href; // 预下单才需要通知地址
    fields.sign = sign('RSA-SHA256', Buffer.from(canonical(fields, ['sign'])), privateKey!).toString('base64'); // 请求中sign_type参与签名
    const response = await send(httpsUrl(environment.ALIPAY_URL ?? 'https://openapi.alipay.com/gateway.do'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(10_000), redirect: 'error' }); // 拒绝跨地址重定向
    if (!response.ok) throw fail(502, `支付宝网关返回HTTP ${response.status}`); // 网络失败不是机构业务拒绝
    const raw = await body(response);                         // 保留原始响应对象的字节表示
    const parsed = json(raw);                                 // 不接受重复字段
    const name = `${method.replaceAll('.', '_')}_response`;    // 官方RPC响应名由请求接口名确定
    if (typeof parsed.sign !== 'string' || !verify('RSA-SHA256', Buffer.from(jsonPart(raw, name)), publicKey!, Buffer.from(parsed.sign, 'base64'))) throw fail(502, '支付宝响应签名无效'); // 验证后才能读取状态
    const result = parsed[name];                              // 只读取当前请求接口对应的签名对象
    if (result.code !== '10000') throw fail(502, `支付宝请求失败：${result.sub_msg ?? result.msg ?? '网关未说明原因'}`); // 不将失败响应当作未支付
    if ((result.app_id && result.app_id !== environment.ALIPAY_APP_ID) || (result.seller_id && result.seller_id !== environment.ALIPAY_SELLER_ID)) throw fail(502, '支付宝响应的应用或收款商户不匹配'); // 机构回传身份时再明确比对
    return result;                                            // 没有回传商户身份的RPC由已签名的app_id请求限定访问范围
  }

  // --- 核对退款查询中的固定字段 ---
  async function refundState(input: PaymentRefund) {
    within(input.amountCents, input.totalCents);                // 单次退款不能大于原付款
    const refund = await request('alipay.trade.fastpay.refund.query', { out_trade_no: shortId(input.invoiceId), trade_no: input.transactionId, out_request_no: shortId(input.refundId, 64) }); // 稳定请求号用于幂等查询
    if (refund.out_trade_no !== shortId(input.invoiceId) || refund.trade_no !== input.transactionId || refund.out_request_no !== shortId(input.refundId, 64) || cents(String(refund.refund_amount ?? '')) !== input.amountCents) throw fail(502, '支付宝退款查询的订单、退款号或金额不匹配'); // 不能用另一笔退款完成当前申请
    if (refund.refund_status && refund.refund_status !== 'REFUND_SUCCESS') throw fail(502, `支付宝退款状态需人工核对：${refund.refund_status}`); // 未知状态不猜成成功
    return { reference: input.refundId, status: refund.refund_status === 'REFUND_SUCCESS' ? 'succeeded' as const : 'pending' as const }; // 缺少完成状态则继续等待
  }

  return {
    name: '支付宝', configured: ready, acknowledgment: 'success', // 入账提交后再向机构应答
    async create(input) {
      const order = tradeId(input);                           // 外部订单号稳定且不超过32字符
      const payment = await request('alipay.trade.precreate', { out_trade_no: order, total_amount: yuan(input.amountCents), subject: input.subject, seller_id: environment.ALIPAY_SELLER_ID, timeout_express: '15m' }, input.notifyUrl); // 保留原当面付扫码方式
      if (payment.out_trade_no !== order || typeof payment.qr_code !== 'string') throw fail(502, '支付宝返回的订单或二维码不匹配'); // 不能展示其他订单的二维码
      return { qrCode: httpsUrl(payment.qr_code).href, reference: order }; // 前端将链接转换成二维码
    },
    async verify(input) {
      requireConfigured(ready);                               // 不接受未启用通道的通知
      const fields = form(input);                             // 支付宝通知使用POST表单
      if (fields.sign_type !== 'RSA2') throw fail(400, '支付宝通知必须使用RSA2'); // 不接受旧SHA1算法
      if (fields.app_id !== environment.ALIPAY_APP_ID || fields.seller_id !== environment.ALIPAY_SELLER_ID) throw fail(400, '支付宝应用或收款商户不匹配'); // 同时核对应用与收款人
      if (!fields.sign || !verify('RSA-SHA256', Buffer.from(canonical(fields, ['sign', 'sign_type'])), publicKey!, Buffer.from(fields.sign, 'base64'))) throw fail(400, '支付宝通知签名无效'); // 通知签名不包含sign_type
      if (!fields.trade_no || !fields.notify_id) throw fail(400, '支付宝通知缺少交易或通知编号'); // 确保机构流水可追踪
      if (fields.currency && fields.currency !== 'CNY') throw fail(400, '支付宝通知币种不匹配'); // 当面付处理人民币
      return { invoiceId: invoiceId(fields.out_trade_no ?? ''), transactionId: fields.trade_no, amountCents: cents(fields.total_amount ?? ''), currency: 'CNY', paid: ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(fields.trade_status) }; // 最终入账仍需账单金额核对
    },
    async query(input) {
      const payment = await request('alipay.trade.query', { out_trade_no: shortId(input.invoiceId) }); // 使用本地固定订单号限定查询
      if (payment.out_trade_no !== shortId(input.invoiceId) || (input.transactionId && payment.trade_no !== input.transactionId)) throw fail(502, '支付宝查询订单或交易号不匹配'); // 防止串用机构响应
      if (typeof payment.total_amount !== 'string' || (payment.currency && payment.currency !== 'CNY')) throw fail(502, '支付宝查询金额或币种无效'); // 不把浮点数当精确金额
      const paid = ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(payment.trade_status); // 等待付款和已关闭均不补入账
      if (paid && (typeof payment.trade_no !== 'string' || !payment.trade_no)) throw fail(502, '支付宝查询缺少交易号'); // 已付款必须有机构流水
      return { invoiceId: input.invoiceId, transactionId: payment.trade_no ?? '', amountCents: cents(payment.total_amount), currency: 'CNY', paid }; // 主业务复用正常入账事务
    },
    async refund(input) {
      within(input.amountCents, input.totalCents);              // 金额只按整数分处理
      const refund = await request('alipay.trade.refund', { out_trade_no: shortId(input.invoiceId), trade_no: input.transactionId, out_request_no: shortId(input.refundId, 64), refund_amount: yuan(input.amountCents), refund_reason: input.reason }); // 同一退款始终复用原请求号
      if (refund.out_trade_no !== shortId(input.invoiceId) || refund.trade_no !== input.transactionId || cents(String(refund.refund_fee ?? '')) !== input.amountCents) throw fail(502, '支付宝退款返回的订单或金额不匹配'); // 机构受理结果必须对应当前申请
      if (refund.fund_change === 'Y') return { reference: input.refundId, status: 'succeeded' }; // 机构明确资金已发生退款变化
      return refundState(input);                               // 幂等重试未再次变动资金时查询原退款结果
    },
    queryRefund: refundState,                                  // 后台可定期确认未完成的退款
  };
}

function canonical(fields: Record<string, string>, excluded: string[]) {
  return Object.keys(fields).sort().filter((name) => !excluded.includes(name) && fields[name] !== '').map((name) => `${name}=${fields[name]}`).join('&'); // 在URL编码前签原始字段
}

function shanghaiTime() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); // 网关约定北京时间
}
