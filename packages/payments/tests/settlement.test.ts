/**
 * 主动查单与退款离线验证：验证机构签名、固定退款号、金额绑定和异步状态。
 * 执行：npm run test --workspace=@fuxoria/payments。
 * 机构响应全部由测试临时密钥签名，不调用真实收款或退款接口。
 */
import test from 'node:test';                                  // 使用标准测试运行器
import assert from 'node:assert/strict';                        // 检查业务状态与拒绝原因
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'; // 临时机构与商户签名
import type { PaymentRefund } from '../index.js';              // 测试与主业务共用退款合同
import alipay from '../plugins/alipay.js';                     // 支付宝RPC查询与退款
import wechat from '../plugins/wechat.js';                     // 微信v3查询与退款
import epay from '../plugins/epay.js';                         // 易支付V1限制与V2查询退款
import hupijiao from '../plugins/hupijiao.js';                  // 虎皮椒全额退款与协议限制

const invoice = '75c90e16-fb30-4abf-b31c-f080005d24ce';        // 固定账单编号
const trade = invoice.replaceAll('-', '');                    // 固定机构商户订单号
const refundId = '9fc120bf-a27f-4a82-9303-a7e125fa31d1';      // 每笔退款一个稳定编号
const refund: PaymentRefund = { invoiceId: invoice, transactionId: 'transaction-1', refundId, amountCents: '20', totalCents: '123', reason: '客户申请' }; // 退款金额以整数分表示
const platform = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); // 本轮测试的机构密钥
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); // 独立商户密钥，避免用错公私钥也通过测试
const aliEnvironment = { ALIPAY_APP_ID: 'app-1', ALIPAY_SELLER_ID: 'seller-1', ALIPAY_PRIVATE_KEY: merchant.privateKey, ALIPAY_PUBLIC_KEY: platform.publicKey }; // 无真实商户密钥
const wxEnvironment = { WECHAT_APP_ID: 'app-1', WECHAT_MCH_ID: 'merchant-1', WECHAT_SERIAL: 'merchant-key', WECHAT_PRIVATE_KEY: merchant.privateKey, WECHAT_API_V3_KEY: '0123456789abcdef0123456789abcdef', WECHAT_PLATFORM_SERIAL: 'platform-1', WECHAT_PLATFORM_PUBLIC_KEY: platform.publicKey }; // 微信测试配置

function canonical(fields: Record<string, string>, excluded = ['sign', 'sign_type']) {
  return Object.keys(fields).sort().filter((name) => !excluded.includes(name) && fields[name] !== '').map((name) => `${name}=${fields[name]}`).join('&'); // 根据官方排序规则构造测试机构数据
}

function aliResponse(method: string, content: Record<string, unknown>) {
  const raw = JSON.stringify({ code: '10000', ...content });    // 机构签名的业务对象
  const signature = sign('RSA-SHA256', Buffer.from(raw), platform.privateKey).toString('base64'); // 机构公钥应验证此签名
  return new Response(`{"${method.replaceAll('.', '_')}_response":${raw},"sign":"${signature}"}`); // 保留原始对象文本
}

function wxResponse(content: Record<string, unknown>, serial = 'platform-1', key = platform.privateKey) {
  const raw = JSON.stringify(content);                         // 机构对原始响应字节签名
  const time = Math.floor(Date.now() / 1000).toString();        // 新响应使用当前时间
  const signature = sign('RSA-SHA256', Buffer.from(`${time}\nresponse-nonce\n${raw}\n`), key).toString('base64'); // 与官方响应换行格式一致
  return new Response(raw, { headers: { 'wechatpay-timestamp': time, 'wechatpay-nonce': 'response-nonce', 'wechatpay-signature': signature, 'wechatpay-serial': serial } }); // 四个验签头部
}

