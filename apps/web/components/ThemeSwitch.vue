<!-- 深浅主题切换：直接使用KIMA图标按钮。调用：<ThemeSwitch />。 -->
<script setup lang="ts">
import { Sun01Icon, Moon02Icon } from '@hugeicons/core-free-icons'; // 全站只使用Hugeicons
const theme = useTheme(); // 主题状态集中在一个入口
</script>
<template>
  <ClientOnly>
    <KimaIconButton
      :icon="theme.dark.value ? Sun01Icon : Moon02Icon"
      :label="theme.dark.value ? '切换到浅色主题' : '切换到深色主题'"
      @click="theme.toggle"
    />
    <template #fallback><span class="theme-placeholder" aria-hidden="true" /></template>
  </ClientOnly>
</template>
