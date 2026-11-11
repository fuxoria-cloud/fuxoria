<!-- 下载中心：文件范围由服务端核对，链接下载保留浏览器的文件保存流程。调用：/console/downloads。 -->
<script setup lang="ts">
import type { DownloadItem, ContentCategory } from '~/features/support';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '下载中心', robots: 'noindex, nofollow' });
const api = useApi(), query = ref(''), search = ref(''), categoryId = ref(''); // 输入完成后明确搜索，避免每次按键触发请求
const { data: categories } = await useAsyncData('download-categories', () => api<ContentCategory[]>('/downloads/categories'));
const endpoint = computed(() => '/downloads?' + new URLSearchParams({ q: search.value, ...(categoryId.value ? { categoryId: categoryId.value } : {}) }));
const { data, pending, error, refresh } = await useAsyncData(computed(() => `download-center:${endpoint.value}`), () => api<DownloadItem[]>(endpoint.value));
const categoryItems = computed(() => [{ value: '', label: '全部分类' }, ...(categories.value ?? []).map(item => ({ value: item.id, label: item.name }))]);
const base = useRuntimeConfig().public.apiBase;
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>下载中心</h1>
        <p>找到安装包、说明文档，以及你购买服务的配套资料。</p>
      </div>
    </header>
    <form
      class="panel p-5 mb-6 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_14rem_auto]"
      @submit.prevent="search=query.trim()"
    >
      <label class="field-label min-w-0">
        <span class="form-label">搜索文件</span>
        <KimaTextField v-model="query" label="搜索文件" placeholder="文件名称或说明" maxlength="160" />
      </label>
      <label class="field-label min-w-0">
        <span class="form-label">文件分类</span>
        <KimaSelect v-model="categoryId" label="文件分类" :items="categoryItems" />
      </label>
      <KimaButton type="submit" class="self-end">搜索</KimaButton>
    </form>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="data?.length===0"
      title="没有找到文件"
      description="试试其它关键词，或切换分类。"
      @retry="refresh"
    />
    <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
      <article v-for="item in data" :key="item.id" class="panel p-6 flex flex-col gap-4 min-w-0">
        <div>
          <p v-if="item.categoryName" class="muted mb-2 text-sm">{{ item.categoryName }}</p>
          <h2 class="font-semibold text-lg break-words">{{ item.title }}</h2>
        </div>
        <p class="whitespace-pre-wrap break-words">{{ item.description }}</p>
        <p class="muted text-sm break-all">{{ item.name }} · {{ Math.ceil(item.sizeBytes/1024) }} KB</p>
        <div class="mt-auto pt-2 flex items-center justify-between gap-4">
          <KimaChip size="sm">{{ item.access==='service'?'服务专属':item.access==='account'?'账户资料':'公开资料' }}</KimaChip>
          <a
            :href="`${base}/downloads/${item.id}/file`"
            download
            class="min-h-11 inline-flex items-center px-4 rounded-xl bg-[var(--kima-color-primary-container)] text-[var(--kima-color-on-primary-container)] font-medium"
          >
            下载文件
          </a>
        </div>
      </article>
    </div>
  </div>
</template>
