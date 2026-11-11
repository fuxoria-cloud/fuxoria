/*
 * 订单：单项购买与购物车共用一条创建主线，固定各行成交价、原子预占库存、每件建立独立服务。
 * 调用：POST /api/v1/orders {productId,period:'month'} + Idempotency-Key；兼容返回首件serviceId。
 * 内部：await purchase(connection,userId,key,{items:[{productId,quantity:2,period:'month'}],fingerprint})。
 * 跨主体步骤在本文件直接排列；购物车只负责自己的revision，不复制下单SQL。
 */
import { Body, Controller, Get, Headers, Param, Post, Req, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'; // 请求错误统一交给主入口
import { createHash } from 'node:crypto';                          // 同一提交键绑定同一购买内容
import type { PoolClient,Pool } from 'pg';                         // 单次购买使用调用者的完整事务
import { z } from 'zod';                                          // 外部输入只在入口整理
import { pool,transaction } from './store.js';                    // 订单、账单、库存、服务共用数据库事实
import { assertInvoiceUncombined,cancelCombined } from './combined.js'; // 父单取消释放子单，子单不可越过父单
import { record } from './audit.js';                              // 成交和免费交付都追加审计
import { fulfill } from './settlement.js';                        // 免费与现金/钱包支付使用同一资源交付
import { read,uuid } from '../utils/input.js';                     // 商品ID与提交键格式只有一个来源
import type { SessionRequest } from '../utils/access.js';          // 订单归属来自已核验会话
import { quoteSelection,groupDiscount,selectionSchema,periods,type Selection,type Configuration,type Period } from './catalogue.js'; // 配置与周期报价只有一个来源
import { applyPromotion,promotionCode } from './promotion.js'; // 优惠占额与订单同一事务

export const orderKey=z.string().trim().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/); // 与续费共用客户提交键命名空间
export type PurchaseItem=Omit<Selection,'configuration'>&{configuration?:Selection['configuration']}; // 旧月付选择仍可重放
export type PurchaseRequest={items:PurchaseItem[];fingerprint:string;revision?:string;currentRevision?:string|null;promotionCode?:string;actorId?:string}; // 所有权与真实委托操作者分别保留
export type OrderItem={id:string;orderId:string;productId:string;productName:string;quantity:number;period:Period;periodLabel:string;unitPriceCents:string;amountCents:string;serviceIds:string[];lineId:string;originalUnitPriceCents:string;setupCents:string;discountCents:string;configuration:Configuration;configurationLabels:Record<string,string>;billingMonths:number;billingSeconds:number;pricingSource:Record<string,unknown>}; // 金额始终是整数分文本

/** @param connection 同一数据库连接或只读池。@param ids 订单ID。@returns 每单真实成交项，带每件服务ID。 */
export async function orderItems(connection:PoolClient|Pool,ids:string[]):Promise<Map<string,OrderItem[]>> {
  const grouped=new Map<string,OrderItem[]>(ids.map(id=>[id,[]]));   // 空结果也有明确归属，不把订单拼到别人名下
  if(!ids.length)return grouped;                                 // 空列表不发送无意义查询
  const found=await connection.query(`SELECT i.id,i.order_id AS "orderId",i.product_id AS "productId",i.product_name AS "productName",
    i.quantity,i.period,i.unit_price_cents::text AS "unitPriceCents",i.amount_cents::text AS "amountCents",i.line_key AS "lineId",
    COALESCE(i.original_unit_price_cents,i.unit_price_cents)::text AS "originalUnitPriceCents",i.setup_cents::text AS "setupCents",i.discount_cents::text AS "discountCents",i.configuration,i.configuration_labels AS "configurationLabels",i.billing_months AS "billingMonths",i.billing_seconds AS "billingSeconds",i.pricing_source AS "pricingSource",
    COALESCE((SELECT array_agg(s.id::text ORDER BY s.item_number) FROM services s WHERE s.order_item_id=i.id),'{}'::text[]) AS "serviceIds"
    FROM order_items i WHERE i.order_id=ANY($1::uuid[]) ORDER BY i.product_id,i.period,i.id`,[ids]); // 一次取全明细，不按每件再发HTTP或SQL查询
  for(const item of found.rows)grouped.get(item.orderId)!.push({...item,periodLabel:periods[item.period as Period].label}); // 周期中文来自同一元数据
  return grouped;                                                // 单项与多项共享相同明细结构
}

