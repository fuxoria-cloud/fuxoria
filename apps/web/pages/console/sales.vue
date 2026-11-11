<!-- 员工销售工作台：本人客户、逐单提成、分币种可用额与兑现记录。调用：已启用销售的员工访问/console/sales。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import { toCents, money } from '~/features/money';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '我的销售', robots: 'noindex, nofollow' });
interface Balance {
  currency: string;
  balanceCents: string;
  availableCents: string;
  pendingCents: string;
  reservedCents: string;
  refundPending: boolean;
}
interface Commission {
  id: string;
  invoiceNumber: string;
  productName: string;
  currency: string;
  category: string;
  basisCents: string;
  rateBps: number;
  releasedCents: string | null;
  reversedCents: string;
  status: string;
  releaseAt: string;
}
interface Withdrawal {
  id: string;
  currency: string;
  amountCents: string;
  status: string;
  payee: { name: string; method: string; account: string };
  reason?: string;
  reference?: string;
  createdAt: string;
}
const api = useApi();
const { data, error, pending, refresh } = await useAsyncData(
  'sales-personal',
  () => api<{ profile: { groupName: string }; balances: Balance[] }>('/sales'),
);
const { data: clients } = await useAsyncData('sales-customers', () =>
  api<{ id: string; name: string; email: string; company: string }[]>(
    '/sales/customers',
  ),
);
const { data: commissions, refresh: refreshCommissions } = await useAsyncData(
  'sales-commissions',
  () => api<Commission[]>('/sales/commissions'),
);
const { data: withdrawals, refresh: refreshWithdrawals } = await useAsyncData(
  'sales-withdrawals',
  () => api<Withdrawal[]>('/sales/withdrawals'),
);
const { data: currencies } = await useAsyncData('sales-currencies', () =>
  api<{ code: string; decimals: number }[]>('/currencies'),
);
const form = reactive({
    currency: 'CNY',
    amount: '',
    method: 'bank',
    name: '',
    account: '',
  }),
  opened = ref(false),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' }),
  busy = ref(''),
  message = ref(''),
  success = ref('');
let intent = { body: '', key: '' };
const display = (value: string, code: string) =>
    money(
      value,
      code,
      currencies.value?.find((c) => c.code === code)?.decimals,
    ),
  statuses: Record<string, string> = {
    pending: '待处理',
    paid: '已登记打款',
    rejected: '已驳回',
    cancelled: '已撤回',
  };
