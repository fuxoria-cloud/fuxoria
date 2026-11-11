/* 优惠码：折后比例、固定优惠、覆盖价格和免安装费，范围、有效期、用量由数据库核对。
 * 调用：管理员GET/POST /admin/promotions；实际占额在订单事务内写promotion_uses。
 * 对照：3.7.6 CartController.php:2327-2365，percent为付款比例，free只免安装费。
 */
import { currencyCode,currencyDefinition } from './currency.js';
import { Body,Controller,Get,Param,Post,Put,Req,ConflictException,NotFoundException } from '@nestjs/common';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { pool,transaction } from './store.js';
import { record } from './audit.js';
import { Roles,type SessionRequest } from '../utils/access.js';
import { read,uuid,price } from '../utils/input.js';
import { periodSchema,type Period } from './catalogue.js';

export const promotionCode=z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/); // 只接受优惠标识，不接受客户端金额
const schema=z.object({currency:currencyCode.default('CNY'),code:promotionCode,name:z.string().trim().min(1).max(100),kind:z.enum(['percent','fixed','override','free']),value:price,recurring:z.boolean().default(false),active:z.boolean().default(true),startsAt:z.string().datetime().nullable().default(null),endsAt:z.string().datetime().nullable().default(null),maxUses:z.number().int().min(1).max(2147483647).nullable().default(null),perUserLimit:z.number().int().min(1).max(2147483647).nullable().default(null),minimumCents:price.default('0'),productIds:z.array(uuid).max(100).default([]),periods:z.array(periodSchema).max(10).default([]),firstOrderOnly:z.boolean().default(false)}).strict().refine(input=>input.kind!=='percent'||BigInt(input.value)<=10000n,'折后付款比例不能超过10000基点').refine(input=>!input.startsAt||!input.endsAt||Date.parse(input.endsAt)>Date.parse(input.startsAt),'有效期结束必须晚于开始');
const columns='p.currency,p.id,p.code,p.name,p.kind,p.value::text,p.recurring,p.active,p.starts_at AS "startsAt",p.ends_at AS "endsAt",p.max_uses AS "maxUses",p.per_user_limit AS "perUserLimit",p.minimum_cents::text AS "minimumCents",p.product_ids AS "productIds",p.periods,p.first_order_only AS "firstOrderOnly",(SELECT count(*)::int FROM promotion_uses u JOIN orders o ON o.id=u.order_id WHERE u.promotion_id=p.id AND o.status<>\'cancelled\') AS used';
export type DiscountLine={productId:string;quantity:number;period:Period;unitPriceCents:string;renewAmountCents:string;setupCents:string;discountCents:string;currency?:string};