// --- 返回已保存的购买结果 ---
async function view(connection:PoolClient,id:string) {
  const saved=(await connection.query('SELECT o.id,o.status,o.amount_cents::text AS "amountCents",o.currency,(SELECT decimals FROM currencies WHERE code=o.currency) AS "currencyDecimals",o.checkout_revision AS "checkoutRevision",i.id AS "invoiceId" FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.id=$1',[id])).rows[0]; // 状态以事务内事实为准
  const items=(await orderItems(connection,[id])).get(id)!;         // 成交单价不受后来商品改名和调价影响
  const serviceIds=items.flatMap(item=>item.serviceIds);            // 一件服务对应一个稳定ID
  return {...saved,serviceId:serviceIds[0] ?? null,serviceIds,items}; // 保留老调用方首件serviceId与invoiceId语义
}

/** @param connection 已开始的业务事务。@param userId 当前客户。@param key 提交键。@param request 已校验的购买快照。@returns 已保存的一个订单、一张账单和全部服务。 */
export async function purchase(connection:PoolClient,userId:string,key:string,request:PurchaseRequest) {
  await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${userId}:${key}`]); // 同客户同键与旧单项入口、续费入口一致串行
  const prior=await connection.query('SELECT id,request_hash,checkout_revision FROM orders WHERE user_id=$1 AND idempotency_key=$2',[userId,key]); // 在读实时库存之前先识别合法重放
  if(prior.rowCount){
    const saved=prior.rows[0];                                    // 成功后购物车可能已清空或被另一标签页修改
    const sameCart=Boolean(request.revision && saved.checkout_revision===request.revision); // 显式原revision可取回原订单，不删新内容
    if(!sameCart && saved.request_hash!==request.fingerprint)throw new ConflictException('同一个提交标识不能订购不同内容'); // 同键换购买内容必须明确冲突
    return view(connection,saved.id);                             // 不再扣库存、延长周期或投递第二次资源
  }
  if(request.revision){
    if(request.currentRevision!==request.revision)throw new ConflictException('购物车已经变化，请刷新核对后再结算'); // 首次提交不能偷偷结算另一份购物车
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cart:${userId}:${request.revision}`]); // 两个不同提交键也不能重复结算同一快照
    const used=await connection.query('SELECT id FROM orders WHERE user_id=$1 AND checkout_revision=$2',[userId,request.revision]); // Redis清理失败后仍有数据库幂等保护
    if(used.rowCount)throw new ConflictException('这份购物车已经生成订单，请查看已有订单'); // 不让重复点击用新key再买一遍
  }
  if(!request.items.length)throw new BadRequestException('购物车为空，请先选择商品'); // 空购买是业务输入错误
  await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`purchase:${userId}`]); // 同客户首次优惠判断与购买串行，跨优惠码不能同时冒充首单
  const items=[...request.items].sort((left,right)=>left.productId.localeCompare(right.productId)); // 所有入口按商品ID稳定加锁，避免相反购买顺序死锁
  const locked=await connection.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[items.map(item=>item.productId)]); // 价格和库存的同一行一直锁到提交
  const products=new Map<string,Record<string,any>>(locked.rows.map(product=>[product.id,product])); // 后续计算不重复查商品
  const quantities=new Map<string,number>(); // 不同配置共用同一商品库存，先合计再检查
  for(const item of items){
    quantities.set(item.productId,(quantities.get(item.productId)??0)+item.quantity);
  }
  for(const [id,quantity] of quantities){const product=products.get(id);if(!product||!product.active||(product.stock!==null&&product.stock<quantity))throw new ConflictException('商品已下架或库存不足，请刷新购物车');}
  const discountPercent=await groupDiscount(connection,userId);
  for(const [id] of quantities){const trials=items.filter(item=>item.productId===id&&item.period==='ontrial');if(trials.length>1||trials.some(item=>item.quantity!==1))throw new ConflictException('同一商品每次只能申请一件试用服务');}
  const quoted=[];for(const item of items)quoted.push(await quoteSelection(connection,products.get(item.productId)!,{...item,configuration:item.configuration??{}},discountPercent,{userId})); // 服务端重新计算，Redis与浏览器均无定价权
  if(new Set(quoted.map(item=>item.lineId)).size!==quoted.length)throw new ConflictException('相同配置需要合并数量后再下单');
  if(new Set(quoted.map(item=>item.currency)).size>1)throw new ConflictException('不同币种的商品请分别结算');
  const discounted=await applyPromotion(connection,userId,request.promotionCode,quoted,true);
  const lines=discounted.lines,total=lines.reduce((sum,item)=>sum+BigInt(item.unitPriceCents)*BigInt(item.quantity),0n);
  const discount=lines.reduce((sum,item)=>sum+BigInt(item.discountCents)*BigInt(item.quantity),0n);
  const order=(await connection.query(`INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,currency,status,checkout_revision,items_explicit,promotion_id,discount_cents)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10) RETURNING id`,[userId,items[0].productId,key,request.fingerprint,total.toString(),products.get(items[0].productId)!.currency,total===0n?'paid':'unpaid',request.revision ?? null,discounted.promotionId,discount.toString()])).rows[0]; // 一个购物车只有一张订单头
  const invoice=(await connection.query(`INSERT INTO invoices(order_id,user_id,amount_cents,currency,status,paid_at)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text='paid' THEN now() ELSE NULL END) RETURNING id,order_id`,[order.id,userId,total.toString(),products.get(items[0].productId)!.currency,total===0n?'paid':'unpaid'])).rows[0]; // 免费订单也有真实的零金额汇总账单
  for(const item of lines){
    const product=products.get(item.productId)!;                    // 上面已经检查过并持锁，不重复校验内部数据
    await connection.query('UPDATE products SET stock=CASE WHEN stock IS NULL THEN NULL ELSE stock-$2 END WHERE id=$1',[item.productId,item.quantity]); // 每种商品按数量一次性预占
    const line=(await connection.query(`INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,line_key,original_unit_price_cents,setup_cents,discount_cents,configuration,configuration_labels,billing_months,billing_seconds,pricing_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,[order.id,item.productId,product.name,item.quantity,item.period,item.unitPriceCents,(BigInt(item.unitPriceCents)*BigInt(item.quantity)).toString(),item.lineId,item.originalUnitPriceCents,item.setupCents,item.discountCents,JSON.stringify(item.configuration),JSON.stringify(item.configurationLabels),item.billingMonths,item.billingSeconds,JSON.stringify(item.pricingSource)])).rows[0]; // 每行保存规则和专属价来源快照
    await connection.query(`INSERT INTO services(user_id,product_id,order_id,order_item_id,item_number,name,renew_amount_cents,billing_period,billing_months,configuration,configuration_labels,billing_seconds,pricing_source,billing_currency)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,number,$5::text,$6::bigint,$8::text,$9::integer,$10::jsonb,$11::jsonb,$12::integer,$13::jsonb,$14::text FROM generate_series(1,$7::integer) AS number`,[userId,item.productId,order.id,line.id,product.name,item.renewAmountCents,item.quantity,item.period,item.billingMonths,JSON.stringify(item.configuration),JSON.stringify(item.configurationLabels),item.billingSeconds,JSON.stringify({orderItemId:line.id,customPriceId:item.pricingSource.customPrice?.id??null,ruleIds:item.pricingSource.rules.map(rule=>rule.id)}),item.currency]); // 完整报价来源在不可变成交行，服务保留稳定引用
    if(item.period==='ontrial')await connection.query('INSERT INTO trial_claims(user_id,product_id,order_id,order_item_id) VALUES($1,$2,$3,$4)',[userId,item.productId,order.id,line.id]);
  }
  if(discounted.promotionId)await connection.query('INSERT INTO promotion_uses(promotion_id,order_id,user_id,discount_cents) VALUES($1,$2,$3,$4)',[discounted.promotionId,order.id,userId,discounted.discountCents]); // 同事务占额，失败和取消不会消耗未来额度
  if(total===0n)await fulfill(connection,invoice);                  // 免费交付和真实付款共用资源主线，不创建假支付凭据
  await record(connection,request.actorId??userId,'order.create',order.id,{userId,amountCents:total.toString(),discountCents:discount.toString(),promotionId:discounted.promotionId,items:lines.map(item=>({productId:item.productId,quantity:item.quantity,period:item.period,lineId:item.lineId,configuration:item.configuration,unitPriceCents:item.unitPriceCents,renewAmountCents:item.renewAmountCents}))}); // 成交配置与实际操作者和订单同事务审计
  if(total===0n)await record(connection,request.actorId??userId,'order.free',order.id,{userId,invoiceId:invoice.id,amountCents:'0'}); // 零应付的业务依据可追查，不伪造现金收入
  return view(connection,order.id);                                // 调用方等数据库COMMIT后才清购物车或向浏览器回复
}

@Controller('orders')
export default class Order {
  /** @returns 当前客户订单，包含历史成交项而非当前商品报价。 */
  @Get() async list(@Req() request:SessionRequest){
    const found=await pool.query('SELECT o.id,o.status,o.amount_cents::text AS "amountCents",o.currency,(SELECT decimals FROM currencies WHERE code=o.currency) AS "currencyDecimals",o.created_at AS "createdAt",i.id AS "invoiceId",p.name AS "productName" FROM orders o JOIN invoices i ON i.order_id=o.id LEFT JOIN products p ON p.id=o.product_id WHERE o.user_id=$1 ORDER BY o.created_at DESC,o.id LIMIT 100',[request.user.id]); // 账号范围始终放在SQL条件
    const items=await orderItems(pool,found.rows.map(order=>order.id)); // 多项明细只发一次查询
    return found.rows.map(order=>({...order,productName:items.get(order.id)![0]?.productName ?? order.productName,items:items.get(order.id)})); // 保留旧productName作首件兼容展示
  }

  /** @param body 单个商品与周期。@param key 稳定提交键。@returns 原接口兼容的订单、账单与首件服务。 */
  @Post() async create(@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest){
    const input=read(selectionSchema.omit({quantity:true}).extend({promotionCode:promotionCode.optional()}).strict(),body); // 不接收客户自报单价或特权字段
    const token=read(orderKey,key);                                 // key规则也给购物车共用
    const identity=Object.keys(input.configuration).length||input.promotionCode?input:{productId:(body as {productId:string}).productId,period:input.period}; // 旧hash保留原UUID大小写与字段形状
    const fingerprint=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return transaction(connection=>purchase(connection,request.user.id,token,{items:[{...input,quantity:1}],fingerprint,promotionCode:input.promotionCode,actorId:request.actorId})); // 创建SQL只有purchase一处
  }

  /** @param id 未付订单。@returns 全部预占已取消且库存只释放一次。 */
  @Post(':id/cancel') async cancel(@Param('id') id:string,@Req() request:SessionRequest){
    read(uuid,id);                                                 // 不允许用错误ID探测数据
    return transaction(async connection=>{
      const found=await connection.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,request.user.id]); // 与现金付款和钱包付款保持同一锁顺序
      if(!found.rowCount)throw new NotFoundException('订单不存在'); // 不暴露另一客户的订单信息
      const order=found.rows[0];                                   // 取消重复请求直接回应原结果
      if(order.status==='cancelled')return {ok:true};              // 不重复退库存
      if(order.status!=='unpaid')throw new ConflictException('已付款订单不能直接取消，请提交工单'); // 免费已交付资源也不能当未付款退库存
      const bill=(await connection.query('SELECT id FROM invoices WHERE order_id=$1 FOR UPDATE',[id])).rows[0]; // 明确与checkout保持订单→账单顺序
      await assertInvoiceUncombined(connection,bill.id); // 子单必须先处理合并父单
      if(await cancelCombined(connection,{id:bill.id,order_id:id})){await record(connection,request.actorId??request.user.id,'combined.cancel',bill.id,{});return {ok:true};} // 父单释放子单但不释放原商品库存
      await connection.query("UPDATE orders SET status='cancelled' WHERE id=$1",[id]); // 订单头和汇总账单一起取消
      await connection.query("UPDATE invoices SET status='cancelled' WHERE order_id=$1",[id]); // 与回调争用账单锁，不能取消后又收款
      if(order.kind==='upgrade')await connection.query("UPDATE service_upgrades SET status='cancelled' WHERE order_id=$1 AND status='unpaid'",[id]); // 取消报价不占用资源变更
      if(order.kind==='new'){
        const reserved=await connection.query('SELECT product_id,sum(quantity)::integer AS quantity FROM order_items WHERE order_id=$1 GROUP BY product_id ORDER BY product_id',[id]); // 按每行实际数量释放，不只退首件
        await connection.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[reserved.rows.map(item=>item.product_id)]); // 与新订购使用同一商品加锁顺序
        for(const item of reserved.rows)await connection.query('UPDATE products SET stock=stock+$2 WHERE id=$1',[item.product_id,item.quantity]); // 无限库存的NULL仍保持NULL
        await connection.query("UPDATE services SET status='cancelled' WHERE order_id=$1",[id]); // 每件未交付资源同步取消
      }
      await record(connection,request.actorId??request.user.id,'order.cancel',id,{userId:request.user.id}); // 全部库存释放和实际委托操作者一起审计
      return {ok:true};                                            // 事务成功后才显示取消完成
    });
  }
}
