/* 狐岚云主题：KIMA青蓝种子只生成一套角色，状态由一个Nuxt state保管。调用：useTheme().toggle()。 */
import { applyPalette } from '@kernel4632/kima/theme'; // 官方主题入口负责角色与过渡

/** @returns 当前主题、浏览器启动恢复和切换操作。 */
export function useTheme() {
  // 多处主题按钮读取同一状态
  const mode = useState<'dark' | 'light'>('theme', () => 'dark'); // SSR和公共静态页固定默认深色
  const preference = useCookie<'dark' | 'light'>('yunzou_theme', {
    sameSite: 'lax',
    maxAge: 31536000,
  }); // cookie只保存外观偏好
  const dark = computed(() => mode.value === 'dark'); // 不让每个组件独立维护一份cookie响应状态
  function apply() {
    // 仅在浏览器调用，不重建组件样式
    document.documentElement.dataset.kimaTheme = mode.value; // 语义色与品牌角色使用同一模式
    applyPalette('#61afef', { isDark: dark.value }); // 主色、容器和文字整套更新
  }
  function restore() {
    // 首次显示不是用户主动切换主题
    mode.value = preference.value === 'light' ? 'light' : 'dark'; // 只从本地外观偏好恢复模式
    apply(); // 仍由官方入口生成整套角色
    document.documentElement.classList.remove('kima-theme-switching'); // 首屏直接采用偏好，避免从默认深色慢慢过渡
  }
  function toggle() {
    mode.value = dark.value ? 'light' : 'dark';
    preference.value = mode.value;
    apply();
  } // 明确把选择保存回cookie
  return { mode, dark, restore, apply, toggle }; // 外部不用直接操作颜色变量
}
