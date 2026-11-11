/* 商品目录：3.7.6的分组、可配置选项、周期与服务端报价。
 * 调用：GET /catalogue；POST /catalogue/quote {productId,period,configuration}。
 * 后台：POST/PUT /admin/catalogue/groups；PUT /admin/catalogue/products/:id整体保存周期和配置。
 */
import {currencyDefinition} from './currency.js';
import { Body,Controller,Get,Header,Param,Post,Put,Req,ConflictException,NotFoundException } from '@nestjs/common'; // 目录与报价属于同一商品主体
import { createHash } from 'node:crypto'; // 选择内容生成稳定行标识，不把价格放进客户端标识
import type { Pool,PoolClient } from 'pg'; // 下单和配置编辑共享商品行锁
import { z } from 'zod'; // 只在HTTP边界检查配置形状
import { pool,transaction } from './store.js';
import { record } from './audit.js';
import { Public,Roles,type SessionRequest } from '../utils/access.js';
import { read,uuid,price } from '../utils/input.js';
import { resolveOptions,customPrice,rulesFor,ruleOrder } from './catalogue-rule.js'; // 条件约束和专属价由自己的主体管理

export const periods={hour:{months:0,seconds:3600,renewable:true,label:'时付'},day:{months:0,seconds:86400,renewable:true,label:'日付'},ontrial:{months:0,seconds:0,renewable:false,label:'试用'},month:{months:1,seconds:0,renewable:true,label:'月付'},quarter:{months:3,seconds:0,renewable:true,label:'季付'},halfyear:{months:6,seconds:0,renewable:true,label:'半年付'},year:{months:12,seconds:0,renewable:true,label:'年付'},biennium:{months:24,seconds:0,renewable:true,label:'两年付'},triennium:{months:36,seconds:0,renewable:true,label:'三年付'},onetime:{months:0,seconds:0,renewable:false,label:'一次性'}} as const; // 试用实际秒数来自产品trial_days，续费能力不靠months=0猜测
export const periodSchema=z.enum(['hour','day','ontrial','month','quarter','halfyear','year','biennium','triennium','onetime']);
export type Period=keyof typeof periods;
const renewalLead={calendarSeconds:86400,fixedDivisor:4}; // 时付15分钟、日付6小时、日历月付24小时，数值只在这里定义
export function renewalWindowSeconds(period:Period,seconds=0){return !periods[period].renewable?0:seconds>0?Math.min(renewalLead.calendarSeconds,Math.max(1,Math.floor(seconds/renewalLead.fixedDivisor))):renewalLead.calendarSeconds;}
export function renewalWindowSQL(alias=''){const field=(alias?alias+'.':'')+'billing_seconds';return `CASE WHEN ${field}>0 THEN least(${renewalLead.calendarSeconds},greatest(1,${field}/${renewalLead.fixedDivisor})) ELSE ${renewalLead.calendarSeconds} END`;}
export type Configuration=Record<string,string|number|boolean>;
export const configurationSchema=z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),z.union([z.string().max(100),z.number().int().min(0).max(100000),z.boolean()])).refine(value=>Object.keys(value).length<=50,'配置项过多').default({});
export const selectionSchema=z.object({productId:uuid.transform(value=>value.toLowerCase()),quantity:z.number().int().min(1).max(20),period:periodSchema.default('month'),configuration:configurationSchema}).strict();
export type Selection=z.infer<typeof selectionSchema>;
type Connection=Pool|PoolClient;

