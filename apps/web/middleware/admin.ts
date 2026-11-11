/* 管理页入口：仅管理员可查看；API 仍独立验证权限。调用：definePageMeta({ middleware: ['account', 'admin'] })。 */
export default defineNuxtRouteMiddleware(() => {
  // 账户中间件先向后端确认用户
  const { user } = useAccount(); // 避免在两个地方解释用户角色
  if (user.value && user.value.role !== 'admin') return navigateTo('/console'); // 普通账户返回自己的服务
});
