<!-- 优惠码管理：付款折率与固定优惠分开填写，作用范围、有效期和次数直接可见。调用：CataloguePromotions传入商品与周期元数据。 -->
<script setup lang="ts">
import { KimaCheckbox, KimaNumberField } from '@kernel4632/kima';
import type { BillingPeriod } from '~/types/api';
const props = defineProps<{ products: { id: string; name: string }[]; periods: { period: BillingPeriod; label: string }[] }>();
type Promotion = { id: string; currency:string; code: string; name: string; kind: 'percent' | 'fixed' | 'override' | 'free'; value: string; recurring: boolean; active: boolean; startsAt: string | null; endsAt: string | null; maxUses: number | null; perUserLimit: number | null; minimumCents: string; productIds: string[]; periods: BillingPeriod[]; firstOrderOnly: boolean; used: number };
const api = useApi();
const { data, refresh, pending, error } = await useAsyncData('catalogue-promotions', () => api<Promotion[]>('/admin/promotions'));
const {data:currencies}=await useAsyncData('promotion-currencies',()=>api<{code:string;name:string;active:boolean;decimals:number}[]>('/currencies'));
const open = ref(false), editing = ref(''), busy = ref(false), message = ref('');
const form = reactive({currency:'CNY', code: '', name: '', kind: 'percent' as Promotion['kind'], value: '90', recurring: false, active: true, startsAt: '', endsAt: '', maxUses: null as number | null, perUserLimit: null as number | null, minimum: '0.00', productIds: [] as string[], periods: [] as BillingPeriod[], firstOrderOnly: false });
const yuan = (value: string) => `${BigInt(value) / 100n}.${(BigInt(value) % 100n).toString().padStart(2, '0')}`;
function cents(value: string) { if (!/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw new Error('金额或百分比请填写最多两位小数'); const [whole, decimal = ''] = value.split('.'); return (BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'))).toString(); }
function edit(item?: Promotion) {
  editing.value = item?.id || ''; message.value = '';
  Object.assign(form, item ? {currency:item.currency||'CNY', code: item.code, name: item.name, kind: item.kind, value: item.kind === 'free' ? '0' : amount(item.value,item.kind==='percent'?'CNY':item.currency), recurring: item.recurring, active: item.active, startsAt: item.startsAt || '', endsAt: item.endsAt || '', maxUses: item.maxUses, perUserLimit: item.perUserLimit, minimum: amount(item.minimumCents,item.currency), productIds: [...item.productIds], periods: [...item.periods], firstOrderOnly: item.firstOrderOnly } : {currency:'CNY', code: '', name: '', kind: 'percent', value: '90', recurring: false, active: true, startsAt: '', endsAt: '', maxUses: null, perUserLimit: null, minimum: '0.00', productIds: [], periods: [], firstOrderOnly: false });
  open.value = true;
}
function toggle<T>(values: T[], value: T) { const at = values.indexOf(value); if (at >= 0) values.splice(at, 1); else values.push(value); }
async function save() {
  busy.value = true; message.value = '';
  try {
    const body = {currency:form.currency, code: form.code, name: form.name, kind: form.kind, value: form.kind === 'free' ? '0' : toCents(form.value,true,form.kind==='percent'?'CNY':form.currency,form.kind==='percent'?2:currencies.value?.find(item=>item.code===form.currency)?.decimals), recurring: form.recurring, active: form.active, startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null, maxUses: form.maxUses, perUserLimit: form.perUserLimit, minimumCents: toCents(form.minimum,true,form.currency,currencies.value?.find(item=>item.code===form.currency)?.decimals), productIds: form.productIds, periods: form.periods, firstOrderOnly: form.firstOrderOnly };
    await api(`/admin/promotions${editing.value ? '/' + editing.value : ''}`, { method: editing.value ? 'PUT' : 'POST', body }); await refresh(); open.value = false;
  } catch (error) { message.value = apiMessage(error); } finally { busy.value = false; }
}
</script>
<template>
  <KimaCard class="p-6">
    <div class="flex flex-wrap items-center justify-between gap-4 mb-5"><div><h2 class="text-xl">优惠码</h2><p class="muted text-sm mt-2">优惠只影响新合同，既有成交记录保持原价。</p></div><KimaButton @click="edit()">创建优惠码</KimaButton></div>
    <RequestState :pending="pending" :error="error" :empty="data?.length === 0" title="还没有优惠码" description="创建后可在购物车中使用。" @retry="refresh" />
    <div class="grid grid-cols-1 gap-3"><KimaCard v-for="item in data || []" :key="item.id" class="p-4 flex flex-wrap items-center justify-between gap-4"><div><strong>{{ item.code }} · {{ item.name }}</strong><p class="muted text-sm mt-2">{{ item.active ? '已启用' : '已停用' }} · 已使用 {{ item.used }}{{ item.maxUses ? ' / ' + item.maxUses : '' }} 次 · {{ item.recurring ? '续费沿用优惠价' : '仅首次付款优惠' }}</p></div><KimaButton variant="tonal" @click="edit(item)">编辑</KimaButton></KimaCard></div>
    <KimaDrawer v-model:open="open" :title="editing ? '编辑优惠码' : '创建优惠码'" placement="right">
      <form id="promotion-form" class="grid grid-cols-1 gap-5" @submit.prevent="save">
        <KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
        <label class="grid grid-cols-1 gap-2">优惠码<KimaTextField v-model="form.code" label="优惠码" required maxlength="40" placeholder="例如 CLOUD90" /></label>
        <label class="grid grid-cols-1 gap-2">内部名称<KimaTextField v-model="form.name" label="优惠名称" required maxlength="100" /></label>
        <div class="grid grid-cols-1 gap-2">优惠方式<KimaSelect v-model="form.kind" label="优惠方式" :items="[{value:'percent',label:'按比例付款'},{value:'fixed',label:'每件减免固定金额'},{value:'override',label:'每件覆盖价格'},{value:'free',label:'免安装费'}]" /></div>
        <KimaSelect v-model="form.currency" label="金额与门槛币种" :items="(currencies||[]).filter(item=>item.active).map(item=>({value:item.code,label:`${item.name}（${item.code}）`}))" /><label v-if="form.kind !== 'free'" class="grid grid-cols-1 gap-2">{{ form.kind === 'percent' ? '付款比例（%，90为九折）' : `金额（${form.currency}）` }}<KimaTextField v-model="form.value" label="优惠数值" inputmode="decimal" required /></label>
        <label class="grid grid-cols-1 gap-2">最低订单金额（{{ form.currency }}）<KimaTextField v-model="form.minimum" label="最低订单金额" inputmode="decimal" required /></label>
        <label class="grid grid-cols-1 gap-2">开始时间<KimaTextField v-model="form.startsAt" label="开始时间" placeholder="2026-12-01T00:00:00+08:00，留空立即开始" /></label>
        <label class="grid grid-cols-1 gap-2">结束时间<KimaTextField v-model="form.endsAt" label="结束时间" placeholder="ISO时间，留空长期有效" /></label>
        <div class="grid grid-cols-1 gap-2">总使用次数上限<KimaNumberField v-model="form.maxUses" label="总使用次数" :min="1" placeholder="不限" /></div>
        <div class="grid grid-cols-1 gap-2">每位客户使用上限<KimaNumberField v-model="form.perUserLimit" label="每位客户使用次数" :min="1" placeholder="不限" /></div>
        <KimaCheckbox v-model="form.firstOrderOnly" label="仅限客户首次购买" /><KimaCheckbox v-model="form.recurring" label="后续续费沿用优惠价" /><KimaCheckbox v-model="form.active" label="启用这个优惠码" />
        <fieldset class="grid grid-cols-1 gap-3"><legend class="mb-3 font-medium">适用商品（全部不选即不限）</legend><KimaCheckbox v-for="product in props.products" :key="product.id" :label="product.name" :model-value="form.productIds.includes(product.id)" @update:model-value="toggle(form.productIds, product.id)" /></fieldset>
        <fieldset class="grid grid-cols-1 gap-3"><legend class="mb-3 font-medium">适用周期（全部不选即不限）</legend><KimaCheckbox v-for="period in props.periods" :key="period.period" :label="period.label" :model-value="form.periods.includes(period.period)" @update:model-value="toggle(form.periods, period.period)" /></fieldset>
      </form>
      <template #footer><KimaButton form="promotion-form" type="submit" class="w-full" :loading="busy" :disabled="busy">保存优惠码</KimaButton></template>
    </KimaDrawer>
  </KimaCard>
</template>
