/**
 * HTTP响应读取：支付网关正文最多64KiB，超过后取消读取。
 * 调用：const raw = await body(response); 然后交给对应协议验签。
 */
import { fail } from './input.js';                             // 机构响应错误带上可识别状态

/** @param response HTTP返回值。 @returns 有限大小的原始字节。 */
export async function body(response: Response) {
  if (Number(response.headers.get('content-length') ?? 0) > 65_536) throw fail(502, '支付网关响应超过64KiB'); // 提前拒绝已知超大正文
  const reader = response.body?.getReader();                   // 流式读取，避免先分配整个超大正文
  if (!reader) throw fail(502, '支付网关返回空正文');           // 空HTTP结果不等于支付成功
  const chunks: Buffer[] = [];                                 // 只保留限额内的数据
  let length = 0;                                             // 按字节计算响应大小
  while (true) {
    const next = await reader.read();                          // 等待下一段正文
    if (next.done) break;                                      // 到达正文结尾
    length += next.value.byteLength;                           // 更新本次响应的字节总数
    if (length > 65_536) { await reader.cancel(); throw fail(502, '支付网关响应超过64KiB'); } // 立刻停止继续下载
    chunks.push(Buffer.from(next.value));                      // 保存仍在限额内的数据段
  }
  return Buffer.concat(chunks);                               // 原始字节交协议层验签
}
