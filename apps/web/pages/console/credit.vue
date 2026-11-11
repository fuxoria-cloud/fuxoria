<!-- 信用账户：授信、真实应收款与月结/提前还款分开呈现。调用：访问/console/credit。 -->
<script setup lang="ts">
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '信用额度', robots: 'noindex, nofollow' });
const api = useApi(),
  router = useRouter(),
  busy = ref(false),
  message = ref('');
const currency=ref('CNY');
watch(currency,()=>{key='';});
const {data:currencies}=await useAsyncData('customer-credit-currencies',()=>api<{code:string;name:string}[]>('/currencies'));
let key = ''; // 重试保持原还款标识
const { data, pending, error, refresh } = await useAsyncData('credit', () =>
  api<{
    currency:string;currencyDecimals?:number;enabled: boolean;
    limitCents: string;
    usedCents: string;
    availableCents: string;
    billingDay: number;
    repaymentDays: number;
  }>(`/credit?currency=${currency.value}`), {watch:[currency]},
);
const {
  data: history,
  error: historyError,
  refresh: refreshHistory,
} = await useAsyncData('credit-history', () =>
  api<
    Array<{
      id: string;
      invoiceId: string;
      amountCents: string;currency:string;currencyDecimals?:number;
      billAt: string;
      dueAt: string;
      repaymentInvoiceId?: string;
      repaymentStatus?: string;
    }>
  >('/credit/history'),
); // 债务和实际还款账单来自同一分配记录
async function prepay() {
  busy.value = true;
  message.value = '';
  try {
    key ||= crypto.randomUUID();
    const result = await api<{ invoiceId: string }>('/credit/repayments', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: {currency:currency.value},
    });
    key = '';
    await router.push(`/console/invoices/${result.invoiceId}`);
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>信用额度</h1>
        <p>先使用已授额度，再按约定账期还款。</p>
      </div>
      <KimaButton
        variant="tonal"
        @click="
          refresh();
          refreshHistory();
        "
        >刷新</KimaButton
      >
    </header>
    <KimaSelect v-model="currency" label="信用币种" :items="(currencies||[]).map(item=>({value:item.code,label:`${item.name}（${item.code}）`}))" class="mb-5" /><RequestState :pending="pending" :error="error" @retry="refresh" />
    <div v-if="data" class="stat-grid">
      <KimaCard class="stat-card"
        ><p>授信额度</p>
        <p class="stat-value">{{ money(data.limitCents,data.currency,data.currencyDecimals) }}</p>
        <p class="form-hint">
          {{ data.enabled ? '已启用' : '当前未启用新增借用' }}
        </p></KimaCard
      >
      <KimaCard class="stat-card"
        ><p>实际未还款</p>
        <p class="stat-value">{{ money(data.usedCents,data.currency,data.currencyDecimals) }}</p></KimaCard
      >
      <KimaCard class="stat-card"
        ><p>剩余可用</p>
        <p class="stat-value">{{ money(data.availableCents,data.currency,data.currencyDecimals) }}</p></KimaCard
      >
    </div>
    <section v-if="data" class="panel content-padding mt-6">
      <h2>账期与还款</h2>
      <p class="mt-3">
        每月{{ data.billingDay }}日出账，账单生成后{{
          data.repaymentDays
        }}天内还款。每次借用保存当时约定的账期；实际到账后恢复额度。
      </p>
      <KimaButton
        class="mt-5"
        :loading="busy"
        :disabled="data.usedCents === '0'"
        @click="prepay"
        >归集未出账欠款，提前还款</KimaButton
      ><KimaAlert v-if="message" variant="danger" class="mt-4">{{
        message
      }}</KimaAlert>
    </section>
    <section class="panel mt-6">
      <header class="panel-header"><h2>信用使用记录</h2></header>
      <RequestState
        :error="historyError"
        :empty="history?.length === 0"
        title="还没有信用使用记录"
        @retry="refreshHistory"
      />
      <article
        v-for="item in history"
        :key="item.id"
        class="content-padding border-t border-[var(--kima-color-outline-variant)]"
      >
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p class="table-primary">{{ money(item.amountCents,item.currency,item.currencyDecimals) }}</p>
            <p class="form-hint">
              出账 {{ date(item.billAt) }} · 还款截止 {{ date(item.dueAt) }}
            </p>
          </div>
          <div class="flex flex-wrap gap-3">
            <AppLink :to="`/console/invoices/${item.invoiceId}`"
              >原业务账单</AppLink
            ><AppLink
              v-if="item.repaymentInvoiceId"
              :to="`/console/invoices/${item.repaymentInvoiceId}`"
              >{{
                item.repaymentStatus === 'paid' ? '查看已还款记录' : '去还款'
              }}</AppLink
            ><span v-else class="muted">尚未出还款单</span>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>
