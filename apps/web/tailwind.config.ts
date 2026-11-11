/* 狐岚云通用样式：布局、间距沿用 Tailwind 默认刻度。调用：Nuxt Tailwind 模块自动读取。 */
import type { Config } from 'tailwindcss'                 // 构建时核对 Tailwind 配置
export default {                                        // 自定义品牌色只从 CSS 变量取值
  content: [],                                           // 页面路径由 Nuxt 模块自动补充
  theme: { extend: { colors: { brand: 'var(--kima-color-primary)' } } }, // 避免在组件里维护第二份品牌颜色
  plugins: [],                                          // 当前交互使用原生表单元素
} satisfies Config
