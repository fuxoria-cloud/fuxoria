<!-- 授信管理：管理员本人复核后调整额度，不能覆盖原借款账期。调用：/admin/credit。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor'; // 资金授权使用同一身份验证方式
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '授信管理', robots: 'noindex, nofollow' });
const api = useApi(),
  busy = ref(false),
  message = ref('');
const { data, pending, error, refresh } = await useAsyncData(
  'admin-credit',
  () =>
    api<
      Array<{
        userId: string;currency:string;currencyDecimals?:number;
        email: string | null;
        phone?:string;
        name?:string;
        enabled: boolean;
        limitCents: string;
        usedCents: string;
        billingDay: number;
        repaymentDays: number;
        note: string;
      }>
    >('/admin/credit'),
);
const { data: clients } = await useAsyncData('credit-clients', () =>
  api<{ id: string; email:string | null;phone?:string;name?:string}[]>('/admin/users'),
);
const {data:currencies}=await useAsyncData('credit-currencies',()=>api<{code:string;name:string;decimals:number}[]>('/currencies'));
const form = reactive({
  currency:'CNY',
  userId: '',
  enabled: 'true',
  amount: '1000.00',
  billingDay: '1',
  repaymentDays: '15',
  note: '',
  password: '',
});
const factor = ref<FactorInput>({ mode: 'totp', code: '' }); // 不把密码与MFA写入列表缓存
const choices = computed(
  () =>
    clients.value?.map((item) => ({ value: item.id, label: item.email||item.phone||item.name||item.id })) || [],
);
function edit(item: NonNullable<typeof data.value>[number]) {
  Object.assign(form, {
    userId: item.userId,currency:item.currency,
    enabled: String(item.enabled),
    amount: amount(item.limitCents,item.currency,item.currencyDecimals),
    billingDay: String(item.billingDay),
    repaymentDays: String(item.repaymentDays),
    note: item.note,
    password: '',
  });
  factor.value.code = '';
} // 按原授信填表，债务金额只读
async function save() {
  busy.value = true;
  message.value = '';
  try {
    await api(`/admin/credit/${form.userId}`, {
      method: 'PUT',
      body: {
        currency:form.currency,enabled: form.enabled === 'true',
        limitCents: toCents(form.amount, true,form.currency,currencies.value?.find(item=>item.code===form.currency)?.decimals),
        billingDay: Number(form.billingDay),
        repaymentDays: Number(form.repaymentDays),
        note: form.note,
        password: form.password,
        ...factorProof(factor.value),
      },
    });
    form.password = '';
    factor.value.code = '';
    await refresh();
    message.value = '授信设置已保存。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div>
    <AppLink to="/admin" class="mb-5">返回管理后台</AppLink>
    <header class="page-heading">
      <div>
        <h1>授信管理</h1>
        <p>额度由管理员明确授予，实际借用与还款保留账本记录。</p>
      </div>
    </header>
    <section class="panel content-padding">
      <h2>设置客户授信</h2>
      <form class="grid gap-5 mt-5 md:grid-cols-2" @submit.prevent="save">
        <KimaSelect v-model="form.currency" label="授信币种" :items="(currencies||[]).map(item=>({value:item.code,label:`${item.name}（${item.code}）`}))" /><div class="field-label">
          <span class="form-label">客户主账号</span
          ><KimaSelect
            v-model="form.userId"
            label="客户主账号"
            :items="choices"
          />
        </div>
        <div class="field-label">
          <span class="form-label">新增借用</span
          ><KimaSelect
            v-model="form.enabled"
            label="新增借用"
            :items="[
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ]"
          />
        </div>
        <label class="field-label"
          ><span class="form-label">额度（{{ form.currency }}）</span
          ><KimaTextField
            v-model="form.amount"
            :label="`额度（${form.currency}）`"
            inputmode="decimal"
            required /></label
        ><label class="field-label"
          ><span class="form-label">每月出账日（1–28）</span
          ><KimaTextField
            v-model="form.billingDay"
            label="出账日"
            inputmode="numeric"
            required
        /></label>
        <label class="field-label"
          ><span class="form-label">出账后还款天数（1–90）</span
          ><KimaTextField
            v-model="form.repaymentDays"
            label="还款天数"
            inputmode="numeric"
            required /></label
        ><label class="field-label"
          ><span class="form-label">授信/调整说明</span
          ><KimaTextField v-model="form.note" label="说明" required
        /></label>
        <label class="field-label"
          ><span class="form-label">当前管理员密码</span
          ><KimaTextField
            v-model="form.password"
            label="当前密码"
            type="password"
            autocomplete="current-password"
            required /></label
        ><SecondFactor v-model="factor" :disabled="busy" />
        <KimaAlert v-if="message" class="md:col-span-2">{{ message }}</KimaAlert
        ><KimaButton type="submit" :loading="busy" :disabled="!form.userId"
          >保存授信</KimaButton
        >
      </form>
    </section>
    <section class="panel mt-6">
      <header class="panel-header">
        <h2>已有授信</h2>
        <KimaButton variant="text" @click="refresh()">刷新</KimaButton>
      </header>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="data?.length === 0"
        @retry="refresh"
      />
      <article
        v-for="item in data"
        :key="`${item.userId}:${item.currency}`"
        class="content-padding flex flex-wrap justify-between items-center gap-4"
      >
        <div>
          <p>{{ item.email||item.phone||item.name||item.userId }}</p>
          <p class="form-hint">
            额度{{ money(item.limitCents,item.currency,item.currencyDecimals) }} · 未还款{{
              money(item.usedCents,item.currency,item.currencyDecimals)
            }}
            · {{ item.enabled ? '启用' : '停用' }}
          </p>
        </div>
        <KimaButton variant="tonal" @click="edit(item)">调整授信</KimaButton>
      </article>
    </section>
  </div>
</template>
