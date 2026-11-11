<!-- 服务列表：查看开通与到期状态。调用：访问 /console/services。 -->
<script setup lang="ts">
import { Add01Icon, ServerStack01Icon } from '@hugeicons/core-free-icons'; // 服务页的下一步是选择新产品
import type { Service } from '~/types/api'; // 状态来自 Go 开通流程的真实结果
import { canRenewService, serviceActionNames } from '~/features/service'; // 手机与桌面使用同一续费与动作规则
const account = useAccount(); // 批量命令由主账号本人提交
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: 'console', middleware: 'account' }); // 只展示当前账户的服务
useSeoMeta({ title: '我的服务', robots: 'noindex, nofollow' }); // 服务地址不收录
const api = useApi(); // 同源会话读取服务
const { data, pending, error, refresh } = await useAsyncData('services', () =>
  api<Service[]>('/services'),
); // 读取失败时提供重试
const renewing = ref('');
const message = ref(''); // 续费操作失败时保留服务列表
const keys = new Map<string, string>(); // 超时重试不会生成第二张续费账单
/** @param service 需要续费的当前账户服务。 */
async function renew(service: Service) {
  // 只在用户点击时发起续费
  renewing.value = service.id;
  message.value = ''; // 同一次只处理一份服务
  try {
    // 错误在用户动作入口显示
    const key = keys.get(service.id) || crypto.randomUUID(); // 网络重试继续用原标识
    keys.set(service.id, key); // 记录本次续费请求
    const order = await api<{ invoiceId: string }>(`/services/${service.id}/renew`, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: { period: service.billingPeriod || 'month' },
    }); // 金额由服务器确定
    keys.delete(service.id); // 成功后下一次续费是新请求
    await router.push(`/console/invoices/${order.invoiceId}`); // 支付前允许再次核对
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 不修改本地到期日假装续费成功
    renewing.value = '';
  } // 允许修正错误后重试
}
const columns = [
  { key: 'name', label: '服务名称' },
  { key: 'status', label: '状态' },
  { key: 'dueAt', label: '到期时间' },
  { key: 'externalId', label: '资源标识' },
  { key: 'action', label: '操作' },
]; // 表格按用户查看顺序组织
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>我的服务</h1>
        <p>每一份云上空间，都在这里。</p>
      </div>
      <KimaButton v-if="!account.user.value?.delegated" variant="tonal" @click="router.push('/console/renewals')">批量续费</KimaButton>
      <KimaButton @click="router.push('/products')">
        <template #leading><KimaIcon :icon="Add01Icon" /></template>
        选购产品
      </KimaButton>
    </header>
    <KimaAlert v-if="message" variant="danger" class="mb-6">{{ message }}</KimaAlert>
    <section class="panel">
      <header class="panel-header">
        <h2>
          全部服务
          <span v-if="data" class="muted ml-3 text-sm">{{ data.length }} 项</span>
        </h2>
        <KimaButton variant="text" :disabled="pending" @click="refresh()">刷新状态</KimaButton>
      </header>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="data?.length === 0"
        title="第一份服务，从这里开始"
        description="选一款适合的产品，开通后就能在这里管理。"
        @retry="refresh"
      />
      <KimaTable
        class="desktop-records"
        v-if="data?.length && !error && !pending"
        :columns="columns"
        :rows="data"
        row-key="id"
        hoverable
      >
        <template #cell-name="{ row }">
          <AppLink class="table-primary" :to="`/console/services/${row.id}`">{{ row.name || row.productName || '云服务' }}</AppLink>
          <span class="table-secondary">{{ row.id.slice(0, 8) }}</span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :status="row.status" :order-status="row.orderStatus" context="service" />
          <div v-if="row.operation" class="table-secondary">
            <p>{{ serviceActionNames[row.operation.action as keyof typeof serviceActionNames] }}</p>
            <StatusBadge :status="row.operation.state" />
          </div>
        </template>
        <template #cell-dueAt="{ value }">
          <span class="numbers whitespace-nowrap">{{ date(value) }}</span>
        </template>
        <template #cell-externalId="{ value }">
          <span class="numbers">{{ value || '—' }}</span>
        </template>
        <template #cell-action="{ row }">
          <KimaButton variant="text" @click="router.push(`/console/services/${row.id}`)">管理</KimaButton>
          <KimaButton
            v-if="row.orderStatus === 'unpaid' && row.invoiceId"
            variant="tonal"
            @click="router.push(`/console/invoices/${row.invoiceId}`)"
          >
            查看账单
          </KimaButton>
          <KimaButton
            v-else-if="canRenewService(row)"
            variant="tonal"
            :disabled="!!renewing"
            :loading="renewing === row.id"
            @click="renew(row)"
          >
            续费
          </KimaButton>
          <span v-else class="muted">
            {{
              row.terminationRequestedAt && !['terminated', 'cancelled'].includes(row.status)
                ? '终止任务处理中'
                : '—'
            }}
          </span>
        </template>
      </KimaTable>
      <div v-if="data?.length && !error && !pending" class="mobile-records">
        <ServiceCard
          v-for="service in data"
          :key="service.id"
          :service="service"
          allow-renew
          :renewing="renewing === service.id"
          :disabled="!!renewing"
          @renew="renew"
        />
      </div>
    </section>
  </div>
</template>
