<!-- 请求状态：KIMA骨架、空状态和真实重试入口。调用：<RequestState :pending="pending" :error="error" @retry="refresh" />。 -->
<script setup lang="ts">
import { AlertCircleIcon, InboxIcon, RefreshIcon } from '@hugeicons/core-free-icons'; // 错误和空列表有各自的图形提示
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
withDefaults(
  defineProps<{
    pending?: boolean;
    error?: unknown;
    empty?: boolean;
    title?: string;
    description?: string;
    action?: string;
    to?: string;
  }>(),
  { title: '这里还没有内容', description: '', action: '浏览产品', to: '/products' },
); // 每个空状态保留一个主要下一步
const emit = defineEmits<{ retry: [] }>(); // 点击重试只重新读取原业务数据
</script>
<template>
  <div v-if="pending" class="request-state"><KimaSkeleton :rows="3" label="正在读取内容" /></div>
  <KimaEmptyState v-else-if="error" heading="暂时没能加载" :description="apiMessage(error)">
    <template #icon><KimaIcon :icon="AlertCircleIcon" :size="40" /></template>
    <template #action>
      <KimaButton variant="tonal" @click="emit('retry')">
        <template #leading><KimaIcon :icon="RefreshIcon" :size="24" /></template>
        重新加载
      </KimaButton>
    </template>
  </KimaEmptyState>
  <KimaEmptyState v-else-if="empty" :heading="title" :description="description">
    <template #icon><KimaIcon :icon="InboxIcon" :size="40" /></template>
    <template #action>
      <KimaButton variant="tonal" @click="router.push(to)">{{ action }}</KimaButton>
    </template>
  </KimaEmptyState>
</template>