test('支付宝主动查询验证机构签名、商户身份和原订单', async () => {
  let returned = { out_trade_no: trade, trade_no: 'transaction-1', total_amount: '1.23', trade_status: 'TRADE_SUCCESS', seller_id: 'seller-1' }; // 已付款查询结果
  const plugin = alipay(aliEnvironment, (async (_url, options) => {
    const request = Object.fromEntries(new URLSearchParams(String(options!.body))); // 检查真实下发的请求字段
    assert.equal(request.method, 'alipay.trade.query');         // 没有改走前端付款结果
    assert.equal(JSON.parse(request.biz_content).out_trade_no, trade); // 查询绑定本地原订单
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(request, ['sign'])), merchant.publicKey, Buffer.from(request.sign, 'base64')), true); // 请求用商户私钥签名
    return aliResponse(request.method, returned);               // 响应用机构私钥签名
  }) as typeof fetch);
  assert.deepEqual(await plugin.query!({ invoiceId: invoice }), { invoiceId: invoice, transactionId: 'transaction-1', amountCents: '123', currency: 'CNY', paid: true }); // 查单结果可以复用正常入账事务
  returned = { ...returned, seller_id: 'wrong-seller' };        // 即使机构签名有效，身份仍不属于本商户
  await assert.rejects(plugin.query!({ invoiceId: invoice }), /收款商户不匹配/); // 不跨商户补入账
  returned = { ...returned, seller_id: 'seller-1', out_trade_no: 'different' }; // 平台串回另一笔订单
  await assert.rejects(plugin.query!({ invoiceId: invoice }), /订单或交易号不匹配/); // 必须绑定本地原订单
});

test('支付宝退款保持原申请号，重复请求用查询结果确认', async () => {
  let calls = 0;                                              // 统计实际退款操作，查询另行验证
  const plugin = alipay(aliEnvironment, (async (_url, options) => {
    const request = Object.fromEntries(new URLSearchParams(String(options!.body))); // 读取实际RPC调用
    const content = JSON.parse(request.biz_content);            // 验证商户侧幂等字段
    assert.equal(content.out_request_no, refundId.replaceAll('-', '')); // 重试不能更换退款号
    if (request.method === 'alipay.trade.refund') {
      calls += 1;                                             // 一次初始申请与一次原号重试
      assert.equal(content.refund_amount, '0.20');              // 退款仍以精确元文本传给支付宝
      return aliResponse(request.method, { out_trade_no: trade, trade_no: 'transaction-1', refund_fee: '0.20', fund_change: calls === 1 ? 'Y' : 'N' }); // 第二次没有新增资金变动
    }
    assert.equal(request.method, 'alipay.trade.fastpay.refund.query'); // 原号重试通过独立查询确认
    return aliResponse(request.method, { out_trade_no: trade, trade_no: 'transaction-1', out_request_no: refundId.replaceAll('-', ''), refund_amount: '0.20', refund_status: 'REFUND_SUCCESS' }); // 返回原退款的最终成功状态
  }) as typeof fetch);
  assert.equal((await plugin.refund!(refund)).status, 'succeeded'); // 首次机构明确退款完成
  assert.equal((await plugin.refund!(refund)).status, 'succeeded'); // 重试不会误报第二次资金变动
  await assert.rejects(plugin.refund!({ ...refund, amountCents: '124' }), /不能超过/); // 本地越界请求不会发往机构
  assert.equal(calls, 2);                                      // 越界请求没有产生第三次调用
});

test('微信GET查询签名包含查询串，并核对收款商户', async () => {
  let returned = { appid: 'app-1', mchid: 'merchant-1', out_trade_no: trade, transaction_id: 'transaction-1', trade_state: 'SUCCESS', amount: { total: 123, currency: 'CNY' } }; // 官方付款查询字段
  const plugin = wechat(wxEnvironment, (async (url, options) => {
    const address = new URL(String(url));                      // 保留实际出站路径与查询串
    assert.equal(options!.method, 'GET');                      // 微信商户订单号查询是GET
    assert.equal(address.searchParams.get('mchid'), 'merchant-1'); // 请求固定绑定商户身份
    const authorization = (options!.headers as Record<string, string>).authorization; // 实际微信鉴权头
    const fields = Object.fromEntries([...authorization.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]])); // 解析官方头部键值
    const text = `GET\n${address.pathname}${address.search}\n${fields.timestamp}\n${fields.nonce_str}\n\n`; // GET签名正文为空
    assert.equal(verify('RSA-SHA256', Buffer.from(text), merchant.publicKey, Buffer.from(fields.signature, 'base64')), true); // 查询串必须被签入
    return wxResponse(returned);                               // 平台对响应再独立签名
  }) as typeof fetch);
  assert.equal((await plugin.query!({ invoiceId: invoice })).paid, true); // 通过验签的成功状态
  returned = { ...returned, mchid: 'wrong-merchant' };          // 攻击数据仍有机构签名
  await assert.rejects(plugin.query!({ invoiceId: invoice }), /商户或应用不匹配/); // 显式核对资金接收方
});