async function update() {
  await refresh();
  await Promise.all([refreshCommissions(), refreshWithdrawals()]);
}
function begin(code: string) {
  form.currency = code;
  opened.value = true;
  message.value = '';
  password.value = '';
  proof.value.code = '';
}
async function submit() {
  busy.value = 'submit';
  message.value = '';
  try {
    const fields = {
        currency: form.currency,
        amountCents: toCents(
          form.amount,
          false,
          form.currency,
          currencies.value?.find((c) => c.code === form.currency)?.decimals,
        ),
        payee: { method: form.method, name: form.name, account: form.account },
      },
      fingerprint = JSON.stringify(fields);
    if (intent.body !== fingerprint)
      intent = { body: fingerprint, key: crypto.randomUUID() };
    await api('/sales/withdrawals', {
      method: 'POST',
      headers: { 'Idempotency-Key': intent.key },
      body: {
        ...fields,
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    opened.value = false;
    password.value = '';
    proof.value.code = '';
    form.amount = '';
    await update();
    success.value = '兑现申请已提交，金额已预留。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function cancel(id: string) {
  busy.value = id;
  message.value = '';
  try {
    await api(`/sales/withdrawals/${id}/cancel`, { method: 'POST' });
    await update();
    success.value = '申请已撤回，预留已释放。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">员工工作台</p>
        <h1>我的销售</h1>
        <p class="muted">
          {{ data?.profile.groupName ?? '客户归属、实际业绩与销售提成' }}
        </p>
      </div>
      <KimaButton variant="tonal" @click="update">刷新核对</KimaButton>
    </div>
    <KimaAlert
      v-if="error"
      variant="danger"
      :description="apiMessage(error)"
    /><KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    /><KimaAlert
      v-if="message && !opened"
      variant="danger"
      :description="message"
    /><KimaSkeleton v-if="pending" />
    <div class="grid gap-5 lg:grid-cols-2 mb-6">
      <section
        v-for="item in data?.balances"
        :key="item.currency"
        class="panel identity-stack"
      >
        <h2>{{ item.currency }}</h2>
        <p class="text-2xl">
          可兑现 {{ display(item.availableCents, item.currency) }}
        </p>
        <p class="muted">
          等待期 {{ display(item.pendingCents, item.currency) }} · 预留
          {{ display(item.reservedCents, item.currency) }}
        </p>
        <KimaAlert
          v-if="BigInt(item.balanceCents) < 0n"
          variant="warning"
          :description="`后续退款产生待抵扣提成 ${display((-BigInt(item.balanceCents)).toString(), item.currency)}，下次收益会先抵扣。`"
        /><KimaButton
          :disabled="!!busy || item.availableCents === '0'"
          @click="begin(item.currency)"
          >申请兑现 {{ item.currency }}</KimaButton
        >
      </section>
    </div>
    <div class="identity-grid">
      <div class="identity-stack">
        <section class="panel">
          <h2>我的客户</h2>
          <p v-if="!clients?.length" class="muted mt-4">当前没有分配的客户。</p>
          <article
            v-for="item in clients"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }}</h3>
            <p class="muted">{{ item.email }}</p>
            <p v-if="item.company">{{ item.company }}</p>
          </article>
        </section>
        <section class="panel">
          <h2>提成记录</h2>
          <p class="muted mt-4">
            每笔保存付款时的员工归属和本单阶梯。退款按成交明细顺序冲减，币种分别核对。
          </p>
          <article
            v-for="item in commissions"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.productName }}</h3>
            <p>
              账单 #{{ item.invoiceNumber }} · {{ item.currency }} · 比例
              {{ item.rateBps / 100 }}%
            </p>
            <p>
              实收原额 {{ display(item.basisCents, item.currency) }} ·
              {{
                item.status === 'pending'
                  ? '等待期'
                  : item.status === 'void'
                    ? '净额为零'
                    : '已释放 ' +
                      display(item.releasedCents ?? '0', item.currency)
              }}
            </p>
            <p v-if="BigInt(item.reversedCents) > 0n" class="muted">
              退款冲回 {{ display(item.reversedCents, item.currency) }}
            </p>
            <p v-if="item.status === 'pending'" class="muted">
              {{ date(item.releaseAt) }} 后符合条件时释放
            </p>
          </article>
        </section>
      </div>
      <div class="identity-stack">
        <section v-if="opened" class="panel">
          <form class="identity-stack" @submit.prevent="submit">
            <h2>申请兑现 {{ form.currency }}</h2>
            <label
              ><span>金额</span
              ><KimaTextField
                v-model="form.amount"
                label="销售提成兑现金额"
                inputmode="decimal"
                required
            /></label>
            <div>
              <span>收款方式</span
              ><KimaSelect
                v-model="form.method"
                label="销售收款方式"
                :items="[
                  { value: 'bank', label: '银行转账' },
                  { value: 'alipay', label: '支付宝' },
                  { value: 'wechat', label: '微信' },
                ]"
              />
            </div>
            <label
              ><span>收款人姓名</span
              ><KimaTextField
                v-model="form.name"
                label="销售收款人姓名"
                required
                maxlength="100" /></label
            ><label
              ><span>收款账号</span
              ><KimaTextField
                v-model="form.account"
                label="销售收款账号"
                required
                maxlength="200"
            /></label>
            <div class="identity-proof identity-stack">
              <label
                ><span>当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="销售兑现确认密码"
                  type="password"
                  required
                  autocomplete="current-password" /></label
              ><SecondFactor v-model="proof" />
            </div>
            <KimaAlert v-if="message" variant="danger" :description="message" />
            <div class="identity-actions">
              <KimaButton type="submit" :loading="!!busy" :disabled="!!busy"
                >提交申请</KimaButton
              ><KimaButton
                variant="text"
                @click="
                  opened = false;
                  password = '';
                  proof.code = '';
                "
                >取消</KimaButton
              >
            </div>
          </form>
        </section>
        <section class="panel">
          <h2>兑现记录</h2>
          <p v-if="!withdrawals?.length" class="muted mt-4">暂无兑现申请。</p>
          <article
            v-for="item in withdrawals"
            :key="item.id"
            class="identity-record"
          >
            <h3>
              {{ display(item.amountCents, item.currency) }} ·
              {{ statuses[item.status] }}
            </h3>
            <p class="muted">
              {{ item.payee.name }} · {{ date(item.createdAt) }}
            </p>
            <p v-if="item.reason">{{ item.reason }}</p>
            <p v-if="item.reference" class="break-all">
              打款凭据：{{ item.reference }}
            </p>
            <KimaButton
              v-if="item.status === 'pending'"
              variant="text"
              :disabled="!!busy"
              @click="cancel(item.id)"
              >撤回申请</KimaButton
            >
          </article>
        </section>
      </div>
    </div>
  </div>
</template>
