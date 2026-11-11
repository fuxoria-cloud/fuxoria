/*
JSON错误出口：保留Nitro的安全错误格式，把默认404的no-cache改为不存储。
调用：nuxt.config的nitro:config钩子将本文件放在框架错误处理器之前；HTML继续交给Nuxt错误页。
*/
import type { NitroErrorHandler } from 'nitropack/types'; // 只使用Nitro公开的错误处理契约
import { getRequestHeader, send, setResponseHeaders, setResponseStatus } from 'h3'; // 状态与缓存头在真正发送前一起写入

const errors: NitroErrorHandler = async (error, event, { defaultHandler }) => {
  if ((getRequestHeader(event, 'accept') || '').includes('text/html') && !event.path.startsWith('/api/')) return; // 页面仍使用现有Kima错误页，不维护第二份HTML模板
  const response = await defaultHandler(error, event, { json: true }); // 敏感服务端错误由Nitro隐藏内部详情
  response.headers['cache-control'] = 'private, no-store'; // JSON/HEAD同样不能缓存撤回与私有错误
  response.headers['x-robots-tag'] = 'noindex, nofollow'; // 与HTML错误出口一致
  setResponseHeaders(event, response.headers); // 不再经过会写回no-cache的默认错误处理器
  setResponseStatus(event, response.status, response.statusText); // 保留真实404/500，不把错误改为200
  return send(event, JSON.stringify(response.body)); // HEAD由h3按HTTP语义省略正文
};
export default errors; // 只处理JSON分支，HTML由后续框架处理器呈现