test('微信处理中退款不会报成功，最终查单核对固定退款号和金额', async () => {
  const original = { refund_id: 'wx-refund-1', out_refund_no: refundId.replaceAll('-', ''), out_trade_no: trade, transaction_id: 'transaction-1', status: 'PROCESSING', amount: { total: 123, refund: 20, currency: 'CNY' } }; // 机构仅受理退款
  let returned = original;                                    // 查询后可以变为明确完成状态
  const plugin = wechat(wxEnvironment, (async (url, options) => {
    if (options!.method === 'POST') {
      const content = JSON.parse(String(options!.body));        // 检查实际退款申请
      assert.equal(content.out_refund_no, refundId.replaceAll('-', '')); // 退款号必须稳定
      assert.equal(content.amount.refund, 20);                 // 机构要求整数分
      return wxResponse(original);                             // 受理响应不代表到账
    }
    assert.equal(new URL(String(url)).pathname, `/v3/refund/domestic/refunds/${refundId.replaceAll('-', '')}`); // 主动查询原退款
    return wxResponse(returned);                               // 响应保持平台签名
  }) as typeof fetch);
  assert.equal((await plugin.refund!(refund)).status, 'pending'); // 不能把PROCESSING记成已退款
  returned = { ...original, status: 'SUCCESS' };               // 平台查询最终退款完成
  assert.equal((await plugin.queryRefund!(refund)).status, 'succeeded'); // 查单确认后才可以结账
  returned = { ...returned, amount: { ...returned.amount, refund: 21 } }; // 篡改退款金额但用机构密钥签名
  await assert.rejects(plugin.queryRefund!(refund), /金额或币种不匹配/); // 有效签名也必须精确绑定申请金额
});

test('微信公钥轮换允许新旧标识重叠，拒绝未登记标识', async () => {
  const next = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); // 新平台公钥由可信配置引入
  const payment = { appid: 'app-1', mchid: 'merchant-1', out_trade_no: trade, transaction_id: 'transaction-1', trade_state: 'SUCCESS', amount: { total: 123, currency: 'CNY' } }; // 同一机构订单
  let serial = 'platform-2';                                  // 新公钥开始签名响应
  const plugin = wechat({ ...wxEnvironment, WECHAT_PLATFORM_KEYS_JSON: JSON.stringify({ 'platform-2': next.publicKey }) }, (async () => wxResponse(payment, serial, serial === 'platform-1' ? platform.privateKey : next.privateKey)) as typeof fetch); // 同时信任旧键与新键
  assert.equal((await plugin.query!({ invoiceId: invoice })).paid, true); // 新键能通过验签
  serial = 'platform-1';                                      // 旧键的重试响应仍然有效
  assert.equal((await plugin.query!({ invoiceId: invoice })).paid, true); // 重叠窗口不会丢旧通知
  serial = 'unregistered';                                    // 请求携带未登记标识
  await assert.rejects(plugin.query!({ invoiceId: invoice }), /公钥标识不匹配/); // 不自动信任机构请求指定的其他公钥
});

function epayResponse(fields: Record<string, string | number>) {
  const returned = { timestamp: Math.floor(Date.now() / 1000).toString(), sign_type: 'RSA', ...fields }; // 官方V2所有业务字段位于顶层
  const values = Object.fromEntries(Object.entries(returned).map(([name, value]) => [name, String(value)])); // 机构数字状态按文本签名
  const signature = sign('RSA-SHA256', Buffer.from(canonical(values)), platform.privateKey).toString('base64'); // 用平台密钥签名
  return new Response(JSON.stringify({ ...returned, sign: signature })); // 保留机构的数字与文本字段
}

