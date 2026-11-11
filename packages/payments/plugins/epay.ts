/**
 * 易支付：兼容V1收银台与通知，V2提供RSA验签查单和幂等退款。
 * 调用：const plugin = createPlugin(process.env); await plugin.query!({invoiceId});
 * V1配置：EPAY_URL=https://你的网关/submit.php、EPAY_PID、EPAY_KEY。
 * V2配置：EPAY_VERSION=2、EPAY_URL=https://你的网关/api/pay/submit、EPAY_PID、EPAY_PRIVATE_KEY、EPAY_PUBLIC_KEY。
 * 协议：https://api.zhunfu.cn/doc/index.html ，V1无签名的查询和退款响应不用于自动改账。
 */
import { createHash, sign, verify } from 'node:crypto';          // V1规定MD5，V2规定RSA-SHA256
import type { PaymentPlugin, PaymentRefund } from '../index.js'; // 主业务共用的支付合同
import { cents, configured, equal, fail, form, fresh, httpsUrl, invoiceId, json, requireConfigured, shortId, tradeId, within, yuan } from '../utils/input.js'; // 支付机构边界检查
import { body } from '../utils/http.js';                       // 有限大小的外部响应

/** @param environment 商户配置。 @param send HTTP传输，测试可替换。 @returns 易支付对应版本实现。 */
export default function createPlugin(environment: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch): PaymentPlugin {
  const version = environment.EPAY_VERSION ?? '1';             // 已有V1商户不会被静默切换协议
  if (!['1', '2'].includes(version)) throw fail(503, '易支付版本只能是1或2'); // 配置错误必须明确反馈
  const ready = configured(version === '2' ? [environment.EPAY_URL, environment.EPAY_PID, environment.EPAY_PRIVATE_KEY, environment.EPAY_PUBLIC_KEY] : [environment.EPAY_URL, environment.EPAY_PID, environment.EPAY_KEY]); // 各版本的密钥要求不同
  const privateKey = environment.EPAY_PRIVATE_KEY?.replace(/\\n/g, '\n'); // V2商户私钥
  const publicKey = environment.EPAY_PUBLIC_KEY?.replace(/\\n/g, '\n'); // V2平台公钥，与商户公钥不是同一把

  // --- 签名V2请求并验证返回 ---
  async function request(action: 'query' | 'refund' | 'refundquery', content: Record<string, string>) {
    requireConfigured(ready);                                 // 必须先配置该版本对应的商户信息
    if (version !== '2') throw fail(501, '易支付V1查询和退款响应没有签名，自动查单退款需配置RSA版V2'); // 不用无签名响应触发资金变动
    const fields: Record<string, string> = { ...content, pid: environment.EPAY_PID!, timestamp: Math.floor(Date.now() / 1000).toString(), sign_type: 'RSA' }; // 请求时间和商户身份均签入
    fields.sign = sign('RSA-SHA256', Buffer.from(canonical(fields)), privateKey!).toString('base64'); // V2签名不包含sign_type
    const gateway = httpsUrl(environment.EPAY_URL!);           // 复用同一商户网关，不接受调用方提供地址
    if (gateway.search || gateway.hash || !gateway.pathname.endsWith('/api/pay/submit')) throw fail(503, '易支付V2网关需填写完整的/api/pay/submit地址'); // 查询接口必须位于同一官方API路径
    const url = new URL(action, new URL('./', gateway));        // submit的同级地址为query/refund/refundquery
    const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(10_000), redirect: 'error' }); // 不跟随可能泄漏签名的重定向
    if (!response.ok) throw fail(502, `易支付网关返回HTTP ${response.status}`); // 网络失败不能当作订单不存在
    const parsed = json(await body(response));                 // 返回值限制大小且禁止重复字段
    if (!Object.values(parsed).every((value) => typeof value === 'string' || typeof value === 'number')) throw fail(502, '易支付返回含不支持的非文本业务字段'); // 不对未定义的对象序列化方式猜签名
    const returned = Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)])); // 数字状态按原协议文本签名
    if (returned.sign_type !== 'RSA' || !returned.sign || !verify('RSA-SHA256', Buffer.from(canonical(returned)), publicKey!, Buffer.from(returned.sign, 'base64'))) throw fail(502, '易支付返回签名无效'); // 只使用平台公钥验签
    fresh(returned.timestamp ?? '');                           // 拒绝被重放的旧查单或退款返回
    if (returned.code !== '0') throw fail(502, `易支付请求失败：${returned.msg ?? '网关未说明原因'}`); // 机构错误不伪造未付款或退款成功
    if (returned.pid && returned.pid !== environment.EPAY_PID) throw fail(502, '易支付返回商户不匹配'); // 返回了商户身份就必须一致
    return returned;                                           // 没有pid的退款响应由签名商户请求限定范围
  }

  // --- 通过退款号查最终状态 ---
  async function refundState(input: PaymentRefund) {
    within(input.amountCents, input.totalCents);                // 不允许金额超出原付款
    const result = await request('refundquery', { out_refund_no: shortId(input.refundId, 64) }); // 使用原退款号确认，不生成新申请
    if (result.out_refund_no !== shortId(input.refundId, 64) || result.out_trade_no !== shortId(input.invoiceId) || result.trade_no !== input.transactionId || cents(result.money ?? '') !== input.amountCents || !result.refund_no) throw fail(502, '易支付退款查询订单、退款号或金额不匹配'); // 机构结果必须逐项绑定本地退款
    if (result.status === '1') return { reference: result.refund_no, status: 'succeeded' as const }; // 仅机构明确成功才记成功
    throw fail(409, `易支付退款尚未确认成功：${result.msg ?? result.status ?? '状态缺失'}`); // V2查询只定义失败与成功，不猜第三种状态
  }

  return {
    name: version === '2' ? '易支付 RSA' : '易支付', configured: ready, acknowledgment: 'success', // 文件名仍是固定插件标识epay
    async create(input) {
      requireConfigured(ready);                               // 未配置时不产生可付款地址
      const order = tradeId(input);                           // 固定账单号与精确整数金额
      const fields: Record<string, string> = { pid: environment.EPAY_PID!, out_trade_no: order, notify_url: httpsUrl(input.notifyUrl).href, return_url: httpsUrl(input.returnUrl).href, name: input.subject, money: yuan(input.amountCents) }; // 回调地址由主业务提供
      if (environment.EPAY_TYPE) fields.type = environment.EPAY_TYPE; // 未指定时交收银台选择
      const url = httpsUrl(environment.EPAY_URL!);             // 管理员配置唯一支付网关
      if (url.search || url.hash) throw fail(400, '易支付网关地址不能预填查询参数'); // 防止同名字段覆盖
      if (version === '2') fields.timestamp = Math.floor(Date.now() / 1000).toString(); // V2请求必须带时间戳
      fields.sign = version === '2' ? sign('RSA-SHA256', Buffer.from(canonical(fields)), privateKey!).toString('base64') : signature(fields, environment.EPAY_KEY!); // 各版本按自己的协议签名
      fields.sign_type = version === '2' ? 'RSA' : 'MD5';        // 不允许算法混用或降级
      url.search = new URLSearchParams(fields).toString();     // 签名之后才做URL编码
      return { url: url.href, reference: order };               // 浏览器返回页不触发入账
    },
    async verify(input) {
      requireConfigured(ready);                               // 未启用通道拒绝回调
      const fields = form(input);                             // GET查询字段重复由HTTP入口拒绝
      if (fields.pid !== environment.EPAY_PID) throw fail(400, '易支付商户不匹配'); // 密钥之外再核对收款商户
      if (version === '2') {
        if (fields.sign_type !== 'RSA' || !fields.sign || !verify('RSA-SHA256', Buffer.from(canonical(fields)), publicKey!, Buffer.from(fields.sign, 'base64'))) throw fail(400, '易支付通知签名无效'); // 用平台公钥验证V2通知
        fresh(fields.timestamp ?? '', 172_800);                // 保留48小时供机构异步补偿
      } else {
        if (fields.sign_type !== 'MD5') throw fail(400, '易支付签名类型不支持'); // V1不能混入RSA签名
        if (!equal(fields.sign ?? '', signature(fields, environment.EPAY_KEY!))) throw fail(400, '易支付通知签名无效'); // V1按商户密钥校验
      }
      if (!fields.trade_no) throw fail(400, '易支付通知缺少交易号'); // 数据库使用机构流水去重
      return { invoiceId: invoiceId(fields.out_trade_no ?? ''), transactionId: fields.trade_no, amountCents: cents(fields.money ?? ''), currency: 'CNY', paid: fields.trade_status === 'TRADE_SUCCESS' }; // 仅付款成功可补入账
    },
    async query(input) {
      const result = await request('query', { out_trade_no: shortId(input.invoiceId) }); // V1会明确报501，V2返回已验签内容
      if (result.pid !== environment.EPAY_PID || result.out_trade_no !== shortId(input.invoiceId) || (input.transactionId && result.trade_no !== input.transactionId)) throw fail(502, '易支付查询商户、订单或交易号不匹配'); // 主动查询也必须核对商户身份
      if (!result.trade_no || !['0', '1', '2', '3', '4'].includes(result.status)) throw fail(502, '易支付查询状态或交易号无效'); // 未知状态不能猜作已付款
      return { invoiceId: input.invoiceId, transactionId: result.trade_no, amountCents: cents(result.money ?? ''), currency: 'CNY', paid: result.status === '1' }; // 已退款与冻结状态不会补入账
    },
    async refund(input) {
      within(input.amountCents, input.totalCents);              // 金额检查不使用浮点数
      const result = await request('refund', { out_trade_no: shortId(input.invoiceId), trade_no: input.transactionId, out_refund_no: shortId(input.refundId, 64), money: yuan(input.amountCents) }); // 固定退款号保证接口幂等
      if (result.out_refund_no !== shortId(input.refundId, 64) || result.trade_no !== input.transactionId || cents(result.money ?? '') !== input.amountCents || !result.refund_no) throw fail(502, '易支付退款返回订单、退款号或金额不匹配'); // 受理结果必须与请求一致
      return refundState(input);                               // 再通过退款查询确认最终结果
    },
    queryRefund: refundState,                                  // 未确认的退款可按原申请继续核对
  };
}

function canonical(fields: Record<string, string>) {
  return Object.keys(fields).sort().filter((name) => !['sign', 'sign_type'].includes(name) && fields[name] !== '').map((name) => `${name}=${fields[name]}`).join('&'); // V1与V2都对原值签名，不进行URL编码
}

function signature(fields: Record<string, string>, key: string) {
  return createHash('md5').update(canonical(fields) + key).digest('hex'); // V1协议规定末尾直接拼商户密钥
}