/** @param reserve 下单为true并持有此锁到订单提交；仅报价不占额。@returns 检验后的优惠与每行实际金额。 */
export async function applyPromotion<T extends DiscountLine>(connection:Pool|PoolClient,userId:string,code:string|undefined,lines:T[],reserve=false){
  if(!code)return {promotionId:null,discountCents:'0',lines};
  const found=await connection.query(`SELECT *,starts_at>now() AS too_early,ends_at<now() AS expired FROM promotions WHERE code=$1 ${reserve?'FOR UPDATE':''}`,[code]);
  const promotion=found.rows[0];
  if(new Set(lines.map(line=>line.currency??'CNY')).size>1)throw new ConflictException('不同币种不能共同使用优惠码');
  if(promotion&&(promotion.kind==='fixed'||promotion.kind==='override'||BigInt(promotion.minimum_cents)>0n)&&lines.some(line=>(line.currency??'CNY')!==promotion.currency))throw new ConflictException('优惠码的金额币种与当前商品不同');
  if(!promotion || !promotion.active || promotion.too_early || promotion.expired)throw new ConflictException('优惠码不存在、尚未开始或已经结束');
  const uses=(await connection.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE u.user_id=$2)::int AS personal FROM promotion_uses u JOIN orders o ON o.id=u.order_id WHERE u.promotion_id=$1 AND o.status<>'cancelled'",[promotion.id,userId])).rows[0];
  if(promotion.max_uses!==null && uses.total>=promotion.max_uses || promotion.per_user_limit!==null && uses.personal>=promotion.per_user_limit)throw new ConflictException('优惠码使用次数已经用完');
  if(promotion.first_order_only && (await connection.query("SELECT 1 FROM orders WHERE user_id=$1 AND kind='new' AND status<>'cancelled' LIMIT 1",[userId])).rowCount)throw new ConflictException('这个优惠码仅限首次购买');
  const total=lines.reduce((sum,line)=>sum+BigInt(line.unitPriceCents)*BigInt(line.quantity),0n);
  if(total<BigInt(promotion.minimum_cents))throw new ConflictException('订单金额尚未达到优惠码的使用门槛');
  let discount=0n,eligible=false;
  const discounted=lines.map(line=>{
    if(promotion.product_ids.length && !promotion.product_ids.includes(line.productId) || promotion.periods.length && !promotion.periods.includes(line.period))return line;
    eligible=true;
    const amount=BigInt(line.unitPriceCents),renew=BigInt(line.renewAmountCents);
    const reduced=(amount:bigint,setup:bigint)=>promotion.kind==='percent'?amount*BigInt(promotion.value)/10000n:promotion.kind==='fixed'?amount>BigInt(promotion.value)?amount-BigInt(promotion.value):0n:promotion.kind==='override'?amount<BigInt(promotion.value)?amount:BigInt(promotion.value):amount-setup;
    const actual=reduced(amount,BigInt(line.setupCents));
    const removed=amount-actual;discount+=removed*BigInt(line.quantity);
    return {...line,unitPriceCents:actual.toString(),renewAmountCents:promotion.recurring && promotion.kind!=='free'?reduced(renew,0n).toString():line.renewAmountCents,discountCents:(BigInt(line.discountCents)+removed).toString()};
  });
  if(!eligible)throw new ConflictException('当前商品或计费周期不在优惠码范围内');
  return {promotionId:promotion.id as string,discountCents:discount.toString(),lines:discounted};
}

@Controller('admin/promotions') @Roles('admin')
export default class Promotion {
  @Get() async list(){return (await pool.query(`SELECT ${columns} FROM promotions p ORDER BY created_at DESC,p.id`)).rows;}
  @Post() async create(@Body() body:unknown,@Req() request:SessionRequest){
    const input=read(schema,body);
    return transaction(async connection=>{
      await currencyDefinition(connection,input.currency);
      const found=(await connection.query('INSERT INTO promotions(code,name,kind,value,recurring,active,starts_at,ends_at,max_uses,per_user_limit,minimum_cents,product_ids,periods,first_order_only,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(code) DO NOTHING RETURNING id',[input.code,input.name,input.kind,input.value,input.recurring,input.active,input.startsAt,input.endsAt,input.maxUses,input.perUserLimit,input.minimumCents,input.productIds,input.periods,input.firstOrderOnly,input.currency])).rows[0];
      if(!found)throw new ConflictException('这个优惠码已经存在');
      await record(connection,request.user.id,'promotion.create',found.id,input);return found;
    });
  }
  @Put(':id') async update(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest){
    read(uuid,id);const input=read(schema,body);
    return transaction(async connection=>{
      await currencyDefinition(connection,input.currency);
      const changed=await connection.query('UPDATE promotions SET code=$2,name=$3,kind=$4,value=$5,recurring=$6,active=$7,starts_at=$8,ends_at=$9,max_uses=$10,per_user_limit=$11,minimum_cents=$12,product_ids=$13,periods=$14,first_order_only=$15,currency=$16 WHERE id=$1 RETURNING id',[id,input.code,input.name,input.kind,input.value,input.recurring,input.active,input.startsAt,input.endsAt,input.maxUses,input.perUserLimit,input.minimumCents,input.productIds,input.periods,input.firstOrderOnly,input.currency]);
      if(!changed.rowCount)throw new NotFoundException('优惠码不存在');await record(connection,request.user.id,'promotion.update',id,input);return changed.rows[0];
    });
  }
}
