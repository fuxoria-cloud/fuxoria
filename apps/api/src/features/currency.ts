/* 币种：独立最小单位与精确有理数汇率；批量换价只影响新的商品报价，历史合同和账本不重写。
 * 调用：GET /currencies；管理 GET/POST/PUT /admin/currencies；POST /admin/currencies/reprice {productIds,targetCurrency}。
 * 汇率口径：1个该币种主单位对应 rateNumerator/rateDenominator 个CNY主单位，换价向上取最小单位。
 * 财务边界：任何余额/退款预留/授信/报表必须带currency筛选，跨币种不净额抵扣。
 */
import { Body,Controller,Get,Post,Put,Delete,Param,Req,ConflictException,NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Pool,PoolClient } from 'pg';
import { pool,transaction } from './store.js';
import { record } from './audit.js';
import { Roles,Public,type SessionRequest } from '../utils/access.js';
import { read,uuid } from '../utils/input.js';
export const currencyCode=z.string().regex(/^[A-Z]{3}$/);
const rational=z.string().regex(/^[1-9]\d{0,11}$/);
const definition=z.object({name:z.string().trim().min(1).max(80),symbol:z.string().trim().min(1).max(12),decimals:z.number().int().min(0).max(8),rateNumerator:rational,rateDenominator:rational,active:z.boolean().default(true),isDefault:z.boolean().default(false)}).strict();
export const currencyColumns='code,name,symbol,decimals,rate_numerator::text AS "rateNumerator",rate_denominator::text AS "rateDenominator",active,is_default AS "isDefault"';
export async function currencyDefinition(connection:Pool|PoolClient,code:string,active=false){const row=(await connection.query(`SELECT ${currencyColumns} FROM currencies WHERE code=$1 ${active?'AND active':''} FOR SHARE`,[code])).rows[0];if(!row)throw new ConflictException(active?'这个币种尚未启用':'币种不存在');return row;}
/** @returns 精确换价后的最小单位，向上取分；不将有理数汇率转换成浮点。 */
export function convertMinor(value:string,source:Record<string,any>,target:Record<string,any>){const numerator=BigInt(value)*BigInt(source.rateNumerator)*BigInt(target.rateDenominator)*10n**BigInt(target.decimals),denominator=BigInt(source.rateDenominator)*BigInt(target.rateNumerator)*10n**BigInt(source.decimals),result=(numerator+denominator-1n)/denominator;if(result>999999999999n)throw new ConflictException('换价结果超过金额上限');return result.toString();}
@Controller()
export default class Currency {
 @Public() @Get('currencies') async list(){return (await pool.query(`SELECT ${currencyColumns} FROM currencies ORDER BY is_default DESC,code`)).rows;}
 @Roles('admin') @Get('admin/currencies') async all(){return {currencies:await this.list(),rates:(await pool.query('SELECT id,currency,numerator::text,denominator::text,actor,created_at AS "createdAt" FROM currency_rates ORDER BY created_at DESC LIMIT 200')).rows};}
 @Roles('admin') @Post('admin/currencies') async create(@Body() body:unknown,@Req() request:SessionRequest){const input=read(definition.extend({code:currencyCode}).strict(),body);return this.save(input.code,input,request,true);}
 @Roles('admin') @Put('admin/currencies/:code') async update(@Param('code') code:string,@Body() body:unknown,@Req() request:SessionRequest){return this.save(read(currencyCode,code),read(definition,body),request,false);}
 private async save(code:string,input:z.infer<typeof definition>,request:SessionRequest,create:boolean){
  if(input.isDefault&&!input.active)throw new ConflictException('默认币种必须启用');if(code==='CNY'&&(input.decimals!==2||input.rateNumerator!=='1'||input.rateDenominator!=='1'))throw new ConflictException('人民币是汇率锚点，精度固定两位且汇率为1/1');
  return transaction(async connection=>{await connection.query('SELECT pg_advisory_xact_lock(833064)');const prior=(await connection.query('SELECT * FROM currencies WHERE code=$1 FOR UPDATE',[code])).rows[0];if(create&&prior)throw new ConflictException('币种代码已存在');if(!create&&!prior)throw new NotFoundException('币种不存在');if(prior&&prior.decimals!==input.decimals)throw new ConflictException('已有币种不能改变最小单位精度');if(prior?.is_default&&!input.isDefault)throw new ConflictException('请在另一个币种中设为默认，不能取消唯一默认币种');if(input.isDefault)await connection.query('UPDATE currencies SET is_default=false WHERE is_default');
   await connection.query('INSERT INTO currencies(code,name,symbol,decimals,rate_numerator,rate_denominator,active,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,rate_numerator=EXCLUDED.rate_numerator,rate_denominator=EXCLUDED.rate_denominator,active=EXCLUDED.active,is_default=EXCLUDED.is_default,updated_at=now()',[code,input.name,input.symbol,input.decimals,input.rateNumerator,input.rateDenominator,input.active,input.isDefault]);
   if(!prior||prior.rate_numerator!==input.rateNumerator||prior.rate_denominator!==input.rateDenominator)await connection.query('INSERT INTO currency_rates(currency,numerator,denominator,actor) VALUES($1,$2,$3,$4)',[code,input.rateNumerator,input.rateDenominator,request.actorId??request.user.id]);
   await record(connection,request.actorId??request.user.id,create?'currency.create':'currency.update',code,input);await connection.query('SELECT pg_notify($1,$2)',['content_changed',JSON.stringify({paths:['/','/products']})]);return currencyDefinition(connection,code);
  });
 }
 @Roles('admin') @Delete('admin/currencies/:code') async remove(@Param('code') code:string,@Req() request:SessionRequest){read(currencyCode,code);return transaction(async connection=>{const result=await connection.query('UPDATE currencies SET active=false,updated_at=now() WHERE code=$1 AND NOT is_default RETURNING code',[code]);if(!result.rowCount)throw new ConflictException('默认币种不能停用，或币种不存在');await record(connection,request.actorId??request.user.id,'currency.disable',code,{});return {ok:true};});}
 @Roles('admin') @Post('admin/currencies/reprice') async reprice(@Body() body:unknown,@Req() request:SessionRequest){const input=read(z.object({productIds:z.array(uuid).min(1).max(100),targetCurrency:currencyCode}).strict(),body);return transaction(async connection=>{const products=(await connection.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[input.productIds])).rows;if(products.length!==new Set(input.productIds).size)throw new NotFoundException('部分商品不存在');const target=await currencyDefinition(connection,input.targetCurrency,true),results=[];
   for(const product of products){if(product.currency===target.code)continue;const source=await currencyDefinition(connection,product.currency),convert=(value:string|number)=>convertMinor(String(value),source,target),maps=(value:Record<string,string>)=>Object.fromEntries(Object.entries(value).map(([key,amount])=>[key,convert(amount)]));
    const price=convert(product.price_cents);await connection.query('UPDATE products SET currency=$2,price_cents=$3 WHERE id=$1',[product.id,target.code,price]);
    const periods=(await connection.query('SELECT * FROM product_periods WHERE product_id=$1 FOR UPDATE',[product.id])).rows;for(const period of periods)await connection.query('UPDATE product_periods SET price_cents=$3,setup_cents=$4 WHERE product_id=$1 AND period=$2',[product.id,period.period,convert(period.price_cents),convert(period.setup_cents)]);
    const options=(await connection.query('SELECT * FROM product_options WHERE product_id=$1 FOR UPDATE',[product.id])).rows;for(const option of options)await connection.query('UPDATE product_options SET prices=$3,setup_cents=$4,choices=$5 WHERE product_id=$1 AND key=$2',[product.id,option.key,JSON.stringify(maps(option.prices)),convert(option.setup_cents),JSON.stringify(option.choices.map((choice:Record<string,any>)=>({...choice,prices:maps(choice.prices),setupCents:convert(choice.setupCents)})))]);
    const custom=(await connection.query('SELECT * FROM product_custom_prices WHERE product_id=$1 AND currency=$2 FOR UPDATE',[product.id,source.code])).rows;for(const special of custom)await connection.query('UPDATE product_custom_prices SET currency=$2,price_cents=$3,setup_cents=$4 WHERE id=$1',[special.id,target.code,convert(special.price_cents),convert(special.setup_cents)]);
    const snapshot={productId:product.id,source,target,oldPriceCents:product.price_cents,priceCents:price};results.push(snapshot);await record(connection,request.actorId??request.user.id,'currency.reprice',product.id,snapshot);
   }if(results.length)await connection.query('SELECT pg_notify($1,$2)',['content_changed',JSON.stringify({paths:['/','/products']})]);return {products:results};
  });}
}
