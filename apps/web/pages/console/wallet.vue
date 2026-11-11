<!-- 账户余额：真实可用金额与只读账本明细。调用：登录后访问/console/wallet。 -->
<script setup lang="ts">
import { Wallet01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'; // 钱包与账单关联使用统一图标
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: 'console', middleware: 'account' }); // 金额只属于当前登录账号
useSeoMeta({ title: '账户余额', robots: 'noindex, nofollow' }); // 余额与流水不参与索引
const api = useApi();
const pageNumber = ref(1); // 明细按服务器固定50条分页
const {
  data: wallet,
  pending,
  error,
  refresh,
} = await useAsyncData('wallet', () =>
  api<{
    totals?:{currency:string;currencyDecimals?:number;balanceCents:string;availableCents:string;heldCents:string}[];balanceCents: string;
    currency: string;currencyDecimals?:number;
    availableCents?: string;
    heldCents?: string;
  }>('/wallet'),
); // 不从本地缓存猜测余额
const {
  data: history,
  pending: loadingHistory,
  error: historyError,
  refresh: refreshHistory,
} = await useAsyncData(
  'wallet-history',
  () =>
    api<
      Array<{
        id: string;
        amountCents: string;currency:string;currencyDecimals?:number;
        createdAt: string;
        invoiceId?: string;
        openingBalanceId?: string;
        kind?: string;
      }>
    >(`/wallet/history?page=${pageNumber.value}`),
  { watch: [pageNumber] },
); // 页码变化重新读取真实分录
const amountYuan = ref('100.00'),
  recharging = ref(false),
  rechargeError = ref(''); // 表单金额只在提交边界转整数分
let rechargeKey = '';
async function recharge() {
  recharging.value = true;
  rechargeError.value = '';
  try {
    const amountCents = toCents(amountYuan.value);
    rechargeKey ||= crypto.randomUUID();
    const bill = await api<{ invoiceId: string }>('/wallet/recharges', {
      method: 'POST',
      headers: { 'Idempotency-Key': rechargeKey },
      body: { amountCents },
    });
    rechargeKey = '';
    await router.push(`/console/invoices/${bill.invoiceId}`);
  } catch (failure) {
    rechargeError.value = apiMessage(failure);
  } finally {
    recharging.value = false;
  } // 超时保留同一个提交键
}
watch(amountYuan, () => {
  rechargeKey = '';
}); // 改金额对应新充值意图
const columns = [
  { key: 'amountCents', label: '余额变动' },
  { key: 'kind', label: '事项' },
  { key: 'createdAt', label: '发生时间' },
  { key: 'action', label: '关联记录' },
]; // 不暴露其它客户或机构的交易
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>账户余额</h1>
        <p>每一次使用，都有记录可循。</p>
      </div>
    </header>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <KimaCard v-if="wallet && !pending && !error" class="wallet-summary">
      <div class="stat-top">
        实际可用余额
        <KimaIcon :icon="Wallet01Icon" :size="32" />
      </div>
      <p class="stat-value">
        {{ money(wallet.availableCents ?? wallet.balanceCents,wallet.currency,wallet.currencyDecimals) }}
      </p>
      <p class="form-hint">可在待付款账单中使用已有余额结算。</p>
      <p v-if="wallet.heldCents && wallet.heldCents !== '0'" class="form-hint">
        总余额 {{ money(wallet.balanceCents,wallet.currency,wallet.currencyDecimals) }}，其中
        {{ money(wallet.heldCents,wallet.currency,wallet.currencyDecimals) }} 正在申请原路退款。
      </p>
    </KimaCard>
    <div v-if="wallet?.totals?.some(item=>item.currency!=='CNY')" class="stat-grid mt-6"><KimaCard v-for="item in wallet.totals.filter(item=>item.currency!=='CNY')" :key="item.currency" class="stat-card"><p>{{ item.currency }} 可用余额</p><p class="stat-value">{{ money(item.availableCents,item.currency,item.currencyDecimals) }}</p><p class="form-hint">总额 {{ money(item.balanceCents,item.currency,item.currencyDecimals) }} · 退款占额 {{ money(item.heldCents,item.currency,item.currencyDecimals) }}</p></KimaCard></div><section class="panel mt-8 content-padding">
      <h2>充值到余额</h2>
      <p class="form-hint mb-4">
        选择金额后进入收银台，实际付款成功才计入余额。
      </p>
      <form class="flex flex-wrap items-end gap-4" @submit.prevent="recharge">
        <label class="field-label"
          ><span class="form-label">充值金额（元）</span
          ><KimaTextField
            v-model="amountYuan"
            label="充值金额（元）"
            inputmode="decimal"
            placeholder="100.00"
            :disabled="recharging"
            required
        /></label>
        <KimaButton type="submit" :loading="recharging">去充值</KimaButton>
      </form>
      <KimaAlert v-if="rechargeError" variant="danger" class="mt-4">{{
        rechargeError
      }}</KimaAlert>
    </section>
    <section class="panel mt-8">
      <header class="panel-header">
        <h2>余额明细</h2>
        <KimaButton
          variant="text"
          :disabled="loadingHistory"
          @click="refreshHistory()"
        >
          刷新
        </KimaButton>
      </header>
      <RequestState
        :pending="loadingHistory"
        :error="historyError"
        @retry="refreshHistory"
      />
      <KimaTable
        v-if="history?.length && !loadingHistory && !historyError"
        :columns="columns"
        :rows="history"
        row-key="id"
      >
        <template #cell-amountCents="{ value,row }">
          <span class="numbers">{{ money(value,row.currency,row.currencyDecimals) }}</span>
        </template>
        <template #cell-kind="{ row }">
          {{
            row.kind === 'recharge'
              ? '支付充值'
              : row.kind === 'recharge_refund'
                ? '充值原路退款'
                : row.invoiceId
                  ? '账单付款'
                  : row.openingBalanceId
                    ? '期初余额'
                    : '余额变动'
          }}
        </template>
        <template #cell-createdAt="{ value }">{{ date(value) }}</template>
        <template #cell-action="{ row }">
          <KimaButton
            v-if="row.invoiceId"
            variant="tonal"
            @click="router.push(`/console/invoices/${row.invoiceId}`)"
          >
            查看账单
            <template #trailing
              ><KimaIcon :icon="ArrowRight01Icon" :size="20"
            /></template>
          </KimaButton>
          <span v-else class="muted">—</span>
        </template>
      </KimaTable>
      <p
        v-if="!history?.length && !loadingHistory && !historyError"
        class="content-padding muted"
      >
        这一页还没有余额变动记录。
      </p>
      <div class="pagination-bar">
        <p class="muted text-sm">第 {{ pageNumber }} 页</p>
        <div class="flex gap-3">
          <KimaButton
            variant="tonal"
            :disabled="pageNumber <= 1 || loadingHistory"
            @click="pageNumber--"
          >
            上一页
          </KimaButton>
          <KimaButton
            variant="tonal"
            :disabled="!history || history.length < 50 || loadingHistory"
            @click="pageNumber++"
          >
            下一页
          </KimaButton>
        </div>
      </div>
    </section>
  </div>
</template>
