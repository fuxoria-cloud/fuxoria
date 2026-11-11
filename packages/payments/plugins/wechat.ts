/**
 * 微信Native支付：APIv3下单、通知解密、主动查单与幂等退款。
 * 调用：const plugin = createPlugin(process.env); await plugin.query!({invoiceId});
 * 退款：await plugin.refund!({invoiceId,transactionId,refundId,amountCents:'100',totalCents:'123',reason:'客户申请'});
 * 配置：WECHAT_APP_ID、WECHAT_MCH_ID、WECHAT_SERIAL、WECHAT_PRIVATE_KEY、WECHAT_API_V3_KEY，另配置可信平台公钥。
 * 平台公钥用WECHAT_PLATFORM_SERIAL + WECHAT_PLATFORM_PUBLIC_KEY，轮换时可用WECHAT_PLATFORM_KEYS_JSON登记多把。
 * 协议：https://pay.wechatpay.cn/doc/v3/merchant/4012791880 ，只支持普通直连商户。
 */
import { createDecipheriv, randomBytes, sign, verify } from 'node:crypto'; // 官方RSA签名与AES-GCM认证解密
import type { PaymentNotification, PaymentPlugin, PaymentRefund, RefundResult } from '../index.js'; // 主业务共用的协议合同
import { configured, fail, fresh, httpsUrl, invoiceId, json, requireConfigured, shortId, tradeId, within } from '../utils/input.js'; // 支付机构边界检查
import { body } from '../utils/http.js';                       // 外部响应按64KiB限制读取