/** @returns 相同商品、周期和配置拥有同一行ID，金额变化不会改变客户选择。 */
export function lineKey(item:{productId:string;period:string;configuration?:Configuration}){
  return createHash('sha256').update(JSON.stringify({productId:item.productId.toLowerCase(),period:item.period,configuration:Object.fromEntries(Object.entries(item.configuration??{}).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');
}

const pricesSchema=z.partialRecord(periodSchema,price).default({});
const choiceSchema=z.object({value:z.string().min(1).max(100),label:z.string().trim().min(1).max(100),prices:pricesSchema,setupCents:price.default('0')}).strict();
const optionSchema=z.object({key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),name:z.string().trim().min(1).max(100),kind:z.enum(['select','quantity','boolean']),required:z.boolean().default(true),minimum:z.number().int().min(0).max(100000).default(0),maximum:z.number().int().min(0).max(100000).default(100),prices:pricesSchema,setupCents:price.default('0'),choices:z.array(choiceSchema).max(100).default([]),sort:z.number().int().default(0),active:z.boolean().default(true)}).strict().refine(input=>input.maximum>=input.minimum,'配置数量范围错误').refine(input=>input.kind!=='select'||input.choices.length>0,'下拉配置至少有一个选项').refine(input=>new Set(input.choices.map(choice=>choice.value)).size===input.choices.length,'配置选项值不能重复');
const cycleSchema=z.object({period:periodSchema,priceCents:price,setupCents:price.default('0'),active:z.boolean().default(true)}).strict().refine(input=>input.period!=='ontrial'||input.priceCents==='0'&&input.setupCents==='0','试用周期必须是零价且免安装费');
export const optionColumns='id,key,name,kind,required,minimum,maximum,prices,setup_cents::text AS "setupCents",choices,sort,active';

/** @returns 配置与周期公开资料，所有金额保持整数分字符串。 */
export async function productDetails(connection:Connection,id:string,includeInactive=false){
  const [cycles,options]=await Promise.all([connection.query('SELECT period,price_cents::text AS "priceCents",setup_cents::text AS "setupCents",active FROM product_periods WHERE product_id=$1 ORDER BY period',[id]),connection.query(`SELECT ${optionColumns} FROM product_options WHERE product_id=$1 ${includeInactive?'':'AND active'} ORDER BY sort,key`,[id])]);
  return {periods:cycles.rows,options:options.rows};
}

/** @returns 客户组明确设置的减免比例；未安装分组资料或未分组均无减免。 */
export async function groupDiscount(connection:Connection,userId:string){
  const user=(await connection.query("SELECT to_jsonb(u)->>'client_group_id' AS group_id FROM users u WHERE id=$1",[userId])).rows[0]; // 017可独立用于旧库测试，018提供可选客户组
  if(!user?.group_id)return 0;
  return Number((await connection.query('SELECT discount_percent FROM client_groups WHERE id=$1',[user.group_id])).rows[0]?.discount_percent??0);
}

/** @param product 已读取或锁住的商品。@param item 选择。@returns 配置快照及当前整数报价；下单在调用者事务中使用。 */
export async function quoteSelection(connection:Connection,product:Record<string,any>,item:Selection,discountPercent=0,context:{userId?:string;normalize?:boolean}={}){
  if(!product?.active)throw new ConflictException('商品已下架或不存在');
  const currency=await currencyDefinition(connection,product.currency,true);
  if(product.group_id){
    const hidden=await connection.query('WITH RECURSIVE parents AS (SELECT id,parent_id,active FROM product_groups WHERE id=$1 UNION ALL SELECT g.id,g.parent_id,g.active FROM product_groups g JOIN parents p ON g.id=p.parent_id) SELECT 1 FROM parents WHERE NOT active LIMIT 1',[product.group_id]);
    if(hidden.rowCount)throw new ConflictException('这个商品分组暂未开放购买');
  }
  const details=await productDetails(connection,product.id);
  const resolved=await resolveOptions(connection,product.id,details.options,item.configuration,item.period,context.normalize);
  const selected=details.periods.find(cycle=>cycle.period===item.period);
  if(selected && !selected.active || !selected && item.period!=='month')throw new ConflictException('该商品当前不支持所选计费周期');
  let recurring=BigInt(selected?.priceCents??product.price_cents),setup=BigInt(selected?.setupCents??'0');
  const configuration:Configuration={},labels:Record<string,string>={};
  for(const option of resolved.options.filter(option=>!option.hidden)){
    const supplied=resolved.configuration[option.key];
    if(option.kind==='quantity'){
      const quantity=supplied===undefined?option.minimum:supplied;
      if(typeof quantity!=='number'||!Number.isInteger(quantity)||quantity<option.minimum||quantity>option.maximum)throw new ConflictException(`${option.name}数量不在允许范围内`);
      configuration[option.key]=quantity;labels[option.name]=String(quantity);
      recurring+=BigInt(option.prices[item.period]??'0')*BigInt(quantity);setup+=BigInt(option.setupCents)*BigInt(quantity);
    }else if(option.kind==='boolean'){
      const enabled=supplied===undefined?false:supplied;
      if(typeof enabled!=='boolean')throw new ConflictException(`${option.name}请选择是或否`);
      configuration[option.key]=enabled;labels[option.name]=enabled?'是':'否';
      if(enabled){recurring+=BigInt(option.prices[item.period]??'0');setup+=BigInt(option.setupCents);}
    }else{
      const value=supplied===undefined?(option.required?option.choices[0]?.value:''):supplied;
      if(!value && !option.required)continue;
      const choice=option.choices.find((choice:Record<string,any>)=>choice.value===value);
      if(!choice)throw new ConflictException(`${option.name}的选项已不可用`);
      configuration[option.key]=String(value);labels[option.name]=choice.label;
      recurring+=BigInt(choice.prices[item.period]??'0');setup+=BigInt(choice.setupCents??'0');
    }
  }
  const cataloguePrice=recurring+setup;
  const special=await customPrice(connection,product.id,context.userId,item.period,product.currency,configuration);
  if(special){recurring=BigInt(special.priceCents);setup=BigInt(special.setupCents);}
  if(item.period==='ontrial'){
    if(item.quantity!==1)throw new ConflictException('每次试用只能申请一件服务');
    if(context.userId&&(await connection.query('SELECT 1 FROM trial_claims WHERE user_id=$1 AND product_id=$2',[context.userId,product.id])).rowCount)throw new ConflictException('这个主账号已使用过本商品试用，请选择正式付费周期');
    recurring=0n;setup=0n;
  }
  const original=recurring+setup;
  if(original>999999999999n)throw new ConflictException('配置后的金额超出单件允许范围'); // 原价与折扣快照也必须处于相同可保存的价格范围
  recurring=recurring*BigInt(100-discountPercent)/100n;setup=setup*BigInt(100-discountPercent)/100n; // 与客户组约定一致，分别向下取到分
  if(recurring+setup>999999999999n)throw new ConflictException('配置后的金额超出单件允许范围');
  return {...item,configuration,configurationLabels:labels,options:resolved.options,pricingSource:{currency, catalogueUnitPriceCents:cataloguePrice.toString(),rules:resolved.rules,customPrice:special},lineId:lineKey({...item,configuration}),billingMonths:periods[item.period].months,billingSeconds:item.period==='ontrial'?product.trial_days*86400:periods[item.period].seconds,periodLabel:periods[item.period].label,originalUnitPriceCents:original.toString(),unitPriceCents:(recurring+setup).toString(),renewAmountCents:recurring.toString(),setupCents:setup.toString(),discountCents:(original-recurring-setup).toString(),productName:product.name,currency:product.currency,currencyDecimals:currency.decimals};
}

@Controller()
export default class Catalogue {
  @Public() @Header('Cache-Control','public, max-age=15, s-maxage=30, stale-while-revalidate=30') @Get('catalogue') async list(){
    return {groups:(await pool.query('SELECT id,parent_id AS "parentId",name,description,sort,active FROM product_groups g WHERE active AND NOT EXISTS(WITH RECURSIVE parents AS(SELECT id,parent_id,active FROM product_groups WHERE id=g.parent_id UNION ALL SELECT p.id,p.parent_id,p.active FROM product_groups p JOIN parents a ON p.id=a.parent_id) SELECT 1 FROM parents WHERE NOT active) ORDER BY sort,name')).rows,periods:Object.entries(periods).map(([period,value])=>({period,...value}))};
  }
  @Public() @Post('catalogue/quote') async quote(@Body() body:unknown){
    const input=read(selectionSchema,body);
    return transaction(async connection=>{
      const product=(await connection.query('SELECT * FROM products WHERE id=$1 FOR SHARE',[input.productId])).rows[0];
      if(!product)throw new NotFoundException('商品不存在');
      const quote=await quoteSelection(connection,product,input,0,{normalize:true});
      return {...quote,amountCents:(BigInt(quote.unitPriceCents)*BigInt(input.quantity)).toString()};
    });
  }
  @Post('catalogue/my-quote') async personalQuote(@Body() body:unknown,@Req() request:SessionRequest){const input=read(selectionSchema,body);return transaction(async connection=>{const product=(await connection.query('SELECT * FROM products WHERE id=$1 FOR SHARE',[input.productId])).rows[0];if(!product)throw new NotFoundException('商品不存在');const quote=await quoteSelection(connection,product,input,await groupDiscount(connection,request.user.id),{userId:request.user.id,normalize:true});return {...quote,amountCents:(BigInt(quote.unitPriceCents)*BigInt(input.quantity)).toString()};});}
  @Roles('admin') @Get('admin/catalogue') async admin(){
    return {groups:(await pool.query('SELECT id,parent_id AS "parentId",name,description,sort,active FROM product_groups ORDER BY sort,name')).rows,products:(await pool.query('SELECT id,name,price_cents::text AS "priceCents",group_id AS "groupId",currency,(SELECT decimals FROM currencies WHERE code=currency) AS "currencyDecimals",trial_days AS "trialDays",active FROM products ORDER BY name')).rows,periods:Object.entries(periods).map(([period,value])=>({period,...value}))};
  }
  @Roles('admin') @Post('admin/catalogue/groups') async group(@Body() body:unknown,@Req() request:SessionRequest){
    const input=read(z.object({name:z.string().trim().min(1).max(100),description:z.string().trim().max(2000).default(''),parentId:uuid.nullable().default(null),sort:z.number().int().default(0),active:z.boolean().default(true)}).strict(),body);
    return transaction(async connection=>{
      const result=(await connection.query('INSERT INTO product_groups(name,description,parent_id,sort,active) VALUES($1,$2,$3,$4,$5) RETURNING id',[input.name,input.description,input.parentId,input.sort,input.active])).rows[0];
      await record(connection,request.user.id,'catalogue.group.create',result.id,input);return result;
    });
  }
  @Roles('admin') @Put('admin/catalogue/groups/:id') async updateGroup(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest){
    read(uuid,id);const input=read(z.object({name:z.string().trim().min(1).max(100),description:z.string().trim().max(2000).default(''),parentId:uuid.nullable().default(null),sort:z.number().int().default(0),active:z.boolean().default(true)}).strict(),body);
    return transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(812447)'); // 父子层级修改串行，不能并发制造环
      if(input.parentId){const cycle=await connection.query('WITH RECURSIVE parents AS (SELECT id,parent_id FROM product_groups WHERE id=$1 UNION ALL SELECT g.id,g.parent_id FROM product_groups g JOIN parents p ON g.id=p.parent_id) SELECT 1 FROM parents WHERE id=$2',[input.parentId,id]);if(cycle.rowCount)throw new ConflictException('商品分组不能互相包含');}
      const result=await connection.query('UPDATE product_groups SET name=$2,description=$3,parent_id=$4,sort=$5,active=$6 WHERE id=$1 RETURNING id',[id,input.name,input.description,input.parentId,input.sort,input.active]);
      if(!result.rowCount)throw new NotFoundException('分组不存在');await record(connection,request.user.id,'catalogue.group.update',id,input);return result.rows[0];
    });
  }
  @Roles('admin') @Get('admin/catalogue/products/:id') async configuration(@Param('id') id:string){read(uuid,id);const product=(await pool.query('SELECT trial_days AS "trialDays",currency,(SELECT decimals FROM currencies WHERE code=currency) AS "currencyDecimals" FROM products WHERE id=$1',[id])).rows[0];if(!product)throw new NotFoundException('商品不存在');return {...await productDetails(pool,id,true),...product};}
  @Roles('admin') @Put('admin/catalogue/products/:id') async configure(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest){
    read(uuid,id);const input=read(z.object({groupId:uuid.nullable().default(null),trialDays:z.number().int().min(1).max(365).default(7),periods:z.array(cycleSchema).min(1).max(10),options:z.array(optionSchema).max(50).default([])}).strict().refine(input=>new Set(input.periods.map(cycle=>cycle.period)).size===input.periods.length,'周期不能重复').refine(input=>new Set(input.options.map(option=>option.key)).size===input.options.length,'配置名称标识不能重复'),body);
    return transaction(async connection=>{
      const saved=await connection.query('UPDATE products SET group_id=$2,trial_days=$3 WHERE id=$1 RETURNING id',[id,input.groupId,input.trialDays]); // 与下单持有同一商品锁
      if(!saved.rowCount)throw new NotFoundException('商品不存在');
      await connection.query('DELETE FROM product_periods WHERE product_id=$1',[id]);await connection.query('DELETE FROM product_options WHERE product_id=$1',[id]);
      for(const cycle of input.periods)await connection.query('INSERT INTO product_periods(product_id,period,price_cents,setup_cents,active) VALUES($1,$2,$3,$4,$5)',[id,cycle.period,cycle.priceCents,cycle.setupCents,cycle.active]);
      for(const option of input.options)await connection.query('INSERT INTO product_options(product_id,key,name,kind,required,minimum,maximum,prices,setup_cents,choices,sort,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,option.key,option.name,option.kind,option.required,option.minimum,option.maximum,JSON.stringify(option.prices),option.setupCents,JSON.stringify(option.choices),option.sort,option.active]);
      ruleOrder(input.options.filter(option=>option.active),await rulesFor(connection,id)); // 不让配置编辑留下引用失效的活动规则
      await record(connection,request.user.id,'catalogue.configure',id,input);return productDetails(connection,id,true);
    });
  }
}
