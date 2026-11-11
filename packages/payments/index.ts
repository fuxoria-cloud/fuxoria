/**
 * 支付插件：启动时扫描 plugins，每个支付方式由一个文件提供。
 * 调用：const payments = await PaymentPlugins.load(); payments.list();
 * 下单：await payments.get('epay').create({ invoiceId, amountCents: '100', currency: 'CNY', subject: '账单', notifyUrl, returnUrl });
 * 此处只处理支付协议；验签后的金额核对、重复通知和入账由主业务的数据库事务负责。
 */
import { readdir } from 'node:fs/promises';                      // 从文件名发现支付方式
import { fileURLToPath, pathToFileURL } from 'node:url';         // 同时支持源码和编译后的文件路径
import { join } from 'node:path';                              // 将插件文件定位到固定目录
import { fail } from './utils/input.js';                       // 使用带状态码的业务错误

export class PaymentPlugins {
  private constructor(private readonly plugins: Map<string, PaymentPlugin>) {} // 登记表属于这次启动

  /** @param directory 插件目录，省略时使用当前包的 plugins。 @returns 启动时发现的全部支付方式。 */
  static async load(directory = fileURLToPath(new URL('./plugins/', import.meta.url))) {
    const files = await readdir(directory);                    // 新增支付方式只需要新增一个文件
    const plugins = new Map<string, PaymentPlugin>();          // 文件名是支付方式标识的唯一来源
    for (const file of files.sort()) {
      if (!/\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue; // 排除声明文件和非代码资源
      const id = file.replace(/\.(ts|js)$/, '');              // 去掉后缀得到稳定的支付方式标识
      if (plugins.has(id)) throw fail(500, `支付插件重名：${id}`); // 防止源码和产物混放而覆盖
      const loaded = await import(pathToFileURL(join(directory, file)).href); // 加载支付方式自己的文件
      plugins.set(id, loaded.default());                       // 配置在启动时从环境读取
    }
    return new PaymentPlugins(plugins);                       // 后续查找不再访问磁盘
  }

  /** @returns 不含商户密钥的支付方式清单。 */
  list() {
    return [...this.plugins].map(([id, plugin]) => ({ id, name: plugin.name, configured: plugin.configured,currencies:plugin.currencies??['CNY'] })); // 给管理界面展示配置状态
  }

  /** @param id 插件文件名，不含扩展名。 @returns 对应支付方式。 */
  get(id: string) {
    const plugin = this.plugins.get(id);                       // 只访问启动时已发现的支付方式
    if (!plugin) throw fail(404, '支付方式不存在');            // 用户可以更换支付方式
    return plugin;                                            // 不回退到其他通道
  }
}

export interface PaymentPlugin {
  name: string;                                               // 用户能读懂的名称
  currencies?: readonly string[];                              // 通道真实支持的账单币种，旧插件默认仅CNY
  configured: boolean;                                        // 所需商户配置是否齐全
  acknowledgment: string;                                     // 成功入账后才返回给支付机构的正文
  create(input: PaymentOrder): Promise<{ url?: string; qrCode?: string; reference?: string }>;
  verify(input: PaymentNotification): Promise<PaymentResult>;
  query?(input: PaymentQuery): Promise<PaymentResult>;           // 只有可验证结果的通道才提供主动查单
  refund?(input: PaymentRefund): Promise<RefundResult>;          // 通道不支持时必须明确报错
  queryRefund?(input: PaymentRefund): Promise<RefundResult>;     // 异步退款用同一退款号确认最终结果
}

export interface PaymentOrder {
  invoiceId: string; amountCents: string; currency: string; subject: string; notifyUrl: string; returnUrl: string;
}

export interface PaymentNotification {
  headers: Record<string, string | string[] | undefined>; rawBody: Buffer; query: Record<string, string>;
}

export interface PaymentResult {
  invoiceId: string; transactionId: string; amountCents: string; currency: string; paid: boolean;
}

export interface PaymentQuery {
  invoiceId: string; transactionId?: string;                    // 查询优先用创建时的稳定商户订单号
}

export interface PaymentRefund {
  invoiceId: string; transactionId: string; refundId: string; amountCents: string; totalCents: string; reason: string; currency?:string;
}

export interface RefundResult {
  reference: string; status: 'succeeded' | 'pending';            // 已受理不会误报为已退款
}
