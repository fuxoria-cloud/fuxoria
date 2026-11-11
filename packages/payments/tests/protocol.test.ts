/**
 * 支付协议离线验证：用临时RSA密钥构造通知，检查篡改、重复字段与金额边界。
 * 执行：npm run test --workspace=@fuxoria/payments。
 * 这些样例只存在于测试中；不创建真实支付订单，也不证明商户已经联调成功。
 */
import test from 'node:test';                                  // 使用Node自带测试运行器
import assert from 'node:assert/strict';                        // 每个场景检查具体的业务结果
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'; // 临时机构签名与GCM密文
import { mkdtemp, rm, writeFile } from 'node:fs/promises';      // 验证插件目录自动发现
import { tmpdir } from 'node:os';                              // 测试产物只写临时目录
import { join } from 'node:path';                              // 定位临时插件文件
import { PaymentPlugins, type PaymentNotification } from '../index.js'; // 测试公开支付入口
import epay from '../plugins/epay.js';                         // 易支付通知样例
import hupijiao from '../plugins/hupijiao.js';                  // 虎皮椒通知与返回样例
import alipay from '../plugins/alipay.js';                     // 支付宝RSA2通知样例
import wechat from '../plugins/wechat.js';                     // 微信RSA签名与GCM资源样例
import { cents, json, yuan } from '../utils/input.js';          // 金额与重复字段的公共边界

const invoice = '75c90e16-fb30-4abf-b31c-f080005d24ce';        // 稳定的主业务账单编号
const trade = invoice.replaceAll('-', '');                    // 机构接收的32位订单号
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }); // 每次测试使用独立临时密钥
const order = { invoiceId: invoice, amountCents: '123', currency: 'CNY', subject: '云服务账单', notifyUrl: 'https://cloud.example/payments/notify', returnUrl: 'https://cloud.example/console/invoices' }; // 无生产商户信息

function md5(fields: Record<string, string>, secret: string, excluded: string[]) {
  return createHash('md5').update(Object.keys(fields).sort().filter((name) => !excluded.includes(name) && fields[name] !== '').map((name) => `${name}=${fields[name]}`).join('&') + secret).digest('hex'); // 测试中的机构协议签名
}

function notification(fields: Record<string, string>): PaymentNotification {
  return { rawBody: Buffer.from(new URLSearchParams(fields).toString()), headers: {}, query: {} }; // 保留表单原始字节
}

test('金额按整数分计算，拒绝浮点近似、负数与科学计数法', () => {
  assert.equal(cents('0.10'), '10');                            // 十进制精确转换
  assert.equal(cents('9999999999999999.99'), '999999999999999999'); // 大额也不会丢精度
  assert.equal(yuan('999999999999999999'), '9999999999999999.99'); // 往返保持一致
  for (const bad of ['-1', '1e2', '0.001', 'Infinity', '01.00', ' 1.00']) assert.throws(() => cents(bad)); // 边界不接受歧义写法
  assert.throws(() => yuan('0'));                             // 零元账单不经过外部收银台
});

test('拒绝JSON嵌套重复字段、注释与大正文', () => {
  assert.throws(() => json(Buffer.from('{"a":{"amount":1,"amount":2}}')), /重复/); // 防止解析器覆盖金额
  assert.throws(() => json(Buffer.from('{"a":1,//hello\n"b":2}')), /合法JSON/); // 支付正文必须严格JSON
  assert.throws(() => json(Buffer.alloc(65_537)), /64KiB/);      // 控制解析与验签成本
});

