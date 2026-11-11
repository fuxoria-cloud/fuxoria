/**
 * 虎皮椒：官方1.1下单、通知验签、全额退款，无法安全验证的查询明确拒绝。
 * 调用：const plugin = createPlugin(process.env); await plugin.refund!({invoiceId,transactionId,refundId,amountCents:'123',totalCents:'123',reason:'客户申请'});
 * 配置：HUPIJIAO_URL=https://api.xunhupay.com/payment/do.html、HUPIJIAO_APPID、HUPIJIAO_SECRET。
 * 官方查询示例的data对象没有定义签名序列化；此处不假定将其JSON.stringify后验签。
 * 协议：https://www.xunhupay.com/doc/api/pay.html 、search.html、refund.html。
 */
import { createHash, randomBytes } from 'node:crypto';          // 官方MD5签名与请求随机值
import type { PaymentPlugin } from '../index.js';              // 统一支付合同
import { cents, configured, equal, fail, form, fresh, httpsUrl, invoiceId, json, requireConfigured, shortId, tradeId, within, yuan } from '../utils/input.js'; // 机构边界检查
import { body } from '../utils/http.js';                       // 不无限读取机构正文

/** @param environment 商户配置。 @param send HTTP传输，离线测试可替换。 @returns 虎皮椒1.1实现。 */
export default function createPlugin(environment: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch): PaymentPlugin {
  const ready = configured([environment.HUPIJIAO_APPID, environment.HUPIJIAO_SECRET, environment.HUPIJIAO_URL]); // 网关地址由管理员显式配置

  // --- 请求机构并按官方文本规则验签 ---
  async function request(action: 'do' | 'query' | 'refund', content: Record<string, string>) {
    requireConfigured(ready);                                 // 不能使用空商户或示例密钥
    const fields: Record<string, string> = { ...content, appid: environment.HUPIJIAO_APPID!, time: Math.floor(Date.now() / 1000).toString(), nonce_str: randomBytes(16).toString('hex') }; // 每次请求独立时间与随机数
    fields.hash = signature(fields, environment.HUPIJIAO_SECRET!); // 所有非空文本字段均参与签名
    const gateway = httpsUrl(environment.HUPIJIAO_URL!);       // 操作限定在同一配置网关
    if (gateway.search || gateway.hash || !gateway.pathname.endsWith('/payment/do.html')) throw fail(503, '虎皮椒网关需填写完整的/payment/do.html地址'); // 不将签名发到模糊路径
    const url = new URL(`${action}.html`, new URL('./', gateway)); // 官方下单、查询、退款地址同目录
    const response = await send(url, { method: 'POST', headers: { 'content-type': action === 'do' ? 'application/json;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8' }, body: action === 'do' ? JSON.stringify(fields) : new URLSearchParams(fields), signal: AbortSignal.timeout(10_000), redirect: 'error' }); // 官方SDK查询使用表单，下单使用JSON
    if (!response.ok) throw fail(502, `虎皮椒网关返回HTTP ${response.status}`); // 网络失败不能当作订单未付款
    const parsed = json(await body(response));                 // 限额读取并拒绝重复JSON字段
    if (!Object.values(parsed).every((value) => typeof value === 'string' || typeof value === 'number')) throw fail(action === 'query' ? 501 : 502, action === 'query' ? '虎皮椒查询返回嵌套对象，官方协议未定义其签名序列化，无法安全自动补入账' : '虎皮椒返回不符合官方1.1文本签名协议'); // 不编造嵌套签名算法
    const returned = Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)])); // 官方数字字段按文本参与签名
    if (!equal(returned.hash ?? '', signature(returned, environment.HUPIJIAO_SECRET!))) throw fail(502, '虎皮椒返回签名无效'); // 返回的付款与退款地址都要验签
    if (returned.errcode !== '0') throw fail(502, `虎皮椒请求失败：${returned.errmsg ?? '网关未说明原因'}`); // 不把机构错误当成功
    if (returned.appid && returned.appid !== environment.HUPIJIAO_APPID) throw fail(502, '虎皮椒返回应用不匹配'); // 机构回传身份时明确核对
    return returned;                                          // 没回传appid的退款响应由已签名请求限定商户范围
  }

  return {
    name: '虎皮椒', configured: ready, acknowledgment: 'success', // 正常入账事务提交后才返回成功应答
    async create(input) {
      const order = tradeId(input);                           // 固定32位外部订单号
      if (Buffer.byteLength(input.subject) > 127 || /[%\p{Extended_Pictographic}]/u.test(input.subject)) throw fail(400, '虎皮椒标题需少于128字节且不能含表情或百分号'); // 官方标题限制
      const returned = await request('do', { version: '1.1', trade_order_id: order, total_fee: yuan(input.amountCents), title: input.subject, notify_url: httpsUrl(input.notifyUrl).href, return_url: httpsUrl(input.returnUrl).href }); // 以精确元文本下单
      if (!returned.url && !returned.url_qrcode) throw fail(502, '虎皮椒未返回支付地址'); // 空响应不等于下单成功
      return { url: returned.url ? httpsUrl(returned.url).href : undefined, qrCode: returned.url_qrcode ? httpsUrl(returned.url_qrcode).href : undefined, reference: returned.openid ?? order }; // 官方1.1地址位于顶层字段
    },
    async verify(input) {
      requireConfigured(ready);                               // 未启用通道不接收通知
      const fields = form(input);                             // 回调是POST表单
      if (fields.appid !== environment.HUPIJIAO_APPID) throw fail(400, '虎皮椒应用不匹配'); // 密钥相同也不能跨应用入账
      if (!equal(fields.hash ?? '', signature(fields, environment.HUPIJIAO_SECRET!))) throw fail(400, '虎皮椒通知签名无效'); // hash自己不参与签名
      fresh(fields.time ?? '', 172_800);                       // 给异步重试保留48小时窗口
      if (!fields.transaction_id || !fields.nonce_str) throw fail(400, '虎皮椒通知缺少交易号或随机值'); // 机构流水用于数据库去重
      return { invoiceId: invoiceId(fields.trade_order_id ?? ''), transactionId: fields.transaction_id, amountCents: cents(fields.total_fee ?? ''), currency: 'CNY', paid: fields.status === 'OD' }; // 退款通知不能再入一笔付款
    },
    async query(input) {
      const returned = await request('query', { out_trade_order: shortId(input.invoiceId) }); // 参数名与下单trade_order_id不同，按官方查询定义
      const data = returned.data ? json(Buffer.from(returned.data)) : returned; // 只有原始文本字段通过hash验证后才允许解析
      if (data.appid !== environment.HUPIJIAO_APPID || data.trade_order_id !== shortId(input.invoiceId) || typeof data.total_fee !== 'string' || typeof data.transaction_id !== 'string') throw fail(501, '虎皮椒查询结果缺少可核对的应用、订单、金额或机构交易号，不能自动补入账'); // 不能用本地期望值冒充机构确认
      if (input.transactionId && data.transaction_id !== input.transactionId) throw fail(502, '虎皮椒查询的交易号不匹配'); // 不串用另一笔支付
      if (!['OD', 'WP', 'CD'].includes(data.status)) throw fail(502, '虎皮椒查询状态不支持'); // 不对未知状态猜测付款成功
      return { invoiceId: input.invoiceId, transactionId: data.transaction_id, amountCents: cents(data.total_fee), currency: 'CNY', paid: data.status === 'OD' }; // 仅完整验签结果可进入正常入账事务
    },
    async refund(input) {
      within(input.amountCents, input.totalCents);              // 先验证整数金额与原付款范围
      if (input.amountCents !== input.totalCents) throw fail(422, '虎皮椒官方1.1接口只支持全额退款'); // 协议没有部分退款金额参数
      if (Buffer.byteLength(input.reason) > 80) throw fail(400, '虎皮椒退款原因不能超过80字节'); // 官方退款原因长度限制
      const result = await request('refund', { trade_order_id: shortId(input.invoiceId), reason: input.reason }); // 接口按原订单全额退款，没有商户退款号参数
      if (result.trade_order_id !== shortId(input.invoiceId) || result.transaction_id !== input.transactionId || cents(result.refund_fee ?? '') !== input.amountCents || !result.out_refund_no) throw fail(502, '虎皮椒退款返回订单、交易号或金额不匹配'); // 不使用本地预期金额补齐机构结果
      if (result.refund_status === 'CD') return { reference: result.out_refund_no, status: 'succeeded' }; // 机构明确已退款
      if (result.refund_status === 'RD') return { reference: result.out_refund_no, status: 'pending' }; // 机构已受理，仍未完成
      throw fail(409, `虎皮椒退款尚未成功：${result.refund_status ?? '状态缺失'}`); // OD和UD均不能当已退款
    },
    async queryRefund() {
      requireConfigured(ready);                               // 管理员先确认通道启用
      throw fail(501, '虎皮椒1.1没有独立退款查询接口，待处理退款需从商户后台核对'); // 查询订单CD同时表示已取消，不能拿它推断退款完成
    },
  };
}

function signature(fields: Record<string, string>, key: string) {
  const text = Object.keys(fields).sort().filter((name) => name !== 'hash' && fields[name] !== '').map((name) => `${name}=${fields[name]}`).join('&'); // 官方PHP直接拼原始值，并非HMAC
  return createHash('md5').update(text + key).digest('hex');     // 旧协议规定的末尾拼密钥MD5
}
