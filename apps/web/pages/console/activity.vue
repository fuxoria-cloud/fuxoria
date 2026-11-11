<!-- 客户活动：当前账号的业务事件，只读筛选和序号分页。调用：/console/activity。 -->
<script setup lang="ts">
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '活动记录', robots: 'noindex, nofollow' });
interface Event {
  id: string;
  action: string;
  label: string;
  target: string;
  createdAt: string;
  bySelf: boolean;
}
interface Page {
  items: Event[];
  next: string | null;
  actions: { value: string; label: string }[];
}
const api = useApi(),
  filter = ref(''),
  from = ref(''),
  to = ref(''),
  search = ref(''),
  more = ref(false),
  message = ref(''),
  { data, error, pending, refresh } = await useAsyncData('activity', () =>
    api<Page>('/activity', {
      query: query(),
    }),
  );
function query() {
  return {
    ...(filter.value ? { action: filter.value } : {}),
    ...(from.value ? { from: from.value } : {}),
    ...(to.value ? { to: to.value } : {}),
    ...(search.value.trim() ? { q: search.value.trim() } : {}),
  };
}
const options = computed(() => [
  { value: '', label: '全部事件' },
  ...(data.value?.actions ?? []),
]);
watch(filter, () => {
  void refresh();
});
async function next() {
  if (!data.value?.next) return;
  more.value = true;
  message.value = '';
  try {
    const result = await api<Page>('/activity', {
      query: {
        before: data.value.next,
        ...query(),
      },
    });
    data.value = { ...result, items: [...data.value.items, ...result.items] };
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    more.value = false;
  }
}
</script>
<template>
  <main class="page-stack identity-page activity-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">ACCOUNT ACTIVITY</p>
        <h1>活动记录</h1>
        <p class="muted">查看自己的订单、服务、工单和账号操作。</p>
      </div>
      <KimaButton variant="tonal" :loading="pending" @click="refresh()"
        >刷新</KimaButton
      >
    </header>
    <section class="panel identity-stack">
      <form class="identity-fields" @submit.prevent="refresh()">
        <KimaSelect
          v-model="filter"
          label="事件类型"
          :items="options"
        /><KimaTextField
          v-model="search"
          label="搜索事件"
          maxlength="80"
          placeholder="例如：续费、工单"
        /><KimaTextField
          v-model="from"
          label="开始日期"
          type="date"
        /><KimaTextField v-model="to" label="结束日期" type="date" />
        <div class="identity-actions identity-wide">
          <KimaButton type="submit" :loading="pending">筛选记录</KimaButton
          ><span class="muted">日期按北京时间筛选。</span>
        </div>
      </form>
      <KimaAlert
        v-if="error || message"
        variant="danger"
        :description="message || apiMessage(error)"
      /><KimaSkeleton v-if="pending && !data" class="h-32" /><KimaEmptyState
        v-else-if="!data?.items.length"
        heading="还没有此类活动"
        description="完成业务操作后，相关记录会出现在这里。"
      />
      <ol v-else class="activity-list">
        <li v-for="item in data.items" :key="item.id">
          <div>
            <h2>{{ item.label }}</h2>
            <p class="muted">
              {{ new Date(item.createdAt).toLocaleString('zh-CN') }} ·
              {{ item.bySelf ? '本人操作' : '业务处理' }}
            </p>
          </div>
          <code class="muted">#{{ item.id }}</code>
        </li>
      </ol>
      <KimaButton
        v-if="data?.next"
        variant="tonal"
        :loading="more"
        :disabled="more"
        @click="next"
        >加载更早记录</KimaButton
      >
    </section>
  </main>
</template>
<style scoped>
.activity-page {
  display: grid;
  gap: var(--kima-space-6);
}
.activity-page > .panel {
  padding: var(--kima-space-6);
}
.activity-page > .page-heading {
  margin-bottom: 0;
}
@media (max-width: 600px) {
  .activity-page > .panel {
    padding: var(--kima-space-5);
  }
}

.activity-list {
  padding: 0;
  list-style: none;
}
.activity-list li {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--kima-color-outline-variant);
}
.activity-list h2 {
  font-size: 1rem;
  margin: 0;
}
.activity-list p {
  margin: 0.4rem 0 0;
}
@media (max-width: 600px) {
  .activity-list li {
    gap: 0.5rem;
  }
  .activity-list code {
    font-size: 0.75rem;
  }
}
</style>
