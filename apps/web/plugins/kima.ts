/*
KIMA组件与按需样式：所有页面直接使用库组件，不重画内部控件。
调用：Nuxt自动加载；模板可用 <KimaButton>保存</KimaButton>。
*/
import {
  KimaButton,
  KimaIconButton,
  KimaIcon,
  KimaLink,
  KimaCard,
  KimaTextField,
  KimaTextarea,
  KimaSelect,
  KimaTable,
  KimaRadioGroup,
  KimaDrawer,
  KimaChip,
  KimaAlert,
  KimaEmptyState,
  KimaSkeleton,
  KimaQrCode,
  KimaCollapsible,
} from '@kernel4632/kima'; // 组件按具名导出由构建裁剪

export default defineNuxtPlugin((app) => {
  // 注册已选择的稳定外部组件
  const components = {
    KimaButton,
    KimaIconButton,
    KimaIcon,
    KimaLink,
    KimaCard,
    KimaTextField,
    KimaTextarea,
    KimaSelect,
    KimaTable,
    KimaRadioGroup,
    KimaDrawer,
    KimaChip,
    KimaAlert,
    KimaEmptyState,
    KimaSkeleton,
    KimaQrCode,
    KimaCollapsible,
  }; // 只有实际使用的组件进入应用
  for (const [name, component] of Object.entries(components)) app.vueApp.component(name, component); // 不包装、不改外部库内部样式
});
