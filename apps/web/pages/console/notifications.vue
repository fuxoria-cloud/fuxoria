<!-- 站内消息：阅读和删除只影响当前账户。调用：/console/notifications。 -->
<script setup lang="ts">
import type { Notice } from '~/features/support';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '站内消息', robots: 'noindex, nofollow' });
const api = useApi(), page = ref(1), busy = ref(''), failure = ref('');
const { data, pending, error, refresh } = await useAsyncData(computed(() => `notifications:${page.value}`), () => api<{
    items: Notice[];
    total: number;
    unread: number;
    limit: number;
}>(`/notifications?page=${page.value}`)); // 各页返回真实消息和未读数
async function act(id: string, action: 'read' | 'delete' | 'all') {
    busy.value = id;
    failure.value = '';
    try {
        await api(action === 'all' ? '/notifications/read-all' : `/notifications/${id}${action === 'read' ? '/read' : ''}`, { method: action === 'delete' ? 'DELETE' : 'POST' });
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = '';
    }
}
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>站内消息</h1>
        <p>
          订单、服务和沟通的进展，都留在这里。
          <span v-if="data?.unread"> {{ data.unread }} 条未读</span>
        </p>
      </div>
      <KimaButton variant="tonal" :disabled="!!busy || !data?.unread" @click="act('all','all')">全部已读</KimaButton>
    </header>
    <KimaAlert v-if="failure" variant="danger" class="mb-5">{{ failure }}</KimaAlert>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="data?.items.length===0"
      title="暂时没有新消息"
      description="有新进展时，会出现在这里。"
      @retry="refresh"
    />
    <div class="grid gap-4">
      <article v-for="item in data?.items" :key="item.id" class="panel p-5 sm:p-7">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="text-lg font-semibold">
            {{ item.title }}
            <KimaChip v-if="!item.readAt" color="primary" size="sm">未读</KimaChip>
          </h2>
          <time class="muted text-sm">{{ date(item.createdAt) }}</time>
        </div>
        <p class="mt-4 whitespace-pre-wrap break-words">{{ item.message }}</p>
        <div class="mt-5 flex flex-wrap gap-3">
          <AppLink v-if="item.link" :to="item.link" :underline="false" class="min-h-11 inline-flex items-center">查看进展</AppLink>
          <KimaButton v-if="!item.readAt" variant="tonal" :disabled="!!busy" @click="act(item.id,'read')">标为已读</KimaButton>
          <KimaButton variant="text" :disabled="!!busy" @click="act(item.id,'delete')">删除</KimaButton>
        </div>
      </article>
    </div>
    <div v-if="data && data.total>data.limit" class="form-actions justify-between">
      <KimaButton variant="tonal" :disabled="page===1 || pending" @click="page--">上一页</KimaButton>
      <span>第 {{ page }} 页</span>
      <KimaButton variant="tonal" :disabled="page*data.limit>=data.total || pending" @click="page++">下一页</KimaButton>
    </div>
  </div>
</template>
