/* HTTP输入：在系统边界整理和验证数据；内部主体收到的都是已验证值。
 * 调用：const {id}=read(z.object({id:uuid}),request.params)。
 */
import { BadRequestException } from '@nestjs/common';            // 把格式问题反馈给用户
import { z } from 'zod';                                        // 输入结构统一使用Zod

export const uuid = z.string().uuid();                          // 所有业务ID使用UUID，拒绝SQL片段
export const money = z.string().regex(/^[1-9]\d{0,11}$/);         // 金额是正整数分的文本
export const price = z.string().regex(/^(0|[1-9]\d{0,11})$/);     // 商品可免费，收款与退款仍使用严格正金额

/** @param schema 边界数据格式。@param value 外部输入。@returns 已整理的可信数据。 */
export function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);                        // 一次完成整理和校验
  if (!result.success) throw new BadRequestException(result.error.issues.map(item => item.message).join('；'));
  return result.data;                                           // 主体无需反复检查类型
}
