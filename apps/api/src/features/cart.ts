/*
 * 购物车：Redis保存客户选择和revision，价格与库存每次从PostgreSQL读取；结算复用order.ts。
 * 调用：POST /api/v1/cart {productId,quantity:2,period:'month'}；GET /cart取得revision。
 * 结算：POST /cart/checkout {revision} + Idempotency-Key。成功后只CAS清除原快照，保留并发新加内容。
 */
import { Body,Controller,Delete,Get,Headers,Param,Post,Put,Req,BadRequestException,ConflictException,NotFoundException } from '@nestjs/common'; // 全部购物车入口使用已登录身份
import { createHash,randomUUID } from 'node:crypto';                // revision与购物车内容一一绑定，不复用旧值
import { z } from 'zod';                                          // 输入只接受商品、月付和整数数量
import { pool,redis,transaction } from './store.js';               // Redis选择不代替数据库成交事实
import { purchase,orderKey,type PurchaseItem } from './order.js';  // 下单SQL和幂等策略只有一个来源
import { read,uuid } from '../utils/input.js';                      // ID在边界一次检查
import type { SessionRequest } from '../utils/access.js';           // 不接受请求体指定客户ID
import { selectionSchema,lineKey,quoteSelection,groupDiscount } from './catalogue.js'; // 行身份与整数报价和下单保持一致
import { applyPromotion,promotionCode } from './promotion.js'; // 预览检验优惠，但不占用额度

const item=selectionSchema;
const cache=redis.withCommandOptions({timeout:2000}); // 资金提交后的缓存同步最多等两秒，断连不能让已创建订单无限挂起
const maximum=50;                                                 // 单车最多50种商品，控制数据库锁和一次批量开通规模
const ttl=30*86400;                                               // 三十天未操作的购物选择过期，已生成订单始终在PG
const compare=`if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`; // 唯一规则：读取版本没变才替换
const consume=`if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('DEL',KEYS[1]); return 1`; // 成功结算只清除刚才确认的完整原快照

type Contents={revision:string|null;items:PurchaseItem[];promotionCode?:string}; // 不缓存价格，避免商品改价后仍按旧缓存成交

// --- 读取当前选择，空车也有明确形状 ---
async function contents(userId:string){
  const raw=await cache.get(`cart:${userId}`) ?? '';                // 不读取别人的键，不把账号ID放进可改请求体
  const value:Contents=raw?JSON.parse(raw):{revision:null,items:[]}; // Redis是内部自有状态，异常损坏交统一入口报错
  return {raw,value};                                             // 原字节用于CAS，不靠容易重排的对象比较
}

// --- 客户选择原子修改，和另一标签页冲突时重新读取 ---
async function change(userId:string,update:(items:PurchaseItem[])=>PurchaseItem[],promotion?:string|null){
  for(let attempt=0;attempt<20;attempt++){
    const saved=await contents(userId);                            // 每次冲突都从真正的新版本重算
    const items=update(saved.value.items).sort((left,right)=>lineKey(left).localeCompare(lineKey(right))); // 同商品不同配置、周期是独立行
    if(new Set(items.map(lineKey)).size!==items.length)throw new ConflictException('相同配置已经在购物车中，请直接修改那一行数量');
    if(items.length>maximum)throw new BadRequestException('购物车最多放50种商品，请分批结算'); // 不能靠无限条目拖长资金事务
    const next:Contents={revision:randomUUID(),items,promotionCode:promotion===null?undefined:promotion??saved.value.promotionCode}; // 优惠变化也使旧确认失效
    const written=await cache.eval(compare,{keys:[`cart:${userId}`],arguments:[saved.raw,JSON.stringify(next),String(ttl)]}); // 比较和写入是一个Redis原子操作
    if(Number(written)===1)return next;                            // 成功只替换本客户的这份选择
  }
  throw new ConflictException('购物车正在被其它页面修改，请刷新后重试'); // 竞争过多时明确反馈，不丢掉其它标签页内容
}

