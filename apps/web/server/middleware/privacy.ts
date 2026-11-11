/*
账户页面的缓存边界：大小写变体也不能进入公共缓存。
调用：Nitro 自动加载 server/middleware；curl -I http://127.0.0.1:3300/Console 应收到404和no-store。
*/
import { defineEventHandler, getRequestURL, setHeader, setResponseStatus, send } from 'h3'; // HTTP入口独立于Nuxt路由规则执行

export default defineEventHandler((event) => {
  // 每次请求先确定是否允许公共缓存
  const path = getRequestURL(event).pathname; // 路径只读取一次，不让页面组件参与判断
  let normalized: string; // 原始路径属于外部输入边界
  try {
    normalized = decodeURIComponent(path).toLowerCase();
  } catch {
    // 编码和大小写变体沿用相同隐私边界
    // 非法百分号编码按输入错误回应
    setHeader(event, 'cache-control', 'private, no-store'); // 不缓存畸形请求错误
    setResponseStatus(event, 400); // 不把用户URL错误当成程序500
    return send(event, 'Invalid request path', 'text/plain'); // 入口直接终止，不进入业务
  }
  const privatePage = ['/console', '/admin', '/login', '/register', '/recover', '/verify-login', '/verify-register', '/oauth', '/api'].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  ); // 覆盖页面及其子路径
  if (!privatePage) return; // 公共静态内容继续走指纹资源和CDN缓存
  setHeader(event, 'cache-control', 'private, no-store'); // 账户、API和错误页都不能存进共享缓存
  setHeader(event, 'x-robots-tag', 'noindex, nofollow'); // 搜索引擎不展示个人入口和私有接口
  if (path === normalized) return; // 标准路径继续交给真实业务路由
  setResponseStatus(event, 404); // 拒绝受保护路径别名，避免命中不同缓存规则
  return send(event, 'Page not found', 'text/plain'); // 直接结束入口，保留no-store而不被错误渲染覆盖
});
