/*
错误响应的缓存出口：撤回文章和不存在的页面都不进入浏览器或共享缓存。
调用：Nitro自动加载；curl -I /help/不存在的文章应收到404和private,no-store。
*/
import { getResponseStatus, setHeader } from 'h3'; // 在最终发出响应前读取真实HTTP状态

export default defineNitroPlugin((app) => {
  app.hooks.hook('render:response', (response, { event }) => {
    if (!event.path.startsWith('/__nuxt_error') && (response.statusCode || 200) < 400) return; // Nuxt错误页的内部渲染可能仍是200，最终外层才设置原状态
    response.headers ||= {}; // 错误页头会由Nuxt复制到外层响应
    response.headers['cache-control'] = 'private, no-store'; // 覆盖Nuxt默认404的no-cache，撤回内容不留副本
    response.headers['x-robots-tag'] = 'noindex, nofollow'; // 与实际错误HTTP状态保持一致
  });
  app.hooks.hook('beforeResponse', (event) => {
    if (getResponseStatus(event) < 400) return; // 正常公开内容保留自己的短缓存
    setHeader(event, 'cache-control', 'private, no-store'); // 错误页不得覆盖删除后的正确内容
    setHeader(event, 'x-robots-tag', 'noindex, nofollow'); // 搜索结果不收录错误入口
  });
});
