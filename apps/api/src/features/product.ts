/* 商品：公开读取可订购方案，库存与价格以PostgreSQL为准。
 * 调用：GET /api/v1/products；GET /api/v1/products/:id。
 */
import { Controller, Get, Header, Param, NotFoundException } from '@nestjs/common'; // 只暴露公开商品资料
import { pool } from './store.js';                                  // 商品数据单一来源
import { Public } from '../utils/access.js';                         // 购买前允许浏览
import { read, uuid } from '../utils/input.js';                      // 只在接口边界解析ID
import { productDetails } from './catalogue.js'; // 周期和配置是公开商品的一部分
import { optionColumns } from './catalogue.js';

export const productColumns='id,name,description,price_cents::text AS "priceCents",currency,(SELECT decimals FROM currencies WHERE code=currency) AS "currencyDecimals",stock,provider,active,group_id AS "groupId",trial_days AS "trialDays"'; // 前后台返回相同字段
const visible="active AND EXISTS(SELECT 1 FROM currencies WHERE code=p.currency AND active) AND NOT EXISTS(WITH RECURSIVE parents AS (SELECT id,parent_id,active FROM product_groups WHERE id=p.group_id UNION ALL SELECT g.id,g.parent_id,g.active FROM product_groups g JOIN parents a ON g.id=a.parent_id) SELECT 1 FROM parents WHERE NOT active)";

@Controller('products') @Public()
export default class Product {
  /** @returns 当前上架商品。 */
  @Header('Cache-Control','public, max-age=15, s-maxage=30, stale-while-revalidate=30') @Get() async list() {
    const found=(await pool.query(`SELECT ${productColumns} FROM products p WHERE ${visible} ORDER BY created_at,id`)).rows;
    const ids=found.map(product=>product.id);
    const [cycles,options]=await Promise.all([pool.query('SELECT product_id,period,price_cents::text AS "priceCents",setup_cents::text AS "setupCents",active FROM product_periods WHERE product_id=ANY($1::uuid[]) ORDER BY period',[ids]),pool.query(`SELECT product_id,${optionColumns} FROM product_options WHERE product_id=ANY($1::uuid[]) AND active ORDER BY sort,key`,[ids])]); // 目录固定三次SQL，不随商品数重复查询
    const grouped=new Map(found.map(product=>[product.id,{...product,periods:[] as Record<string,unknown>[],options:[] as Record<string,unknown>[]} ]));
    for(const {product_id,...cycle} of cycles.rows)grouped.get(product_id)!.periods.push(cycle);
    for(const {product_id,...option} of options.rows)grouped.get(product_id)!.options.push(option);
    return [...grouped.values()];
  }

  /** @param id 商品ID。@returns 一份公开商品。 */
  @Header('Cache-Control','public, max-age=15, s-maxage=30, stale-while-revalidate=30') @Get(':id') async get(@Param('id') id:string) {
    const result=await pool.query(`SELECT ${productColumns} FROM products p WHERE id=$1 AND ${visible}`,[read(uuid,id)]); // SQL参数化防止注入
    if (!result.rowCount) throw new NotFoundException('商品不存在或已下架'); // 明确说明用户能改的输入
    return {...result.rows[0],...await productDetails(pool,result.rows[0].id)};
  }
}