/** @param environment 商户和平台配置。 @param send HTTP传输，测试可替换。 @returns 微信APIv3实现。 */
export default function createPlugin(environment: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch): PaymentPlugin {
  const publicKeys = keys(environment);                        // 按本地可信标识选择公钥，允许新旧公钥并存
  const ready = configured([environment.WECHAT_APP_ID, environment.WECHAT_MCH_ID, environment.WECHAT_SERIAL, environment.WECHAT_PRIVATE_KEY, environment.WECHAT_API_V3_KEY]) && publicKeys.size > 0; // 商户和验签配置缺一不可
  const privateKey = environment.WECHAT_PRIVATE_KEY?.replace(/\\n/g, '\n'); // 保留PEM密钥换行

  // --- 签名请求并验证平台响应 ---
  async function request(method: 'GET' | 'POST', path: string, content?: Record<string, unknown>) {
    requireConfigured(ready);                                 // 所有出站操作都必须配置完整商户身份
    const raw = content ? JSON.stringify(content) : '';        // GET的签名正文为空字符串
    const time = Math.floor(Date.now() / 1000).toString();       // 签名使用秒时间戳
    const nonce = randomBytes(16).toString('hex');              // 每个HTTP请求有独立随机值
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${time}\n${nonce}\n${raw}\n`), privateKey!).toString('base64'); // 路径包含实际发送的查询串
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${environment.WECHAT_MCH_ID}",nonce_str="${nonce}",timestamp="${time}",serial_no="${environment.WECHAT_SERIAL}",signature="${signature}"`; // 商户证书标识与签名一起发送
    const response = await send(`https://api.mch.weixin.qq.com${path}`, { method, headers: { authorization, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Yunzou/0.1' }, body: method === 'POST' ? raw : undefined, signal: AbortSignal.timeout(10_000), redirect: 'error' }); // 固定官方域名且拒绝重定向
    const returned = await body(response);                     // 完整原始正文用于验签
    signed({ headers: Object.fromEntries(response.headers.entries()), rawBody: returned, query: {} }, publicKeys); // 查单与退款响应同样需要平台签名
    const result = json(returned);                             // 签名后检查严格JSON与重复字段
    if (!response.ok) throw fail(502, `微信支付请求失败：${result.message ?? response.status}`); // 超时或错误不能直接改成付款失败
    return result;                                            // 只有通过平台验签的内容进入业务判断
  }

  // --- 读取已验签的付款内容 ---
  function paymentResult(payment: Record<string, any>) {
    if (payment.mchid !== environment.WECHAT_MCH_ID || payment.appid !== environment.WECHAT_APP_ID) throw fail(400, '微信通知的商户或应用不匹配'); // 严格核对签约收款身份
    if (!payment.amount || !Number.isSafeInteger(payment.amount.total) || payment.amount.total <= 0 || payment.amount.currency !== 'CNY') throw fail(400, '微信通知的金额或币种无效'); // 使用订单总额，不使用优惠后的付款人金额
    if (typeof payment.out_trade_no !== 'string') throw fail(400, '微信通知缺少订单号'); // 每个结果必须定位到固定账单
    const paid = payment.trade_state === 'SUCCESS';            // 未支付、关闭和退款状态不会补入账
    if (paid && (typeof payment.transaction_id !== 'string' || !payment.transaction_id)) throw fail(400, '微信通知缺少交易号'); // 已付款必须有机构唯一流水
    return { invoiceId: invoiceId(payment.out_trade_no), transactionId: payment.transaction_id ?? '', amountCents: String(payment.amount.total), currency: payment.amount.currency as string, paid }; // 账本事务继续核对本地金额
  }

  // --- 读取已验签的退款内容 ---
  function refundResult(refund: Record<string, any>, input: PaymentRefund): RefundResult {
    if (refund.out_trade_no !== shortId(input.invoiceId) || refund.transaction_id !== input.transactionId || refund.out_refund_no !== shortId(input.refundId, 64)) throw fail(502, '微信退款返回的订单或退款号不匹配'); // 不串用另一笔退款的结果
    if (!refund.refund_id || !refund.amount || refund.amount.currency !== 'CNY' || !Number.isSafeInteger(refund.amount.refund) || !Number.isSafeInteger(refund.amount.total) || String(refund.amount.refund) !== input.amountCents || String(refund.amount.total) !== input.totalCents) throw fail(502, '微信退款返回的金额或币种不匹配'); // 机构确认金额必须逐分相等
    if (refund.status === 'SUCCESS') return { reference: refund.refund_id, status: 'succeeded' }; // 只有明确完成才能记作退款成功
    if (refund.status === 'PROCESSING') return { reference: refund.refund_id, status: 'pending' }; // 受理不代表到账
    throw fail(409, `微信退款需人工处理：${refund.status ?? '状态缺失'}`); // CLOSED和ABNORMAL不伪造成功
  }

  // --- 按原退款号查最终状态 ---
  async function refundState(input: PaymentRefund) {
    within(input.amountCents, input.totalCents);                // 金额在机构边界检查一次
    const result = await request('GET', `/v3/refund/domestic/refunds/${shortId(input.refundId, 64)}`); // 幂等重试查询原退款单
    return refundResult(result, input);                        // 平台验签与订单金额核对均通过后才返回
  }

  return {
    name: '微信支付', configured: ready, acknowledgment: '{"code":"SUCCESS","message":"成功"}', // 业务入账提交后再成功应答
    async create(input) {
      const order = tradeId(input);                           // UUID去掉连字符以满足订单号限制
      if (BigInt(input.amountCents) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(400, '微信支付金额超出整数安全范围'); // JSON数字不能超过精确整数范围
      const payment = await request('POST', '/v3/pay/transactions/native', { appid: environment.WECHAT_APP_ID, mchid: environment.WECHAT_MCH_ID, description: input.subject, out_trade_no: order, notify_url: httpsUrl(input.notifyUrl).href, amount: { total: Number(input.amountCents), currency: input.currency } }); // 金额转换前已经检查范围
      if (typeof payment.code_url !== 'string' || !payment.code_url.startsWith('weixin://wxpay/')) throw fail(502, '微信支付没有返回有效二维码'); // 只接受官方扫码协议
      return { qrCode: payment.code_url, reference: order };    // 二维码交前端展示
    },
    async verify(input) {
      requireConfigured(ready);                               // 未配置通道不处理通知
      signed(input, publicKeys);                              // 先验证平台对原始正文的签名
      const event = json(input.rawBody);                       // 有效签名也不允许重复JSON字段
      if (event.event_type !== 'TRANSACTION.SUCCESS' || event.resource_type !== 'encrypt-resource' || event.resource?.algorithm !== 'AEAD_AES_256_GCM') throw fail(400, '微信通知不是支持的付款成功事件'); // 退款事件使用独立的退款查询
      return paymentResult(decrypt(event.resource, environment.WECHAT_API_V3_KEY!)); // 认证解密后核对商户与金额
    },
    async query(input) {
      const payment = await request('GET', `/v3/pay/transactions/out-trade-no/${shortId(input.invoiceId)}?mchid=${encodeURIComponent(environment.WECHAT_MCH_ID!)}`); // 查询签名绑定原订单和商户
      const result = paymentResult(payment);                  // 与通知复用同一商户与金额检查
      if (result.invoiceId !== input.invoiceId || (input.transactionId && result.transactionId !== input.transactionId)) throw fail(502, '微信查询返回的订单或交易号不匹配'); // 防止返回内容与请求串单
      return result;                                          // 未付款明确返回paid:false
    },
    async refund(input) {
      within(input.amountCents, input.totalCents);              // 单次退款不能超过原付款
      if (BigInt(input.totalCents) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(400, '微信退款金额超出整数安全范围'); // 向机构发送安全整数
      const result = await request('POST', '/v3/refund/domestic/refunds', { transaction_id: input.transactionId, out_refund_no: shortId(input.refundId, 64), reason: input.reason, amount: { refund: Number(input.amountCents), total: Number(input.totalCents), currency: 'CNY' } }); // 同一申请固定使用同一个退款号
      const state = refundResult(result, input);               // 请求响应仍需核对原订单与金额
      if (state.status === 'succeeded') return refundState(input); // 微信要求用查单或回调确认最终退款成功
      return state;                                           // PROCESSING由后台稍后继续查原退款单
    },
    queryRefund: refundState,                                  // 调度程序用它推进待确认退款
  };
}

function keys(environment: NodeJS.ProcessEnv) {
  const result = new Map<string, string>();                    // 只持有运维预先信任的公钥
  if (environment.WECHAT_PLATFORM_SERIAL && environment.WECHAT_PLATFORM_PUBLIC_KEY) result.set(environment.WECHAT_PLATFORM_SERIAL, environment.WECHAT_PLATFORM_PUBLIC_KEY.replace(/\\n/g, '\n')); // 保持单公钥配置兼容
  if (!environment.WECHAT_PLATFORM_KEYS_JSON) return result;  // 没有轮换配置就使用单公钥
  const parsed = json(Buffer.from(environment.WECHAT_PLATFORM_KEYS_JSON)); // 配置也拒绝歧义JSON
  for (const [serial, value] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(serial) || typeof value !== 'string' || !value.trim()) throw fail(503, '微信平台公钥集合配置无效'); // 不允许伪造的标识或空公钥
    if (result.has(serial) && result.get(serial) !== value.replace(/\\n/g, '\n')) throw fail(503, '微信平台同一公钥标识配置了不同公钥'); // 轮换不静默覆盖已有信任
    result.set(serial, value.replace(/\\n/g, '\n'));           // 新旧标识并存，通知按serial选取
  }
  return result;                                              // 配置之外的标识一律拒绝
}

function signed(input: PaymentNotification, publicKeys: Map<string, string>) {
  if (input.rawBody.length > 65_536) throw fail(413, '微信支付通知超过64KiB'); // 验签前控制输入成本
  const headers = Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value])); // HTTP字段名不区分大小写
  const values = [headers['wechatpay-timestamp'], headers['wechatpay-nonce'], headers['wechatpay-signature'], headers['wechatpay-serial']]; // 平台验签需要四个头部
  if (values.some((value) => typeof value !== 'string' || !value || value.length > 1024)) throw fail(400, '微信支付签名请求头缺失或重复'); // 拒绝数组与异常长头部
  const [time, nonce, signature, serial] = values as string[]; // 边界已确认四个值都是单个字符串
  const publicKey = publicKeys.get(serial);                    // 请求只能选已受信任的标识
  if (!publicKey) throw fail(400, '微信支付平台公钥标识不匹配'); // 不在线下载攻击者指定的公钥
  fresh(time);                                                // 官方建议拒绝五分钟前的签名
  if (!verify('RSA-SHA256', Buffer.concat([Buffer.from(`${time}\n${nonce}\n`), input.rawBody, Buffer.from('\n')]), publicKey, Buffer.from(signature, 'base64'))) throw fail(400, '微信支付签名无效'); // 正文保持逐字节一致
}

function decrypt(resource: Record<string, unknown>, key: string) {
  if (Buffer.byteLength(key) !== 32) throw fail(503, '微信支付APIv3密钥必须是32字节'); // 配置错误由管理员处理
  if (typeof resource.nonce !== 'string' || typeof resource.ciphertext !== 'string' || (resource.associated_data !== undefined && typeof resource.associated_data !== 'string')) throw fail(400, '微信通知的加密资源格式无效'); // 密文属于外部边界
  try {
    const ciphertext = Buffer.from(resource.ciphertext, 'base64'); // 密文末尾包含16字节GCM认证标签
    if (ciphertext.length <= 16) throw fail(400, '微信通知密文过短'); // 没有密文不能解密
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(resource.nonce)); // APIv3密钥独立于RSA证书
    decipher.setAuthTag(ciphertext.subarray(-16));             // 最后16字节作为认证标签
    decipher.setAAD(Buffer.from((resource.associated_data as string | undefined) ?? '')); // 附加数据按机构原值认证
    return json(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])); // 标签错误则整份通知无效
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error; // 保留已经明确的输入错误
    throw fail(400, '微信通知密文验证失败');                  // 不泄漏密码学内部错误
  }
}