// --- 用当前数据库事实计算页面报价 ---
async function quote(value:Contents,userId:string){
  const found=await pool.query('SELECT * FROM products WHERE id=ANY($1::uuid[])',[value.items.map(item=>item.productId)]); // 从不相信浏览器或Redis里的价格
  const products=new Map<string,Record<string,any>>(found.rows.map(product=>[product.id,product])); // 一次查询全部商品
  const discount=await groupDiscount(pool,userId),quantities=new Map<string,number>();
  for(const item of value.items)quantities.set(item.productId,(quantities.get(item.productId)??0)+item.quantity);
  let known=true;
  let items=await Promise.all(value.items.map(async item=>{
    const product=products.get(item.productId);                    // 曾加入的商品可能后来删除或下架
    try{
      if(!product)throw new NotFoundException('商品已不存在');
      const quoted=await quoteSelection(pool,product,{...item,configuration:item.configuration??{}},discount,{userId});
      const available=product.stock===null||product.stock>=quantities.get(item.productId)!;
      return {...quoted,lineId:lineKey(item),amountCents:(BigInt(quoted.unitPriceCents)*BigInt(item.quantity)).toString(),stock:product.stock,available,problem:available?null:'当前商品总数量超出库存'};
    }catch(error){if(!(error instanceof ConflictException||error instanceof NotFoundException))throw error;known=false;return {...item,configuration:item.configuration??{},configurationLabels:{},lineId:lineKey(item),productName:product?.name??'已移除的商品',unitPriceCents:null,amountCents:null,stock:product?.stock??null,available:false,problem:error.message,renewAmountCents:'0',setupCents:'0',discountCents:'0'};}
  }));
  const currencies=new Set(found.rows.map(row=>row.currency)),currency=currencies.size===1?found.rows[0].currency:'CNY';
  let promotionProblem:string|null=currencies.size>1?'不同币种的商品请分别结算':null;
  if(known && !promotionProblem && value.promotionCode){
    try{const discounted=await applyPromotion(pool,userId,value.promotionCode,items as (typeof items[number]&{unitPriceCents:string})[]);items=discounted.lines.map(line=>({...line,amountCents:(BigInt(line.unitPriceCents)*BigInt(line.quantity)).toString()}));}
    catch(error){if(!(error instanceof ConflictException))throw error;promotionProblem=error.message;}
  }
  const total=items.reduce((sum,item)=>sum+BigInt(item.amountCents??'0'),0n);
  const currencyDecimals=(await pool.query('SELECT decimals FROM currencies WHERE code=$1',[currency])).rows[0]?.decimals??2;
  return {revision:value.revision,items,currencyDecimals,promotionCode:value.promotionCode??null,promotionProblem,discountCents:currencies.size>1?'0':items.reduce((sum,item)=>sum+BigInt(item.discountCents)*BigInt(item.quantity),0n).toString(),amountCents:known&&currencies.size<=1?total.toString():null,currency,canCheckout:items.length>0 && items.every(item=>item.available)&&!promotionProblem};
}

@Controller('cart')
export default class Cart {
  /** @returns 本客户购物车和当前实际报价。 */
  @Get() async get(@Req() request:SessionRequest){return quote((await contents(request.user.id)).value,request.user.id);} // 不做匿名暂存或演示状态

  /** @param body 加入的商品和数量。@returns 修改后购物车，已存在商品增加数量。 */
  @Post() async add(@Body() body:unknown,@Req() request:SessionRequest){
    const input=read(item,body);                                   // 只在HTTP边界验证选择
    const product=await pool.query('SELECT * FROM products WHERE id=$1 AND active',[input.productId]); // 不接受未知或下架商品新加入
    if(!product.rowCount)throw new NotFoundException('商品不存在或已下架'); // 保留旧车里的失效项供用户手动处理
    const selected=await quoteSelection(pool,product.rows[0],input,0,{userId:request.user.id}); // 固定默认配置并核对主账号试用资格
    const canonical={...input,configuration:selected.configuration},identity=lineKey(canonical);
    const saved=await change(request.user.id,items=>{
      const old=items.find(item=>lineKey(item)===identity);
      const quantity=(old?.quantity ?? 0)+input.quantity;          // 增量加入不会覆盖另一标签页刚加的数量
      if(quantity>20)throw new BadRequestException('同一商品最多加入20件'); // 单行数量始终满足成交约束
      return [...items.filter(item=>lineKey(item)!==identity),{...canonical,quantity}];
    });
    return quote(saved,request.user.id);
  }

