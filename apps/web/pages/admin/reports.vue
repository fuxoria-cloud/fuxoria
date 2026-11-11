<!-- 经营报表：筛选日期和币种，分别核对现金、收入、客户与资源运行。调用：/admin/reports。 -->
<script setup lang="ts">
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '经营报表', robots: 'noindex, nofollow' });
interface Amounts {
  currency: string;
  cashInCents: string;
  cashOutCents: string;
  incomeNetCents: string;
  walletChangeCents: string;
  receivableChangeCents: string;
  period?: string;
}
interface Ranking {
  id: string;
  name: string;
  currency: string;
  email?: string;
  grossCents: string;
  refundedCents: string;
  netCents: string;
  rank: string;
}
interface Report {
  summary: Amounts[];
  timeline: Amounts[];
  newCustomers: { period: string; count: number }[];
  customers: Ranking[];
  products: Ranking[];
}
const api = useApi(),
  year = new Date().getFullYear(),
  form = reactive({
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    currency: '',
    bucket: 'month',
  }),
  query = ref(
    new URLSearchParams({
      from: form.from,
      to: form.to,
      bucket: form.bucket,
    }).toString(),
  ),
  tab = ref('finance');
const { data, error, pending, refresh } = await useAsyncData(
  computed(() => `reports:${query.value}`),
  () => api<Report>(`/admin/reports?${query.value}`),
);
const {
  data: operations,
  error: operationError,
  refresh: refreshOperations,
} = await useAsyncData(
  computed(() => `reports-operations:${query.value}`),
  () =>
    api<{
      states: {
        state: string;
        action: string;
        provider: string;
        count: number;
      }[];
      trend: { period: string; state: string; count: number }[];
      recent: {
        id: string;
        action: string;
        provider: string;
        state: string;
        attempts: number;
        lastError?: string;
        createdAt: string;
      }[];
    }>(`/admin/reports/operations?${query.value}`),
);
const { data: currencies } = await useAsyncData('reports-currencies', () =>
  api<{ code: string; name: string }[]>('/currencies'),
);
const choices = computed(() => [
  { value: '', label: '全部币种（分别显示）' },
  ...(currencies.value ?? []).map((c) => ({
    value: c.code,
    label: `${c.name} · ${c.code}`,
  })),
]);
function filter() {
  query.value = new URLSearchParams({
    from: form.from,
    to: form.to,
    bucket: form.bucket,
    ...(form.currency ? { currency: form.currency } : {}),
  }).toString();
}
const states: Record<string, string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  waiting: '等待人工',
  manual_review: '待核对',
};
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">经营与运行</p>
        <h1>经营报表</h1>
        <p class="muted">金额按币种分别核对，日期按上海时区计算。</p>
      </div>
      <AppLink to="/admin">管理概况</AppLink>
    </div>
    <form class="panel identity-toolbar" @submit.prevent="filter">
      <label
        ><span>开始日期</span
        ><KimaTextField
          v-model="form.from"
          label="报表开始日期"
          type="date"
          required /></label
      ><label
        ><span>结束日期</span
        ><KimaTextField
          v-model="form.to"
          label="报表结束日期"
          type="date"
          required
      /></label>
      <div>
        <span>币种</span
        ><KimaSelect
          v-model="form.currency"
          label="报表币种"
          :items="choices"
        />
      </div>
      <div>
        <span>统计间隔</span
        ><KimaSelect
          v-model="form.bucket"
          label="统计间隔"
          :items="[
            { value: 'month', label: '按月' },
            { value: 'day', label: '按日' },
          ]"
        />
      </div>
      <KimaButton type="submit" :loading="pending">查询</KimaButton>
    </form>
    <KimaAlert v-if="error" variant="danger" :description="apiMessage(error)" />
    <div class="identity-actions my-6">
      <KimaButton
        v-for="item in [
          { id: 'finance', label: '资金变化' },
          { id: 'business', label: '客户与商品' },
          { id: 'operations', label: '资源运行' },
        ]"
        :key="item.id"
        :variant="tab === item.id ? 'filled' : 'tonal'"
        @click="tab = item.id"
        >{{ item.label }}</KimaButton
      >
    </div>
    <template v-if="tab === 'finance' && data"
      ><p class="muted mb-6">
        现金进出、收入、钱包负债和应收款均取自所选期间的真实分录。充值计入钱包负债，信用借用计应收款；这些项目分别显示。
      </p>
      <div class="grid gap-5 lg:grid-cols-2">
        <section
          v-for="item in data.summary"
          :key="item.currency"
          class="panel identity-stack"
        >
          <h2>{{ item.currency }}</h2>
          <dl class="identity-fields">
            <div>
              <dt class="muted">现金流入</dt>
              <dd>{{ money(item.cashInCents, item.currency) }}</dd>
            </div>
            <div>
              <dt class="muted">现金流出</dt>
              <dd>{{ money(item.cashOutCents, item.currency) }}</dd>
            </div>
            <div>
              <dt class="muted">净收入</dt>
              <dd>{{ money(item.incomeNetCents, item.currency) }}</dd>
            </div>
            <div>
              <dt class="muted">钱包负债净增</dt>
              <dd>{{ money(item.walletChangeCents, item.currency) }}</dd>
            </div>
            <div>
              <dt class="muted">应收款净增</dt>
              <dd>{{ money(item.receivableChangeCents, item.currency) }}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section class="panel mt-6">
        <h2>期间明细</h2>
        <p v-if="!data.timeline.length" class="muted mt-4">
          所选期间没有资金分录。
        </p>
        <article
          v-for="item in data.timeline"
          :key="`${item.currency}:${item.period}`"
          class="identity-record"
        >
          <h3>{{ item.period }} · {{ item.currency }}</h3>
          <p>
            现金流入 {{ money(item.cashInCents, item.currency) }} · 流出
            {{ money(item.cashOutCents, item.currency) }}
          </p>
          <p class="muted">
            净收入 {{ money(item.incomeNetCents, item.currency) }} · 应收变化
            {{ money(item.receivableChangeCents, item.currency) }}
          </p>
        </article>
      </section></template
    >
    <div v-else-if="tab === 'business' && data" class="identity-stack">
      <section class="panel">
        <h2>新客户</h2>
        <p class="muted mt-3">
          独立客户注册数，排除联系人子账号。币种筛选不改变客户人数。
        </p>
        <div class="identity-fields mt-5">
          <p v-for="item in data.newCustomers" :key="item.period">
            {{ item.period }} · {{ item.count }} 位
          </p>
        </div>
      </section>
      <div class="identity-grid">
        <section
          v-for="section in [
            { name: '客户实收排名', items: data.customers },
            { name: '商品实收排名', items: data.products },
          ]"
          :key="section.name"
          class="panel"
        >
          <h2>{{ section.name }}</h2>
          <p class="muted mt-3">
            原业务单实际现金或余额结清后计入，包含信用实际还款和合并付款；扣除这些原单后续已完成退款。成交明细按固定顺序分配退款。
          </p>
          <article
            v-for="item in section.items"
            :key="`${item.currency}:${item.id}`"
            class="identity-record"
          >
            <h3>{{ item.rank }}. {{ item.name }}</h3>
            <p v-if="item.email" class="muted">{{ item.email }}</p>
            <p>
              {{ item.currency }} · 净实收
              {{ money(item.netCents, item.currency) }}
            </p>
            <p class="muted">
              原额 {{ money(item.grossCents, item.currency) }} · 已退
              {{ money(item.refundedCents, item.currency) }}
            </p>
          </article>
        </section>
      </div>
    </div>
    <div v-else-if="tab === 'operations'" class="identity-stack">
      <KimaAlert
        v-if="operationError"
        variant="danger"
        :description="apiMessage(operationError)"
      />
      <section class="panel">
        <h2>任务状态</h2>
        <div class="identity-fields mt-5">
          <article
            v-for="item in operations?.states"
            :key="`${item.state}:${item.action}:${item.provider}`"
            class="identity-record"
          >
            <h3>
              {{ states[item.state] ?? item.state }} · {{ item.count }} 项
            </h3>
            <p class="muted">{{ item.action }} · {{ item.provider }}</p>
          </article>
        </div>
      </section>
      <section class="panel">
        <h2>运行趋势</h2>
        <article
          v-for="item in operations?.trend"
          :key="`${item.period}:${item.state}`"
          class="identity-record"
        >
          <p>
            {{ item.period }} · {{ states[item.state] ?? item.state }} ·
            {{ item.count }} 项
          </p>
        </article>
      </section>
      <section class="panel">
        <h2>最近任务</h2>
        <article
          v-for="item in operations?.recent"
          :key="item.id"
          class="identity-record"
        >
          <h3>{{ item.action }} · {{ states[item.state] ?? item.state }}</h3>
          <p class="muted">
            {{ item.provider }} · 尝试 {{ item.attempts }} 次 ·
            {{ date(item.createdAt) }}
          </p>
          <p v-if="item.lastError" class="break-words">{{ item.lastError }}</p>
        </article>
      </section>
    </div>
  </div>
</template>
