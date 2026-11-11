<!-- 公开文章：服务端可渲染，部署器也可按修订生成同一路径的静态HTML。调用：/help/文章路径。 -->
<script setup lang="ts">
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons'; // 阅读后的返回入口
import type { Article } from '~/types/api'; // 文章来源只有内容API
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({
  validate: (route) => ['help', 'news', 'page'].includes(String(route.params.kind)),
}); // 保留明确的公开路径范围
const route = useRoute();
const api = useApi(); // slug由服务端统一检查允许字符
const { data: article, error } = await useAsyncData(`article-${route.params.slug}`, () =>
  api<Article>(`/content/${encodeURIComponent(String(route.params.slug))}`),
); // SSR读取真实已发布文章
if (error.value)
  throw createError({
    fatal: true, // 客户端AJAX读取失败也呈现可恢复错误页，不能只留下空正文
    statusCode: (error.value as { statusCode?: number }).statusCode || 502,
    statusMessage: 'Content unavailable',
    message: apiMessage(error.value),
  }); // 撤回内容不伪装成200页面
if (article.value && article.value.kind !== route.params.kind)
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true }); // 规范路径不匹配在客户端同样显示404说明
useSeoMeta({
  title: () => article.value?.title || '文章',
  description: () => article.value?.content.slice(0, 150) || '',
}); // 元信息来自实际文章
const siteUrl = useRuntimeConfig().public.siteUrl; // 域名由部署配置提供
if (siteUrl)
  useHead({
    link: [{ rel: 'canonical', href: `${siteUrl}/${route.params.kind}/${route.params.slug}` }],
  }); // 只使用已配置正式域名
</script>
<template>
  <div v-if="article" class="page-width article-reading">
    <AppLink
      :to="article.kind === 'news' ? '/news' : '/help'"
      :underline="false"
      class="auth-back"
    >
      <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
      {{ article.kind === 'news' ? '返回最新动态' : '返回使用帮助' }}
    </AppLink>
    <header class="article-heading">
      <h1>{{ article.title }}</h1>
      <time :datetime="article.updatedAt">更新于 {{ date(article.updatedAt) }}</time>
    </header>
    <article class="article-body">{{ article.content }}</article>
    <KimaCard class="mt-12">
      <div class="support-content">
        <p class="muted">还需要一点帮助？把具体情况留在工单里。</p>
        <KimaButton variant="tonal" @click="router.push('/console/tickets?new=1')">
          联系支持
        </KimaButton>
      </div>
    </KimaCard>
  </div>
</template>
