/*
同源 API 请求、错误说明与日期展示。调用：const api = useApi(); await api<Product[]>('/products')。
会话只留在 HttpOnly cookie；页面不把令牌写入 localStorage。
*/
import type { FetchOptions, $Fetch } from 'ofetch'; // 保留框架请求参数的类型

/** @returns 带当前会话、同源地址的 API 请求函数。 */
export function useApi() {
  // 一个位置决定请求地址和凭据
  const baseURL = useRuntimeConfig().public.apiBase; // 部署时可统一替换 API 前缀
  const request = useRequestFetch() as $Fetch; // 服务端渲染时转发当前请求的会话
  return <T>(path: string, options: FetchOptions<'json'> = {}) =>
    request<T>(`${baseURL}${path}`, { credentials: 'include', ...options }); // 原样返回业务结果
}

/** @param error API 或网络错误。@returns 可直接给用户看的中文原因。 */
export function apiMessage(error: unknown): string {
  // 请求边界统一解释外部错误
  const failure = error as {
    data?: { message?: string | string[]; requestId?: string };
    statusCode?: number;
  }; // 读取后端错误体
  const message = failure?.data?.message; // 优先保留后端具体业务原因
  if (typeof message === 'string')
    return failure.statusCode && failure.statusCode >= 500 && failure.data?.requestId
      ? `${message}（请求编号：${failure.data.requestId}）`
      : message; // 金额不足、库存变化等原因直接展示
  if (Array.isArray(message)) return message.join('；'); // 多个字段错误放在同一提示中
  if (failure?.statusCode === 401) return '登录已过期，请重新登录。'; // 具体密码错误优先使用后端提示
  if (error instanceof Error && !('statusCode' in error)) return error.message; // 表单边界的本地金额错误可直接修正
  return '暂时连接不上服务，请稍后重试。'; // 网络中断不显示虚构的业务数据
}

/** @param value ISO 日期。@returns 本地中文日期。 */
export function date(value?: string): string {
  // 所有页面使用相同日期格式
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value))
    : '—'; // 没有日期就明确留空
}
