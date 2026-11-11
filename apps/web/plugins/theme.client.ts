/* 主题启动：恢复cookie，并让Nuxt头部与KIMA始终读取同一个模式。调用：Nuxt自动加载。 */
export default defineNuxtPlugin(() => {
  // 客户端恢复不会把用户偏好写入公共静态页
  const theme = useTheme(); // 主题由唯一共享状态保管
  theme.restore(); // 先按真实cookie应用整套配色
  useHead({ htmlAttrs: { 'data-kima-theme': theme.mode } }); // 后续头部更新不再覆盖动态模式
});
