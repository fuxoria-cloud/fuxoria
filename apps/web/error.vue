<!-- 页面错误出口：保留真实HTTP状态，给出可用的返回入口。调用：Nuxt收到页面错误时自动呈现。 -->
<script setup lang="ts">
import type { NuxtError } from '#app'; // 页面只读取公开的错误状态，不显示调用栈
import { ArrowLeft01Icon, Refresh01Icon } from '@hugeicons/core-free-icons'; // 返回与重试沿用同一套控件
const props = defineProps<{ error: NuxtError }>(); // HTTP状态由Nuxt保留
const missing = computed(() => props.error.statusCode === 404); // 撤回和不存在的内容使用同一诚实说明
const title = computed(() => (missing.value ? '这页暂时不在这里。' : '页面遇到了一点问题。')); // 文案不把错误包装成成功
useSeoMeta({ title: () => title.value, robots: 'noindex, nofollow' }); // 错误页不参与搜索索引
</script>
<template>
  <NuxtLayout name="default">
    <div class="page-width error-reading">
      <KimaCard class="error-card">
        <p class="eyebrow">{{ error.statusCode }}</p>
        <h1>{{ title }}</h1>
        <p class="section-description">
          {{
            missing
              ? '地址可能变了，或者内容已经撤回。可以从首页重新找一找。'
              : '请求暂时没有完成。请稍后重试，或回到首页继续。'
          }}
        </p>
        <div class="form-actions">
          <KimaButton @click="clearError({ redirect: '/' })">
            <template #leading><KimaIcon :icon="ArrowLeft01Icon" /></template>
            返回首页
          </KimaButton>
          <KimaButton v-if="!missing" variant="tonal" @click="reloadNuxtApp({ force: true })">
            <template #leading><KimaIcon :icon="Refresh01Icon" /></template>
            再试一次
          </KimaButton>
          <AppLink v-else to="/help" :underline="false">查看使用帮助</AppLink>
        </div>
      </KimaCard>
    </div>
  </NuxtLayout>
</template>
