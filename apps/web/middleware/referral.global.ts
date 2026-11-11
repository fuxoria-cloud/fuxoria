/* 推荐链接首次归因：?ref=22位随机代码保留30天，注册时交给后端核验。调用：所有公开页面自然进入。 */
export default defineNuxtRouteMiddleware((to) => {
  const code = typeof to.query.ref === 'string' ? to.query.ref : '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return;
  const referral = useCookie<string | null>('yunzou_referral', {
    maxAge: 30 * 86400,
    sameSite: 'lax',
    secure: import.meta.client
      ? location.protocol === 'https:'
      : useRequestURL().protocol === 'https:',
  });
  if (!referral.value) referral.value = code;
});