  /** @param body 商品的新绝对数量。@returns 已确认的新revision。 */
  @Put() async update(@Body() body:unknown,@Req() request:SessionRequest){
    const input=read(item.extend({lineId:z.string().regex(/^[a-f0-9]{64}$/).optional()}),body);
    const identity=input.lineId??lineKey(input);
    const saved=await change(request.user.id,items=>{
      if(!items.some(item=>lineKey(item)===identity))throw new NotFoundException('购物车中没有这个配置');
      return items.map(item=>lineKey(item)===identity?{productId:input.productId,quantity:input.quantity,period:input.period,configuration:input.configuration}:item);
    });
    return quote(saved,request.user.id);
  }

  @Put('promotion') async promotion(@Body() body:unknown,@Req() request:SessionRequest){
    const input=read(z.object({code:promotionCode.nullable()}).strict(),body);
    const current=(await contents(request.user.id)).value;
    const preview=await quote({...current,promotionCode:input.code??undefined},request.user.id);
    if(preview.promotionProblem)throw new ConflictException(preview.promotionProblem);
    return quote(await change(request.user.id,items=>items,input.code),request.user.id);
  }

  @Delete('items/:lineId') async removeLine(@Param('lineId') id:string,@Req() request:SessionRequest){
    read(z.string().regex(/^[a-f0-9]{64}$/),id);
    return quote(await change(request.user.id,items=>items.filter(item=>lineKey(item)!==id)),request.user.id);
  }

  /** @param productId 要移除的商品。@returns 新购物车。 */
  @Delete(':productId') async remove(@Param('productId') productId:string,@Req() request:SessionRequest){
    productId=read(uuid,productId).toLowerCase();                                         // 外部ID不能影响Redis键名
    const saved=await change(request.user.id,items=>items.filter(item=>item.productId!==productId)); // 删除本客户的一项，重复删除保持无副作用
    return quote(saved,request.user.id);
  }

  /** @returns 已清空的购物车和新revision。 */
  @Delete() async clear(@Req() request:SessionRequest){return quote(await change(request.user.id,()=>[],null),request.user.id);} // 清空也换版本，旧结算不能误消费新选择

  /** @param body 用户刚确认的revision。@param key 稳定提交键。@returns 已提交订单；购物车同步不会回滚成交。 */
  @Post('checkout') async checkout(@Body() body:unknown,@Headers('idempotency-key') key:unknown,@Req() request:SessionRequest){
    const input=read(z.object({revision:uuid.transform(value=>value.toLowerCase())}).strict(),body);       // 用户明确确认哪一份购物车，不结算隐藏的新内容
    const token=read(orderKey,key);                                // 与单项购买及续费共用客户key命名空间
    const saved=await contents(request.user.id);                    // 选择快照只读一次，事务内重新检查PG价格库存
    const fingerprint=createHash('sha256').update(JSON.stringify({source:'cart',revision:input.revision,items:saved.value.items,promotionCode:saved.value.promotionCode})).digest('hex'); // 同键与原revision绑定
    const order=await transaction(connection=>purchase(connection,request.user.id,token,{items:saved.value.items,fingerprint,revision:input.revision,currentRevision:saved.value.revision,promotionCode:saved.value.promotionCode,actorId:request.actorId})); // COMMIT成功前绝不清车
    if(saved.value.revision!==input.revision)return {...order,orderConfirmed:true,cartCleared:true,cartChanged:true}; // 原请求重放时保留另一标签页的新购物车
    try{
      const cleared=Number(await cache.eval(consume,{keys:[`cart:${request.user.id}`],arguments:[saved.raw]}))===1; // 原内容没变才删除，新增选择不会丢
      return {...order,orderConfirmed:true,cartCleared:true,cartChanged:!cleared}; // CAS失败代表当前已是新车，不是订单失败
    }catch(error){
      console.error(JSON.stringify({action:'cart.sync',orderId:order.id,message:'订单已提交，Redis同步暂未完成'})); // 缓存故障不泄露会话或密钥
      return {...order,orderConfirmed:true,cartCleared:false,cartChanged:false,message:'订单已创建，购物车暂未同步；请复用原提交重试或查看订单'}; // 资金事实成功后不向用户谎报下单失败
    }
  }
}