test('易支付验签、商户、重复字段与UUID映射', async () => {
  const plugin = epay({ EPAY_URL: 'https://pay.example/submit.php', EPAY_PID: '1001', EPAY_KEY: 'epay-test' }); // 测试专用商户
  const fields = { pid: '1001', trade_no: 'epay-100', out_trade_no: trade, money: '1.23', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5', sign: '' }; // 官方V1成功通知
  fields.sign = md5(fields, 'epay-test', ['sign', 'sign_type']); // 在机构侧构造签名
  const result = await plugin.verify(notification(fields));    // 验证后只返回业务所需字段
  assert.deepEqual(result, { invoiceId: invoice, transactionId: 'epay-100', amountCents: '123', currency: 'CNY', paid: true }); // 金额没有经过小数计算
  await assert.rejects(plugin.verify(notification({ ...fields, money: '0.01' })), /签名无效/); // 改一分钱也不能通过
  await assert.rejects(plugin.verify(notification({ ...fields, pid: '1002' })), /商户不匹配/); // 收款人身份独立检查
  const repeated = notification(fields); repeated.rawBody = Buffer.concat([repeated.rawBody, Buffer.from('&money=0.01')]); // 模拟重复表单金额
  await assert.rejects(plugin.verify(repeated), /字段重复/);   // 不允许先验一个值再使用另一个值
  const created = await plugin.create(order);                  // 下单只构造签名收银台跳转
  const address = new URL(created.url!);                       // 提取发往机构的参数
  assert.equal(address.searchParams.get('money'), '1.23');     // 前端看不到浮点近似
  assert.equal(address.searchParams.get('out_trade_no'), trade); // 重试保持同一个外部订单号
  await assert.rejects(plugin.create({ ...order, currency: 'USD' }), /人民币/); // 不允许跨币种混用
});

test('支付宝通知核对RSA2、应用、收款人及金额', async () => {
  const environment = { ALIPAY_APP_ID: 'ali-app', ALIPAY_SELLER_ID: 'ali-seller', ALIPAY_PRIVATE_KEY: keys.privateKey, ALIPAY_PUBLIC_KEY: keys.publicKey }; // 临时密钥代表机构公钥
  const plugin = alipay(environment);                          // 没有调用真实支付宝
  const fields: Record<string, string> = { app_id: 'ali-app', seller_id: 'ali-seller', out_trade_no: trade, trade_no: 'ali-123', total_amount: '1.23', notify_id: 'notify-123', trade_status: 'TRADE_SUCCESS', sign_type: 'RSA2' }; // 官方通知字段
  const text = Object.keys(fields).sort().filter((name) => name !== 'sign_type').map((name) => `${name}=${fields[name]}`).join('&'); // 官方通知不把sign_type纳入签名
  fields.sign = sign('RSA-SHA256', Buffer.from(text), keys.privateKey).toString('base64'); // 构造有效机构签名
  assert.equal((await plugin.verify(notification(fields))).amountCents, '123'); // 成功提取分金额
  await assert.rejects(plugin.verify(notification({ ...fields, total_amount: '0.01' })), /签名无效/); // 拒绝通知被篡改
  await assert.rejects(plugin.verify(notification({ ...fields, seller_id: 'other' })), /收款商户不匹配/); // 拒绝错误资金接收方
  await assert.rejects(plugin.verify(notification({ ...fields, sign_type: 'RSA' })), /RSA2/); // 不接受旧SHA1算法
});

test('支付宝下单验证原始响应签名并返回当面付二维码', async () => {
  const payment = `{ "code":"10000", "out_trade_no":"${trade}", "qr_code":"https://qr.alipay.com/test" }`; // 保留机构响应中的原始空格
  const signed = sign('RSA-SHA256', Buffer.from(payment), keys.privateKey).toString('base64'); // 机构对原对象文本签名
  const plugin = alipay({ ALIPAY_APP_ID: 'ali-app', ALIPAY_SELLER_ID: 'ali-seller', ALIPAY_PRIVATE_KEY: keys.privateKey, ALIPAY_PUBLIC_KEY: keys.publicKey }, (async (_url, options) => {
    const fields = new URLSearchParams(String(options!.body)); // 只检查实际出站内容
    assert.equal(JSON.parse(fields.get('biz_content')!).total_amount, '1.23'); // 支付金额以元字符串发送
    return new Response(`{"alipay_trade_precreate_response":${payment},"sign":"${signed}"}`); // 使用签名后的离线机构响应
  }) as typeof fetch);
  assert.equal((await plugin.create(order)).qrCode, 'https://qr.alipay.com/test'); // 重新序列化响应会导致此测试失败
});

function wechatNotification(payment: Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000).toString()): PaymentNotification {
  const nonce = randomBytes(12).toString('hex').slice(0, 12);   // GCM资源使用独立随机数
  const cipher = createCipheriv('aes-256-gcm', Buffer.from('0123456789abcdef0123456789abcdef'), Buffer.from(nonce)); // 测试专用APIv3密钥
  cipher.setAAD(Buffer.from('transaction'));                   // 与资源里的附加数据一致
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payment)), cipher.final(), cipher.getAuthTag()]).toString('base64'); // 官方格式将认证标签拼到密文结尾
  const rawBody = Buffer.from(JSON.stringify({ id: 'event-1', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: 'transaction', ciphertext } })); // 保持完整签名正文
  const signature = sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\nrequest-nonce\n`), rawBody, Buffer.from('\n')]), keys.privateKey).toString('base64'); // 模拟机构回调签名
  return { rawBody, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': 'request-nonce', 'wechatpay-signature': signature, 'wechatpay-serial': 'platform-1' }, query: {} }; // 原始HTTP输入
}

test('微信签名、时效、GCM资源与商户身份', async () => {
  const plugin = wechat({ WECHAT_APP_ID: 'wx-app', WECHAT_MCH_ID: 'wx-merchant', WECHAT_SERIAL: 'merchant-1', WECHAT_PRIVATE_KEY: keys.privateKey, WECHAT_API_V3_KEY: '0123456789abcdef0123456789abcdef', WECHAT_PLATFORM_SERIAL: 'platform-1', WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey }); // 临时平台公钥
  const payment = { appid: 'wx-app', mchid: 'wx-merchant', out_trade_no: trade, transaction_id: 'wx-123', trade_state: 'SUCCESS', amount: { total: 123, currency: 'CNY' } }; // 原始支付资源
  assert.equal((await plugin.verify(wechatNotification(payment))).amountCents, '123'); // 先验签再解密再核对身份
  const changed = wechatNotification(payment); changed.rawBody = Buffer.concat([changed.rawBody, Buffer.from(' ')]); // 语义相同但字节改变
  await assert.rejects(plugin.verify(changed), /签名无效/);   // 必须使用未改写的原正文
  await assert.rejects(plugin.verify(wechatNotification(payment, '1600000000')), /时间已过期/); // 旧签名不能重放
  await assert.rejects(plugin.verify(wechatNotification({ ...payment, mchid: 'another' })), /商户或应用不匹配/); // 有效平台签名也不能跨商户使用
  await assert.rejects(plugin.verify(wechatNotification({ ...payment, amount: { total: 0.5, currency: 'CNY' } })), /金额或币种无效/); // 金额必须是正整数分
  const serial = wechatNotification(payment); serial.headers['wechatpay-serial'] = 'unknown'; // 攻击者不能自行选择另一把公钥
  await assert.rejects(plugin.verify(serial), /公钥标识不匹配/); // 只使用本地可信公钥
});

test('虎皮椒使用官方MD5算法，拒绝篡改、过期与错误应用', async () => {
  const environment = { HUPIJIAO_APPID: 'hpj-app', HUPIJIAO_SECRET: 'hpj-secret', HUPIJIAO_URL: 'https://api.xunhupay.com/payment/do.html' }; // 测试配置
  const plugin = hupijiao(environment);                        // 不连接真实支付机构
  const fields = { appid: 'hpj-app', trade_order_id: trade, transaction_id: 'hpj-123', total_fee: '1.23', status: 'OD', time: Math.floor(Date.now() / 1000).toString(), nonce_str: 'abc123', hash: '' }; // 官方表单通知
  fields.hash = md5(fields, 'hpj-secret', ['hash']);           // 官方协议不是HMAC
  assert.equal((await plugin.verify(notification(fields))).paid, true); // 仅OD是已付款
  await assert.rejects(plugin.verify(notification({ ...fields, total_fee: '9.99' })), /签名无效/); // 金额受到签名保护
  await assert.rejects(plugin.verify(notification({ ...fields, appid: 'other' })), /应用不匹配/); // 收款渠道必须一致
  const old = { ...fields, time: '1600000000' }; old.hash = md5(old, 'hpj-secret', ['hash']); // 重签也无法通过时效检查
  await assert.rejects(plugin.verify(notification(old)), /时间已过期/); // 48小时以外的回调需要人工对账
  const refund = { ...fields, status: 'CD' }; refund.hash = md5(refund, 'hpj-secret', ['hash']); // 机构的退款状态通知
  assert.equal((await plugin.verify(notification(refund))).paid, false); // 不能把退款当作新付款
});

test('虎皮椒下单验证响应签名，拒绝未签名的跳转地址', async () => {
  const environment = { HUPIJIAO_APPID: 'hpj-app', HUPIJIAO_SECRET: 'hpj-secret', HUPIJIAO_URL: 'https://api.xunhupay.com/payment/do.html' }; // 离线商户配置
  const returned = { errcode: '0', errmsg: 'success', url: 'https://pay.example/checkout', hash: '' }; // 官方1.1顶层响应字段
  returned.hash = md5(returned, 'hpj-secret', ['hash']);        // 用临时密钥签机构响应
  const transport = (async (_url: unknown, options: RequestInit) => {
    const sent = JSON.parse(String(options.body));              // 读取实际下单请求
    assert.equal(sent.total_fee, '1.23');                       // 请求以元文本表示金额
    assert.equal(sent.hash, md5(sent, 'hpj-secret', ['hash'])); // 核对出站hash规则
    return new Response(JSON.stringify(returned));              // 不发起真实支付
  }) as typeof fetch;
  assert.equal((await hupijiao(environment, transport).create(order)).url, returned.url); // 只展示已验签的地址
  returned.url = 'https://evil.example/checkout';               // 攻击者改地址但无法重签
  await assert.rejects(hupijiao(environment, transport).create(order), /返回签名无效/); // 下单响应同样受到保护
});

test('微信Native请求和返回同时验签', async () => {
  const environment = { WECHAT_APP_ID: 'wx-app', WECHAT_MCH_ID: 'wx-merchant', WECHAT_SERIAL: 'merchant-1', WECHAT_PRIVATE_KEY: keys.privateKey, WECHAT_API_V3_KEY: '0123456789abcdef0123456789abcdef', WECHAT_PLATFORM_SERIAL: 'platform-1', WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey }; // 离线商户配置
  const plugin = wechat(environment, (async (_url, options) => {
    const authorization = (options!.headers as Record<string, string>).authorization; // 检查实际送出的微信鉴权头
    const fields = Object.fromEntries([...authorization.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]])); // 解析官方头部键值
    const signedRequest = `POST\n/v3/pay/transactions/native\n${fields.timestamp}\n${fields.nonce_str}\n${String(options!.body)}\n`; // 请求签名必须包括路径与末尾换行
    assert.equal(verify('RSA-SHA256', Buffer.from(signedRequest), keys.publicKey, Buffer.from(fields.signature, 'base64')), true); // 请求来自配置商户密钥
    assert.equal(JSON.parse(String(options!.body)).amount.total, 123); // JSON金额保持整数分
    const time = Math.floor(Date.now() / 1000).toString();       // 机构返回当前签名时间
    const raw = '{"code_url":"weixin://wxpay/bizpayurl?pr=test"}'; // 离线Native支付响应
    const signature = sign('RSA-SHA256', Buffer.from(`${time}\nreturn-nonce\n${raw}\n`), keys.privateKey).toString('base64'); // 平台独立签响应正文
    return new Response(raw, { headers: { 'wechatpay-timestamp': time, 'wechatpay-nonce': 'return-nonce', 'wechatpay-signature': signature, 'wechatpay-serial': 'platform-1' } }); // 保留官方验签四个头部
  }) as typeof fetch);
  assert.equal((await plugin.create(order)).qrCode, 'weixin://wxpay/bizpayurl?pr=test'); // 返回内容通过平台验签才可展示
});

test('插件按文件发现，未配置通道拒绝下单', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yunzou-payments-')); // 不改生产插件目录
  try {
    await writeFile(join(directory, 'sample.mjs'), 'export default () => ({name:"ignored"})'); // 扫描规则只接受ts或js
    await writeFile(join(directory, 'sample.js'), 'export default () => ({name:"新增支付",configured:false,acknowledgment:"success",create(){},verify(){}})'); // 放一个文件即出现
    const plugins = await PaymentPlugins.load(directory);     // 不需要修改中央登记表
    assert.deepEqual(plugins.list(), [{ id: 'sample', name: '新增支付', configured: false,currencies:['CNY'] }]); // 名称来自文件而非二次登记
    assert.throws(() => plugins.get('missing'), /不存在/);    // 不回退到其他通道
  } finally { await rm(directory, { recursive: true, force: true }); } // 测试结束清理临时文件
  for (const plugin of [epay({}), alipay({}), wechat({}), hupijiao({})]) {
    assert.equal(plugin.configured, false);                    // 缺密钥时如实报告状态
    await assert.rejects(plugin.create(order), /尚未配置/);    // 不生成模拟支付链接
  }
});
