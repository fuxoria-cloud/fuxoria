/* 账户页入口：未登录时回到登录页。调用：definePageMeta({ middleware: 'account' })。 */
export default defineNuxtRouteMiddleware(async (to) => {
  // 路由切换时确认当前会话
  const account = useAccount(); // 账户状态只定义在一个位置
  try {
    await account.load();
  } catch (error) {
    // 入口接住外部 API 的会话错误
    // 网络故障保留页面错误处理能力
    if ((error as { statusCode?: number }).statusCode === 401)
      return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`); // 登录后返回原页
  }
});
