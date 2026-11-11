/**
 * 外部数据检查：统一处理金额、表单、签名比较和安全请求地址。
 * 调用：cents('0.30') 得到 '30'；yuan('30') 得到 '0.30'。
 * 所有检查只面向支付机构、商户配置和HTTP输入；业务内部不重复校验。
 */
import { timingSafeEqual } from 'node:crypto';                  // 签名比较不提前暴露第一个差异的位置
import { parseTree, getNodeValue, type Node, type ParseError } from 'jsonc-parser'; // 拒绝JSON重复字段
import type { PaymentNotification, PaymentOrder } from '../index.js'; // 保持同一份支付合同

/** @param status HTTP状态。 @param message 用户或运维可读的原因。 @returns 带状态的错误。 */
export function fail(status: number, message: string) {
  return Object.assign(new Error(message), { status });        // 主入口统一转换成HTTP错误
}

/** @param value 支付机构传来的元金额。 @returns 十进制分金额，避免浮点误差。 */
export function cents(value: string) {
  if (!/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(value)) throw fail(400, '支付金额格式错误'); // 不接受科学计数法、负数和超长值
  const [whole, fraction = ''] = value.split('.');             // 元与小数部分分别转换
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString(); // 全程使用整数
}

/** @param value 主业务传来的十进制分金额。 @returns 固定两位小数的元金额。 */
export function yuan(value: string) {
  if (!/^[1-9]\d{0,17}$/.test(value)) throw fail(400, '支付金额必须是正整数分'); // 支付接口不接收零金额
  const amount = BigInt(value);                                // 字符串不会经过Number转换
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`; // 只在边界显示元
}

/** @param input 下单信息。 @returns 支付机构能接受的无连字符订单号。 */
export function tradeId(input: PaymentOrder) {
  if (input.currency !== 'CNY') throw fail(400, '此支付方式只支持人民币'); // 本批四个通道限定CNY
  yuan(input.amountCents);                                     // 在支付边界检查金额
  return shortId(input.invoiceId);                             // 重试始终复用同一个外部订单号
}

/** @param value 内部稳定编号。 @param maximum 外部接口允许的最大长度。 @returns 无连字符的外部编号。 */
export function shortId(value: string, maximum = 32) {
  const id = value.replace(/-/g, '');                          // UUID的32位写法兼容机构编号限制
  if (!/^[a-zA-Z0-9_]+$/.test(id) || id.length > maximum) throw fail(400, '编号不符合支付通道要求'); // 避免下单后无法匹配
  return id;                                                  // 从固定内部编号得到固定外部编号
}

/** @param amount 分金额文本。 @param total 原始分金额文本。 */
export function within(amount: string, total: string) {
  yuan(amount); yuan(total);                                   // 两个值都必须是正整数分
  if (BigInt(amount) > BigInt(total)) throw fail(400, '退款金额不能超过原付款金额'); // 余额预留与累计限额由主业务事务负责
}

/** @param value 支付机构返回的订单号。 @returns 主业务使用的UUID或原编号。 */
export function invoiceId(value: string) {
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(value)) throw fail(400, '回调账单编号无效'); // 不允许空编号或路径字符
  if (!/^[0-9a-f]{32}$/i.test(value)) return value;             // 普通编号保持原值
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`.toLowerCase(); // 恢复UUID
}

/** @param received 外部签名。 @param expected 本地计算的签名。 @returns 是否相等。 */
export function equal(received: string, expected: string) {
  const left = Buffer.from(received);                          // 按字节比较，避免字符串提前返回
  const right = Buffer.from(expected);                         // 期待值来自本地密钥
  return left.length === right.length && timingSafeEqual(left, right); // 长度不同直接拒绝
}

