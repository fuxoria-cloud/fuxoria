/*
狐岚云前端：公共页面预渲染，账户页面每次读取当前会话。
调用：npm run dev --workspace @fuxoria/web；NUXT_API_ORIGIN=http://127.0.0.1:3301 npm run build --workspace @fuxoria/web。
*/
import { defineNuxtConfig } from 'nuxt/config'; // 明确使用 Nuxt 3 的配置类型
import { fileURLToPath } from 'node:url'; // 错误出口从当前配置文件定位，不依赖启动目录
export default defineNuxtConfig({
  // Nuxt 统一承接页面与资源
  compatibilityDate: '2025-11-01', // 固定框架默认行为，升级时再核对
  devtools: { enabled: false },
  pages: true, // 显式只使用已定义的页面入口
  experimental: { componentIslands: false }, // 当前业务没有服务端岛，不启用未使用入口                          // 管理系统不向浏览器暴露开发面板
  modules: ['@nuxtjs/tailwindcss'],
  imports: { dirs: ['features'] }, // 金额主体在一个文件中定义，模板按导出名称自动引用                       // Tailwind 处理通用布局和间距
  css: ['~/assets/css/kima.css', '~/assets/css/main.css'], // 组件共享同一套视觉变量
  features: { inlineStyles: false }, // 指纹CSS独立缓存，避免在每份HTML重复组件token
  tailwindcss: { cssPath: '~/assets/css/main.css' }, // 通用工具样式只构建一次
  typescript: { strict: true }, // 接口字段在构建前检查
  runtimeConfig: {
    // 线上环境通过 Nuxt 环境变量替换
    apiOrigin: 'http://127.0.0.1:3301',
    trustProxyCidrs: '', // 默认不信任XFF，部署可用NUXT_TRUST_PROXY_CIDRS明确配置                     // Docker用NUXT_API_ORIGIN指向api容器
    public: { apiBase: '/api/v1', siteUrl: '' }, // 未配置域名时不编造 canonical
  },
  app: {
    head: {
      // 所有页面共享基础元信息
      htmlAttrs: { lang: 'zh-CN', 'data-kima-theme': 'dark' }, // 读屏器按简体中文朗读
      titleTemplate: '%s · 狐岚云', // 页面标题始终包含品牌
      meta: [{ name: 'theme-color', content: '#101418' }], // 手机浏览器与页面底色一致
      link: [{ rel: 'icon', type: 'image/png', href: '/brand/fuxoria-logo.png' }], // favicon使用同一生图标识，不保留旧版图标
    },
  },
  nitro: {
    esbuild: { options: { target: 'es2022' } },
    prerender: { crawlLinks: false, routes: ['/', '/products', '/help', '/news'] },
  }, // 私有页面不进入静态输出
  hooks: {
    'nitro:config'(config) {
      const existing = config.errorHandler ? [config.errorHandler].flat() : []; // 保留Nuxt自己的HTML错误处理器
      config.errorHandler = [fileURLToPath(new URL('./server/errors.ts', import.meta.url)), ...existing]; // JSON出口先处理，HTML仍落到后续框架出口
    },
  },
  routeRules: {
    // 缓存边界按是否包含个人信息划分
    '/': {
      prerender: true,
      headers: { 'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=600' },
    },
    '/help': { prerender: true, headers: { 'cache-control': 'public, max-age=0, s-maxage=300' } },
    '/news': { prerender: true, headers: { 'cache-control': 'public, max-age=0, s-maxage=300' } },
    '/help/**': { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } },
    '/news/**': { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } },
    '/page/**': { headers: { 'cache-control': 'public, max-age=0, s-maxage=60' } },
    '/products': {
      prerender: true,
      headers: { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' },
    },
    '/console/**': {
      ssr: false,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    },
    '/admin': {
      ssr: false,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    },
    '/admin/**': {
      ssr: false,
      headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
    },
    '/oauth/**': { ssr: false, headers: { 'cache-control': 'private, no-store', 'x-robots-tag':'noindex, nofollow' } },
    '/login': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } },
    '/register': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' } },
    '/recover': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' } },
    '/verify-login': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' } },
    '/verify-register': { headers: { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' } },
    '/api/v1/**': { headers: { 'cache-control': 'no-store' } },
    '/_nuxt/**': { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }, // 带指纹的资源可长期缓存
  },
});
