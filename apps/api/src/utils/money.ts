/* 金额：把人民币文本转成整数分，杜绝浮点舍入。
 * 调用：cents('19.90') 得到 1990n；yuan('1990') 得到 '19.90'。
 */
import { BadRequestException } from '@nestjs/common';              // 输入错误交给HTTP入口统一反馈

/** @param value 人民币金额文本，最多两位小数。@returns 整数分。 */
export function cents(value: string): bigint {
  const text = value.trim();                                     // 先去掉用户输入的空格
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw new BadRequestException('金额最多两位小数');
  const [whole, fraction = ''] = text.split('.');                  // 分开元和角分
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));   // 全程整数运算
}

/** @param value 整数分。@returns 固定两位小数的展示金额。 */
export function yuan(value: string | bigint): string {
  const amount = BigInt(value);                                  // 数据库bigint按文本读取，保留精度
  const absolute = amount < 0n ? -amount : amount;                // 退款按负数显示
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