/** @param input 回调正文或查询参数。 @returns 无重复字段的表单。 */
export function form(input: PaymentNotification) {
  if (input.rawBody.length > 65_536) throw fail(413, '支付通知超过64KiB'); // 支付回调不接受任意大正文
  const pairs = input.rawBody.length ? [...new URLSearchParams(input.rawBody.toString('utf8'))] : Object.entries(input.query); // GET通道由HTTP入口保留原查询值
  const result: Record<string, string> = Object.create(null);  // 外部字段不会改变对象原型
  for (const [key, value] of pairs) {
    if (Object.hasOwn(result, key)) throw fail(400, `支付通知字段重复：${key}`); // 拒绝验签和业务解析取值不一致
    if (typeof value !== 'string') throw fail(400, '支付通知字段必须是单值'); // 拒绝框架解析出的数组
    result[key] = value;                                       // 保留签名需要的原始文本
  }
  return result;                                              // 签名之后再转换业务字段
}

/** @param raw HTTP的原始JSON。 @returns 严格JSON对象，不接受重复键和注释。 */
export function json(raw: Buffer): Record<string, any> {
  if (raw.length > 65_536) throw fail(413, '支付通知超过64KiB'); // 签名前先控制解析成本
  const errors: ParseError[] = [];                             // JSON解析错误属于外部输入错误
  const tree = parseTree(raw.toString('utf8'), errors, { disallowComments: true, allowTrailingComma: false }); // 不支持宽松JSON语法
  if (!tree || tree.type !== 'object' || errors.length) throw fail(400, '支付通知必须是合法JSON对象'); // 不把解析错误当服务器故障
  rejectDuplicates(tree);                                      // 所有嵌套对象都检查重复字段
  return getNodeValue(tree);                                   // 类型由各支付协议的边界检查确定
}

/** @param raw 已通过json检查的原始正文。 @param name 机构签名的对象字段名。 @returns 原始JSON对象文本。 */
export function jsonPart(raw: Buffer, name: string) {
  const text = raw.toString('utf8');                           // jsonc-parser偏移按UTF-16字符计算
  const tree = parseTree(text)!;                               // 调用方已在边界检查完整JSON
  const property = tree.children!.find((item) => item.children![0].value === name); // 定位被签名的原始对象
  if (!property || property.children![1].type !== 'object') throw fail(502, '支付宝缺少签名响应对象'); // 不对猜测的内容验签
  const value = property.children![1];                         // 不能重新JSON.stringify，会改变原签名文本
  return text.slice(value.offset, value.offset + value.length); // 精确保留机构返回的空格和转义
}

function rejectDuplicates(node: Node) {
  if (node.type === 'object') {
    const keys = new Set<string>();                            // 只比较当前对象自己的字段
    for (const property of node.children ?? []) {
      const key = String(property.children![0].value);         // JSON属性的第一个子节点就是键
      if (keys.has(key)) throw fail(400, `支付通知字段重复：${key}`); // 不允许第二个值覆盖第一个值
      keys.add(key);                                           // 记录当前层已经出现的名称
    }
  }
  for (const child of node.children ?? []) rejectDuplicates(child); // 数组中的对象也执行同样规则
}

/** @param value 环境中配置的网关或回调网址。 @returns HTTPS网址。 */
export function httpsUrl(value: string) {
  let url: URL;                                               // URL构造失败作为配置或输入错误
  try { url = new URL(value); } catch { throw fail(400, '支付网址无效'); } // 这是外部配置边界
  if (url.protocol !== 'https:' || url.username || url.password) throw fail(400, '支付网址必须使用HTTPS且不能包含凭据'); // 不向明文地址发送支付信息
  return url;                                                 // 主业务负责仅传自己的公开回调网址
}

/** @param value 原始秒时间戳。 @param windowSeconds 接受的时钟误差与通知窗口。 */
export function fresh(value: string, windowSeconds = 300) {
  if (!/^\d{10}$/.test(value) || Math.abs(Date.now() / 1000 - Number(value)) > windowSeconds) throw fail(400, '支付通知时间已过期或时钟偏差过大'); // 拒绝过旧或来自未来的签名
}

/** @param fields 所需环境变量值。 */
export function configured(fields: (string | undefined)[]) {
  return fields.every((value) => typeof value === 'string' && value.trim().length > 0); // 不把空格当成已配置
}

/** @param ready 通道是否已配置。 */
export function requireConfigured(ready: boolean) {
  if (!ready) throw fail(503, '此支付方式尚未配置，请联系管理员'); // 未配置通道不能产生可付款订单
}
