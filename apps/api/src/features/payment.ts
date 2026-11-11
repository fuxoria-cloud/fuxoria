/* 支付入口：收银台发起下单；通知使用原始正文验签，完成资金事务后才回执成功。
 * 调用：POST /api/v1/invoices/:id/checkout {gateway:'wechat'}；GET /api/v1/payments。
 * 机构回调：GET/POST /api/v1/payments/:gateway/notify，不依赖浏览器跳转认账。
 */
import { All, Body, Controller, Get, Param, Post, Query, Req, Res, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'; // 支付通知保持真实协议
import type { Response } from 'express';                           // 各渠道回执正文不同
import { z } from 'zod';                                           // 外部支付标识在边界验证
import { PaymentPlugins } from '@fuxoria/payments';                  // 自动发现支付插件
import { pool,transaction } from './store.js';                                 // 成交金额从账单读取
import { assertInvoiceUncombined } from './combined.js';          // 合并子单不能另发二维码
import { settle } from './settlement.js';                          // 已验签结果进入唯一入账主线
import { Public, type SessionRequest } from '../utils/access.js';   // 支付通知独立验签，无需客户登录
import { read, uuid } from '../utils/input.js';                     // 统一输入错误

export let payments:PaymentPlugins;                               // 在服务器启动时加载一次插件
/** @returns 插件清单就绪；新文件会在下次启动自动登记。 */
export async function loadPayments() { payments=await PaymentPlugins.load(); } // 不维护中央支付注册表

@Controller()
export default class Payment {
  /** @returns 不包含任何密钥的支付渠道列表。 */
  @Public() @Get('payments') list(@Query('currency') currency?:string) {if(currency)read(z.string().regex(/^[A-Z]{3}$/),currency);return payments.list().filter(item=>!currency||item.currencies.includes(currency)); }       // 商户配置由服务端保管

  /** @param id 当前客户的账单ID。@param body 选择的支付方式。@returns 支付链接或二维码内容。 */
  @Post('invoices/:id/checkout') async checkout(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({gateway:z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)}).strict(),body); // 不接受任意文件路径
    read(uuid,id);const plugin=payments.get(input.gateway); // 支付通道只来自已发现文件
    if(!plugin.configured)throw new ConflictException('该支付方式尚未配置，请联系服务商'); // 未配置时不创建付款意图
    const invoice=await transaction(async connection=>{
      const target=(await connection.query('SELECT order_id FROM invoices WHERE id=$1 AND user_id=$2',[id,request.user.id])).rows[0];if(!target)throw new NotFoundException('账单不存在'); // 归属先固定
      await connection.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[target.order_id]);const found=await connection.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE',[id]);const current=found.rows[0]; // 和合并/取消/收款保持相同锁顺序
      await assertInvoiceUncombined(connection,id); // 锁后检查，不能在合并同时发出旧二维码
      if(!(plugin.currencies??['CNY']).includes(current.currency))throw new ConflictException('该支付渠道不支持这张账单的币种');
      if(current.status!=='unpaid')throw new ConflictException('此账单无需付款'); // 付款只以数据库状态为准
      const unavailable=await connection.query("SELECT 1 FROM renewals r JOIN services s ON s.id=r.service_id WHERE r.order_id=$1 AND (s.status NOT IN ('active','suspended') OR s.termination_requested_at IS NOT NULL OR COALESCE(s.current_owner_id,s.user_id)<>$2)",[current.order_id,request.user.id]); // 不能继续收无法交付的旧续费
      if(unavailable.rowCount)throw new ConflictException('该服务已终止或归属已变化，请核对续费账单');
      await connection.query('INSERT INTO payment_attempts(invoice_id,gateway) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,input.gateway]); // 提交付款意图后，合并选择将拒绝此账单
      return current;
    }); // 不持有数据库锁等待支付机构网络
    return plugin.create({invoiceId:id,amountCents:invoice.amount_cents,currency:invoice.currency,subject:`狐岚云账单 ${invoice.number}`,notifyUrl:`${process.env.PUBLIC_ORIGIN}/api/v1/payments/${input.gateway}/notify`,returnUrl:`${process.env.PUBLIC_ORIGIN}/console/invoices/${id}`}); // 同一账单复用同一商户单号
  }

  /** @param gateway 插件名。@returns 已成功提交账本后的渠道回执。 */
  @Public() @All('payments/:gateway/notify') async notify(@Param('gateway') gateway:string,@Req() request:SessionRequest & {rawBody?:Buffer},@Res() response:Response) {
    const id=read(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),gateway); // 限制到启动时已发现的文件名
    const url=new URL(request.originalUrl,'http://yunzou.internal'); // 原始URL用于识别重复签名字段
    const query:Record<string,string>={};                          // 签名不能被HTTP解析器悄悄覆盖
    for (const [key,value] of url.searchParams) {
      if (Object.hasOwn(query,key)) throw new BadRequestException('支付通知包含重复参数'); // 拒绝signature或amount的双值歧义
      query[key]=value;                                            // 验签仍保留原始文本
    }
    const plugin=payments.get(id);                                 // 未配置通道由插件明确拒绝
    const result=await plugin.verify({headers:request.headers,rawBody:request.rawBody ?? Buffer.alloc(0),query}); // 微信解密、支付宝身份都在边界完成
    if(!(plugin.currencies??['CNY']).includes(result.currency))throw new BadRequestException('支付通道不支持回调中的币种');
    read(uuid,result.invoiceId);                                  // 外部单号必须能对应本地UUID
    await settle(id,result);                                       // 入账失败绝不发送成功回执
    response.status(200).type(id==='wechat'?'application/json':'text/plain').send(plugin.acknowledgment); // 机构只在这里收到成功
  }
}