test('易支付V2查询与退款验签，V1拒绝无签名自动改账', async () => {
  const environment = { EPAY_VERSION: '2', EPAY_URL: 'https://pay.example/api/pay/submit', EPAY_PID: '1001', EPAY_PRIVATE_KEY: merchant.privateKey, EPAY_PUBLIC_KEY: platform.publicKey }; // 独立商户与平台密钥
  const plugin = epay(environment, (async (url, options) => {
    const request = Object.fromEntries(new URLSearchParams(String(options!.body))); // 实际出站字段
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(request)), merchant.publicKey, Buffer.from(request.sign, 'base64')), true); // 请求确由商户签名
    const action = new URL(String(url)).pathname.split('/').at(-1); // 检查官方API地址
    if (action === 'query') return epayResponse({ code: 0, pid: 1001, out_trade_no: trade, trade_no: 'transaction-1', money: '1.23', status: 1 }); // 查询商户身份与金额均回传
    assert.equal(request.out_refund_no, refundId.replaceAll('-', '')); // 退款和退款查询复用原申请号
    if (action === 'refund') return epayResponse({ code: 0, refund_no: 'epay-refund-1', out_refund_no: request.out_refund_no, trade_no: 'transaction-1', money: '0.20' }); // 先确认机构受理
    assert.equal(action, 'refundquery');                        // 退款不能只凭申请成功结账
    return epayResponse({ code: 0, refund_no: 'epay-refund-1', out_refund_no: request.out_refund_no, out_trade_no: trade, trade_no: 'transaction-1', money: '0.20', status: 1 }); // 最终机构退款完成
  }) as typeof fetch);
  assert.equal((await plugin.query!({ invoiceId: invoice })).amountCents, '123'); // 分金额精确返回
  assert.equal((await plugin.refund!(refund)).status, 'succeeded'); // 已验签的最终查询才可完成退款
  const old = epay({ EPAY_URL: 'https://pay.example/submit.php', EPAY_PID: '1001', EPAY_KEY: 'legacy-key' }); // V1商户仍支持原下单与通知
  await assert.rejects(old.query!({ invoiceId: invoice }), /V1查询和退款响应没有签名/); // 不伪造V1安全查询能力
  await assert.rejects(old.refund!(refund), /V1查询和退款响应没有签名/); // 无签名退款结果不触发自动改账
});

function hpjResponse(fields: Record<string, string | number>) {
  const values = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, String(value)])); // 官方签名只定义标量文本字段
  const hash = createHash('md5').update(canonical(values, ['hash']) + 'hpj-secret').digest('hex'); // 机构使用协议规定的MD5拼接密钥
  return new Response(JSON.stringify({ ...fields, hash }));     // 可验签的平面响应
}

test('虎皮椒只允许全额退款，不能安全验签的嵌套查询明确拒绝', async () => {
  const environment = { HUPIJIAO_APPID: 'hpj-app', HUPIJIAO_SECRET: 'hpj-secret', HUPIJIAO_URL: 'https://api.xunhupay.com/payment/do.html' }; // 离线商户配置
  let calls = 0;                                              // 验证越界请求不进入机构接口
  const plugin = hupijiao(environment, (async (url, options) => {
    calls += 1;                                               // 只记录实际出站调用
    const address = new URL(String(url));                      // 请求固定在配置网关同目录
    if (address.pathname.endsWith('/query.html')) return new Response(JSON.stringify({ errcode: 0, data: { status: 'OD', open_order_id: '1' }, hash: 'not-verifiable' })); // 官方文档未定义嵌套对象的签名序列化
    const fields = Object.fromEntries(new URLSearchParams(String(options!.body))); // 官方退款接口使用表单
    assert.equal(fields.trade_order_id, trade);                 // 以原订单请求全额退款
    return hpjResponse({ errcode: 0, appid: 'hpj-app', trade_order_id: trade, transaction_id: 'transaction-1', out_refund_no: 'hpj-refund-1', refund_fee: '1.23', refund_status: 'CD' }); // 机构明确全额退款完成
  }) as typeof fetch);
  await assert.rejects(plugin.refund!(refund), /只支持全额退款/); // 部分退款不能伪装成全额
  assert.equal(calls, 0);                                      // 被拒绝的请求没有外部副作用
  assert.equal((await plugin.refund!({ ...refund, amountCents: '123' })).status, 'succeeded'); // 签名、订单、流水和金额全部绑定
  await assert.rejects(plugin.query!({ invoiceId: invoice }), /未定义其签名序列化/); // 不编造嵌套签名算法
  await assert.rejects(plugin.queryRefund!(refund), /没有独立退款查询接口/); // 订单取消状态不能当成已退款
});
