<!-- 公共帮助和动态列表：同一内容主体按kind呈现。调用：访问/help或/news。 -->
<script setup lang="ts">
import {
  Search01Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  News01Icon,
} from '@hugeicons/core-free-icons'; // 阅读入口仍使用统一图标
import type { Article } from '~/types/api'; // 正文只按纯文本处理
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ validate: (route) => ['help', 'news'].includes(String(route.params.kind)) }); // 其它动态顶层路径不误变成成功页面
const route = useRoute();
const api = useApi(); // 类型从路由取，内容从API取
const kind = computed(() => String(route.params.kind)); // 同一组件支持公开帮助与动态
const title = computed(() => (kind.value === 'help' ? '使用帮助' : '最新动态')); // 用户读到具体内容类别
const query = ref(''); // 本地标题与正文筛选不改变文章
const { data, pending, error, refresh } = await useAsyncData(
  `content-${kind.value}`,
  () => api<Article[]>(`/content?kind=${kind.value}`),
  { server: false, watch: [kind] },
); // 静态入口不在构建时依赖在线API
const shown = computed(
  () =>
    data.value?.filter((article) =>
      `${article.title} ${article.content}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
    ) || [],
); // 同一份结果推导搜索视图
useSeoMeta({
  title: () => title.value,
  description: () =>
    kind.value === 'help'
      ? '查看狐岚云使用帮助，了解产品购买、服务管理、账单和支持。'
      : '查看狐岚云最近发布的公告、产品与服务动态。',
}); // 标题与可见内容保持一致
</script>
<template>
  <div class="page-width">
    <header class="catalog-heading">
      <span class="eyebrow">
        <KimaIcon :icon="kind === 'help' ? BookOpen01Icon : News01Icon" />
        狐岚云 · 云上日常
      </span>
      <h1>{{ title }}</h1>
      <p class="section-description">
        {{ kind === 'help' ? '按你遇到的情况，找到下一步。' : '看看云上最近发生了什么。' }}
      </p>
    </header>
    <section class="catalog-body">
      <label class="field-label content-search">
        <span class="form-label">{{ kind === 'help' ? '搜索帮助文章' : '搜索动态' }}</span>
        <KimaTextField
          v-model="query"
          :label="kind === 'help' ? '搜索帮助文章' : '搜索动态'"
          placeholder="输入想找的内容"
          clearable
        />
      </label>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="!shown.length && !pending && !error"
        :title="query ? '没有找到相关内容' : '内容正在准备中'"
        description="也可以通过工单联系支持，描述你遇到的情况。"
        action="联系支持"
        to="/console/tickets?new=1"
        @retry="refresh"
      />
      <div v-if="shown.length && !pending && !error" class="content-grid">
        <KimaCard
          v-for="article in shown"
          :key="article.id"
          clickable
          class="article-card"
          :aria-label="article.title"
          @click="router.push(`/${article.kind}/${article.slug}`)"
        >
          <div class="article-card-head">
            <h2>{{ article.title }}</h2>
            <KimaIcon :icon="ArrowUpRight01Icon" />
          </div>
          <p class="article-excerpt">{{ article.content.slice(0, 150) }}</p>
          <time class="article-date" :datetime="article.updatedAt">
            更新于 {{ date(article.updatedAt) }}
          </time>
        </KimaCard>
      </div>
    </section>
  </div>
</template>
