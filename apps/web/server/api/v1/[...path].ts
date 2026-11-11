/*
同源API入口：运行时决定目标，保留原始正文；只有明确可信代理才能提供客户端链。
调用：NUXT_API_ORIGIN=http://api:3301；可选NUXT_TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128。
*/
import { defineEventHandler, getRequestURL, getRequestIP, proxyRequest, type H3Event } from 'h3'; // HTTP转发保留方法、Origin、cookie和正文流
import proxyaddr from 'proxy-addr'; // 标准库按真实socket从右向左核对可信代理链

let compiledRules = ''; // 同一套部署配置只编译一次
let trusted: ReturnType<typeof proxyaddr.compile> = () => false; // 默认不信任任何自报代理链

function clientAddress(event: H3Event, configured: unknown) {
  // 只在HTTP输入边界决定可信客户端地址
  const socket = getRequestIP(event, { xForwardedFor: false }) || ''; // 真实连接地址不取浏览器传头
  if (typeof configured !== 'string') throw new Error('NUXT_TRUST_PROXY_CIDRS必须是明确的CIDR列表'); // 环境解析成布尔值时也拒绝，不降级成信任所有
  const rules = configured.trim(); // 环境配置允许前后空格
  if (rules !== compiledRules) {
    const networks = rules.split(/[,\s]+/).filter(Boolean); // 明确列出每个允许的CIDR
    if (networks.some((network) => !/^[0-9a-f:.]+\/[1-9]\d{0,2}$/i.test(network)))
      throw new Error('NUXT_TRUST_PROXY_CIDRS只能包含明确CIDR，不能使用true或信任全部来源'); // /0、别名和通配符都拒绝
    trusted = proxyaddr.compile(networks); // 库进一步验证IPv4/IPv6地址与前缀是否合法
    compiledRules = rules; // 只在成功编译后替换当前可信规则
  }
  if (!rules || !socket) return socket; // 默认走socket，内部无socket请求也不相信XFF
  return proxyaddr(event.node.req, trusted) || socket; // 只向前穿过配置明确允许的代理
}

export default defineEventHandler((event) => {
  // 不解析业务JSON或支付机构通知正文
  const address = getRequestURL(event); // 路径和原查询一起转发
  const config = useRuntimeConfig(event); // Docker启动后仍可改变API地址
  const client = clientAddress(event, config.trustProxyCidrs); // 缓存编译结果，不每次请求重建
  return proxyRequest(event, `${config.apiOrigin}${address.pathname}${address.search}`, {
    streamRequest: true, // 支付回调不解码、不重新序列化
    headers: { 'x-forwarded-for': client, 'x-real-ip': client, forwarded: '' }, // 覆盖伪造来源，旧Forwarded不传给API
    fetchOptions: { redirect: 'manual' }, // 不在代理背后自动跟随跳转
  });
});
