/* 商品规则：条件图按依赖顺序约束下游选项，客户专属价格由服务端匹配并固定进成交快照。
 * 调用：PUT /admin/catalogue/products/:id/rules {rules:[{name,conditions:[{key,operator,value}],effects:[{key,allowedValues}]}]}。
 * 专属价：POST /admin/catalogue/products/:id/prices {userId,period,currency,priceCents,setupCents,configuration?,expiresAt?}。
 * 原证据：AdvancedOptionsController page/create/addCondition/addResult；ConfigOptionsController getNextLinkAgeList/saveLinkAgeLevel。
 */
import {Body,Controller,Get,Post,Put,Param,Req,ConflictException,NotFoundException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {pool,transaction} from './store.js';
import {record} from './audit.js';
import {Roles,type SessionRequest} from '../utils/access.js';
import {read,uuid,price} from '../utils/input.js';
import {periods,configurationSchema,quoteSelection,type Configuration,type Period} from './catalogue.js';

type Connection=Pool|PoolClient;
const optionKey=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const scalar=z.union([z.string().max(100),z.number().int().min(0).max(100000),z.boolean()]);
const condition=z.object({key:z.union([optionKey,z.literal('$period')]),operator:z.enum(['eq','neq','in','not_in','gte','lte']),value:z.union([scalar,z.array(scalar).min(1).max(100)])}).strict().refine(value=>!['gte','lte'].includes(value.operator)||typeof value.value==='number','数量条件需要整数').refine(value=>!['in','not_in'].includes(value.operator)||Array.isArray(value.value),'范围条件需要选项列表').refine(value=>!['eq','neq'].includes(value.operator)||!Array.isArray(value.value),'等于或不等于需要单个值');
const effect=z.object({key:optionKey,allowedValues:z.array(scalar).min(1).max(100).optional(),minimum:z.number().int().min(0).max(100000).optional(),maximum:z.number().int().min(0).max(100000).optional(),hidden:z.boolean().optional(),required:z.boolean().optional(),defaultValue:scalar.optional()}).strict().refine(value=>Object.keys(value).length>1,'请设置规则结果');
const ruleSchema=z.object({id:uuid.optional(),name:z.string().trim().min(1).max(100),priority:z.number().int().min(-2147483648).max(2147483647).default(0),active:z.boolean().default(true),match:z.enum(['all','any']).default('all'),conditions:z.array(condition).max(20),effects:z.array(effect).min(1).max(20)}).strict();
export type CatalogueRule=z.infer<typeof ruleSchema>;
export type EffectiveOption=Record<string,any>&{key:string;hidden:boolean;allowedValues?:Array<string|number|boolean>};
const columns='id,name,priority,active,match,conditions,effects';

export async function rulesFor(connection:Connection,productId:string,all=false):Promise<CatalogueRule[]>{return (await connection.query(`SELECT ${columns} FROM product_rules WHERE product_id=$1 ${all?'':'AND active'} ORDER BY priority,id`,[productId])).rows;}

/** @returns 依赖拓扑顺序。管理入口拒绝循环，报价无需反复迭代或猜测中间状态。 */
export function ruleOrder(options:Record<string,any>[],rules:CatalogueRule[]){
 const known=new Map(options.map(option=>[option.key,option])),edges=new Map(options.map(option=>[option.key,new Set<string>()])),degree=new Map(options.map(option=>[option.key,0]));
 for(const rule of rules.filter(rule=>rule.active)){
  for(const when of rule.conditions){if(when.key!=='$period'&&!known.has(when.key))throw new ConflictException(`规则“${rule.name}”引用了不存在的配置 ${when.key}`);const source=known.get(when.key),expected=Array.isArray(when.value)?when.value:[when.value];if(source&&(source.kind==='quantity'&&expected.some(value=>typeof value!=='number'||value<source.minimum||value>source.maximum)||source.kind==='boolean'&&expected.some(value=>typeof value!=='boolean')||source.kind==='select'&&expected.some(value=>typeof value!=='string'||value!==''&&!source.choices.some((choice:Record<string,any>)=>choice.value===value))||source.kind!=='quantity'&&['gte','lte'].includes(when.operator)))throw new ConflictException('规则条件的值与配置类型或允许范围不一致');if(when.key==='$period'){const values=Array.isArray(when.value)?when.value:[when.value];if(values.some(value=>typeof value!=='string'||!Object.hasOwn(periods,value)))throw new ConflictException('计费周期条件无效');}}
  for(const result of rule.effects){
   const target=known.get(result.key);if(!target)throw new ConflictException(`规则“${rule.name}”的结果配置不存在`);
   if(target.kind!=='quantity'&&(result.minimum!==undefined||result.maximum!==undefined)||target.kind==='quantity'&&result.allowedValues)throw new ConflictException('数量范围只用于数量资源，可选值列表只用于下拉或开关');
   if(result.defaultValue!==undefined&&(target.kind==='quantity'&&(typeof result.defaultValue!=='number'||result.defaultValue<target.minimum||result.defaultValue>target.maximum)||target.kind==='boolean'&&typeof result.defaultValue!=='boolean'||target.kind==='select'&&!target.choices.some((choice:Record<string,any>)=>choice.value===result.defaultValue)))throw new ConflictException('规则默认值不属于目标配置的允许值');
   if(target.kind==='select'&&result.allowedValues?.some(value=>!target.choices.some((choice:Record<string,any>)=>choice.value===value)))throw new ConflictException('规则包含不属于目标配置的选项');
   if(target.kind==='quantity'&&(result.minimum!==undefined&&(result.minimum<target.minimum||result.minimum>target.maximum)||result.maximum!==undefined&&(result.maximum>target.maximum||result.maximum<target.minimum)||result.minimum!==undefined&&result.maximum!==undefined&&result.minimum>result.maximum))throw new ConflictException('数量规则必须在产品允许范围内');
   if(target.kind==='boolean'&&result.allowedValues?.some(value=>typeof value!=='boolean'))throw new ConflictException('开关配置只接受是或否');
   for(const when of rule.conditions){if(when.key==='$period')continue;if(when.key===result.key)throw new ConflictException('规则条件与结果不能引用同一个配置');const links=edges.get(when.key)!;if(!links.has(result.key)){links.add(result.key);degree.set(result.key,degree.get(result.key)!+1);}}
  }
 }
 const ready=options.filter(option=>degree.get(option.key)===0).map(option=>option.key),ordered:Record<string,any>[]=[];
 while(ready.length){const key=ready.shift()!;ordered.push(known.get(key)!);for(const child of edges.get(key)!){degree.set(child,degree.get(child)!-1);if(degree.get(child)===0)ready.push(child);}}
 if(ordered.length!==options.length)throw new ConflictException('配置规则形成循环，请调整条件的引用顺序');return ordered;
}
function matches(when:z.infer<typeof condition>,values:Configuration){
 if(!Object.hasOwn(values,when.key))return false;const actual=values[when.key],expected=when.value;
 if(when.operator==='eq')return actual===expected;if(when.operator==='neq')return actual!==expected;
 if(when.operator==='in')return (expected as unknown[]).includes(actual);if(when.operator==='not_in')return !(expected as unknown[]).includes(actual);
 return typeof actual==='number'&&typeof expected==='number'&&(when.operator==='gte'?actual>=expected:actual<=expected);
}

/** @returns 当前选择下的真实可选项与规范配置。normalize仅用于交互报价；成交始终严格校验。 */
export async function resolveOptions(connection:Connection,productId:string,options:Record<string,any>[],supplied:Configuration,period:Period,normalize=false){
 const rules=await rulesFor(connection,productId),ordered=ruleOrder(options,rules),values:Configuration={'$period':period},configuration:Configuration={},effective:EffectiveOption[]=[],applied=new Set<string>();
 const known=new Set(options.map(option=>option.key));if(Object.keys(supplied).some(key=>!known.has(key)))throw new ConflictException('商品配置已经变化，请重新选择');
 for(const source of ordered){
  const option:EffectiveOption={...source,key:source.key,hidden:false,choices:source.choices.map((choice:Record<string,any>)=>({...choice}))};let preferred:unknown;
  for(const rule of rules){if(!(rule.match==='any'?rule.conditions.some(when=>matches(when,values)):rule.conditions.every(when=>matches(when,values))))continue;for(const result of rule.effects.filter(result=>result.key===option.key)){
   if(rule.id)applied.add(rule.id);if(result.hidden!==undefined)option.hidden=result.hidden;if(result.required!==undefined)option.required=result.required;
   if(result.minimum!==undefined)option.minimum=Math.max(option.minimum,result.minimum);if(result.maximum!==undefined)option.maximum=Math.min(option.maximum,result.maximum);
   if(result.allowedValues){option.allowedValues=option.allowedValues?option.allowedValues.filter(value=>result.allowedValues!.includes(value)):result.allowedValues;if(option.kind==='select')option.choices=option.choices.filter((choice:Record<string,any>)=>option.allowedValues!.includes(choice.value));}
   if(result.defaultValue!==undefined)preferred=result.defaultValue;
  }}
  effective.push(option);const provided=supplied[option.key];
  if(option.hidden){if(provided!==undefined&&!normalize)throw new ConflictException(`${option.name}在当前条件下不可选择`);continue;}
  let value:unknown=provided;
  if(option.kind==='quantity'){
   if(option.minimum>option.maximum)throw new ConflictException(`${option.name}当前没有可用数量范围`);if(value===undefined)value=preferred??option.minimum;
   if(normalize&&typeof value==='number')value=Math.max(option.minimum,Math.min(option.maximum,value));
   if(typeof value!=='number'||!Number.isInteger(value)||value<option.minimum||value>option.maximum)throw new ConflictException(`${option.name}数量不在允许范围内`);
  }else if(option.kind==='boolean'){
   if(value===undefined)value=preferred??false;if(normalize&&option.allowedValues&&!option.allowedValues.includes(value as boolean))value=option.allowedValues[0];
   if(typeof value!=='boolean'||option.allowedValues&&!option.allowedValues.includes(value))throw new ConflictException(`${option.name}在当前条件下不支持这个选择`);
  }else{
   if(value===undefined)value=preferred??(option.required?option.choices[0]?.value:'');if(normalize&&value!==''&&!option.choices.some((choice:Record<string,any>)=>choice.value===value))value=option.required?option.choices[0]?.value:'';
   if(value===''&&!option.required)continue;if(!option.choices.some((choice:Record<string,any>)=>choice.value===value))throw new ConflictException(`${option.name}的选项与当前配置不兼容`);
  }
  configuration[option.key]=value as string|number|boolean;values[option.key]=value as string|number|boolean;
 }
 return {options:effective,configuration,rules:rules.filter(rule=>!!rule.id&&applied.has(rule.id))};
}
export async function customPrice(connection:Connection,productId:string,userId:string|undefined,period:Period,currency:string,configuration:Configuration){
 if(!userId)return null;
 return (await connection.query('SELECT id,price_cents::text AS "priceCents",setup_cents::text AS "setupCents",configuration,expires_at AS "expiresAt" FROM product_custom_prices WHERE product_id=$1 AND user_id=$2 AND period=$3 AND currency=$4 AND active AND (expires_at IS NULL OR expires_at>now()) AND (configuration IS NULL OR configuration=$5::jsonb) ORDER BY (configuration IS NULL),id LIMIT 1',[productId,userId,period,currency,JSON.stringify(configuration)])).rows[0]??null;
}

@Controller('admin/catalogue/products') @Roles('admin')
export default class CatalogueRuleController {
 @Get(':id/rules') async list(@Param('id') id:string){return rulesFor(pool,read(uuid,id),true);}
 @Put(':id/rules') async save(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest){
  read(uuid,id);const input=read(z.object({rules:z.array(ruleSchema).max(100)}).strict(),body);
  return transaction(async connection=>{
   if(!(await connection.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[id])).rowCount)throw new NotFoundException('商品不存在');const options=(await connection.query('SELECT key,kind,minimum,maximum,choices FROM product_options WHERE product_id=$1 AND active',[id])).rows;ruleOrder(options,input.rules);
   await connection.query('DELETE FROM product_rules WHERE product_id=$1',[id]);
   for(const rule of input.rules)await connection.query('INSERT INTO product_rules(id,product_id,name,priority,active,match,conditions,effects) VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8)',[rule.id??null,id,rule.name,rule.priority,rule.active,rule.match,JSON.stringify(rule.conditions),JSON.stringify(rule.effects)]);
   await record(connection,request.actorId??request.user.id,'catalogue.rules.update',id,input);return rulesFor(connection,id,true);
  });
 }
 @Get(':id/prices') async prices(@Param('id') id:string){return (await pool.query('SELECT p.id,p.user_id AS "userId",u.email,u.name,p.period,p.currency,(SELECT decimals FROM currencies WHERE code=p.currency) AS "currencyDecimals",p.configuration,p.price_cents::text AS "priceCents",p.setup_cents::text AS "setupCents",p.active,p.expires_at AS "expiresAt" FROM product_custom_prices p JOIN users u ON u.id=p.user_id WHERE p.product_id=$1 ORDER BY p.created_at DESC,p.id',[read(uuid,id)])).rows;}
 @Post(':id/prices') async price(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest){
  read(uuid,id);const input=read(z.object({userId:uuid,period:z.string().refine(value=>Object.hasOwn(periods,value)),currency:z.string().regex(/^[A-Z]{3}$/).default('CNY'),configuration:configurationSchema.nullable().default(null),priceCents:price,setupCents:price.default('0'),active:z.boolean().default(true),expiresAt:z.string().datetime().nullable().default(null)}).strict(),body);
  return transaction(async connection=>{
   const product=(await connection.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!product)throw new NotFoundException('商品不存在');if(product.currency!==input.currency)throw new ConflictException('专属价必须与商品报价币种一致');if(input.period==='ontrial')throw new ConflictException('试用使用固定零价，不能创建专属试用价格');
   if(!(await connection.query("SELECT 1 FROM users WHERE id=$1 AND role='customer' AND NOT disabled AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.child_user_id=users.id)",[input.userId])).rowCount)throw new NotFoundException('可定价的客户主账号不存在');
   const configuration=input.configuration===null?null:(await quoteSelection(connection,product,{productId:id,quantity:1,period:input.period as Period,configuration:input.configuration},0)).configuration;
   await connection.query('DELETE FROM product_custom_prices WHERE product_id=$1 AND user_id=$2 AND period=$3 AND currency=$4 AND configuration IS NOT DISTINCT FROM $5::jsonb',[id,input.userId,input.period,input.currency,configuration===null?null:JSON.stringify(configuration)]);
   const saved=(await connection.query('INSERT INTO product_custom_prices(product_id,user_id,period,currency,configuration,price_cents,setup_cents,active,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[id,input.userId,input.period,input.currency,configuration===null?null:JSON.stringify(configuration),input.priceCents,input.setupCents,input.active,input.expiresAt])).rows[0];
   await record(connection,request.actorId??request.user.id,'catalogue.price.update',saved.id,{productId:id,...input,configuration});return saved;
  });
 }
}
