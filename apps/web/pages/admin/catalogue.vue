<!-- 商品目录管理：分组、周期、配置和优惠码在对应表单保存；金额转分使用BigInt。调用：管理员访问/admin/catalogue。 -->
<script setup lang="ts">
import { KimaCheckbox, KimaNumberField } from '@kernel4632/kima';
import type { BillingPeriod, ProductOption } from '~/types/api';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '商品目录管理', robots: 'noindex, nofollow' });
const api = useApi();
type Group = { id: string; name: string; description: string; parentId: string | null; sort: number; active: boolean };
type Meta = { groups: Group[]; products: { id: string; name: string; priceCents: string; groupId: string | null; currency: string; currencyDecimals?:number; trialDays: number }[]; periods: { period: BillingPeriod; label: string }[] };
const { data, pending, error, refresh } = await useAsyncData('catalogue-admin', () => api<Meta>('/admin/catalogue'));
const busy = ref(false), message = ref(''), saved = ref(''), productId = ref(''), groupId = ref<string | null>(null);
const groupEditing = ref('');
const group = reactive({ name: '', description: '', parentId: null as string | null, sort: 0, active: true });
type Cycle = { period: BillingPeriod; priceYuan: string; setupYuan: string; active: boolean };
type Choice = { value: string; label: string; pricesYuan: Partial<Record<BillingPeriod, string>>; setupYuan: string };
type Option = { key: string; name: string; kind: ProductOption['kind']; required: boolean; minimum: number; maximum: number; pricesYuan: Partial<Record<BillingPeriod, string>>; setupYuan: string; choices: Choice[]; sort: number; active: boolean };
const cycles = ref<Cycle[]>([]), options = ref<Option[]>([]), trialDays = ref(7);
const periodItems = computed(() => data.value?.periods || []);
const groupItems = computed(() => [{ value: null, label: '不分组' }, ...(data.value?.groups || []).map(item => ({ value: item.id, label: item.name }))]);
const productCurrency=computed(()=>data.value?.products.find(item=>item.id===productId.value)?.currency||'CNY');
const productDecimals=computed(()=>data.value?.products.find(item=>item.id===productId.value)?.currencyDecimals);
const yuan = (value:string)=>amount(value,productCurrency.value,productDecimals.value);
const cents = (value:string)=>toCents(value,true,productCurrency.value,productDecimals.value);
function prices(values: Partial<Record<BillingPeriod, string>>, transform: (value: string) => string) { return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '').map(([period, value]) => [period, transform(value!)])); }
function editGroup(item?: Group) { groupEditing.value = item?.id || ''; Object.assign(group, item || { name: '', description: '', parentId: null, sort: 0, active: true }); }
async function saveGroup() {
  busy.value = true; message.value = ''; saved.value = '';
  try { await api(`/admin/catalogue/groups${groupEditing.value ? '/' + groupEditing.value : ''}`, { method: groupEditing.value ? 'PUT' : 'POST', body: { name: group.name, description: group.description, parentId: group.parentId, sort: group.sort, active: group.active } }); await refresh(); editGroup(); saved.value = '商品分组已保存。'; }
  catch (error) { message.value = apiMessage(error); } finally { busy.value = false; }
}
let selected = 0;
watch(productId, async id => {
  const token = ++selected; message.value = ''; saved.value = ''; cycles.value = []; options.value = [];
  if (!id) return;
  busy.value = true;
  try {
    const details = await api<{ trialDays: number; periods: { period: BillingPeriod; priceCents: string; setupCents: string; active: boolean }[]; options: (ProductOption & { sort?: number; active?: boolean })[] }>(`/admin/catalogue/products/${id}`);
    if (token !== selected) return;
    trialDays.value = details.trialDays || 7;
    groupId.value = data.value?.products.find(item => item.id === id)?.groupId || null;
    cycles.value = details.periods.map(item => ({ period: item.period, priceYuan: yuan(item.priceCents), setupYuan: yuan(item.setupCents), active: item.active }));
    if (!cycles.value.length) cycles.value.push({ period: 'month', priceYuan: yuan(data.value!.products.find(item => item.id === id)!.priceCents), setupYuan: '0.00', active: true });
    options.value = details.options.map(item => ({ key: item.key, name: item.name, kind: item.kind, required: item.required, minimum: item.minimum, maximum: item.maximum, pricesYuan: prices(item.prices, yuan), setupYuan: yuan(item.setupCents), choices: item.choices.map(choice => ({ value: choice.value, label: choice.label, pricesYuan: prices(choice.prices, yuan), setupYuan: yuan(choice.setupCents) })), sort: item.sort || 0, active: item.active !== false }));
  } catch (error) { if (token === selected) message.value = apiMessage(error); } finally { if (token === selected) busy.value = false; }
});
function addPeriod() { const period = periodItems.value.find(item => !cycles.value.some(cycle => cycle.period === item.period)); if (period) cycles.value.push({ period: period.period, priceYuan: '0.00', setupYuan: '0.00', active: true }); }
function addOption() { options.value.push({ key: `option_${options.value.length + 1}`, name: '', kind: 'select', required: true, minimum: 0, maximum: 100, pricesYuan: {}, setupYuan: '0.00', choices: [{ value: 'standard', label: '标准', pricesYuan: {}, setupYuan: '0.00' }], sort: options.value.length, active: true }); }
async function saveProduct() {
  busy.value = true; message.value = ''; saved.value = '';
  try {
    const body = { groupId: groupId.value, trialDays: trialDays.value, periods: cycles.value.map(item => ({ period: item.period, priceCents: cents(item.priceYuan), setupCents: cents(item.setupYuan), active: item.active })), options: options.value.map(item => ({ key: item.key, name: item.name, kind: item.kind, required: item.required, minimum: item.minimum, maximum: item.maximum, prices: prices(item.pricesYuan, cents), setupCents: cents(item.setupYuan), choices: item.choices.map(choice => ({ value: choice.value, label: choice.label, prices: prices(choice.pricesYuan, cents), setupCents: cents(choice.setupYuan) })), sort: item.sort, active: item.active })) };
    await api(`/admin/catalogue/products/${productId.value}`, { method: 'PUT', body }); await refresh(); saved.value = '计费周期和配置已保存，新订单会使用这份报价。';
  } catch (error) { message.value = error instanceof Error ? error.message : apiMessage(error); } finally { busy.value = false; }
}
</script>
<template>
  <div>
    <AppLink to="/admin?tab=products" class="auth-back mb-6">返回产品管理</AppLink>
    <header class="page-heading"><div><h1>商品目录</h1><p>管理分组、计费周期和可选资源。金额按所选商品的币种填写。</p></div></header>
    <KimaAlert v-if="message" variant="danger" class="mb-6">{{ message }}</KimaAlert><KimaAlert v-if="saved" variant="success" class="mb-6">{{ saved }}</KimaAlert>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <div v-if="data" class="grid grid-cols-1 gap-6">
      <KimaCard class="p-6">
        <h2 class="text-xl mb-4">商品分组</h2>
        <div class="flex flex-wrap gap-2 mb-6"><KimaButton variant="tonal" :disabled="busy" @click="editGroup()">新增分组</KimaButton><KimaButton v-for="item in data.groups" :key="item.id" variant="text" :disabled="busy" @click="editGroup(item)">{{ item.name }}{{ item.active ? '' : '（已停用）' }}</KimaButton></div>
        <form class="grid grid-cols-1 gap-4 md:grid-cols-2" @submit.prevent="saveGroup">
          <label class="grid grid-cols-1 gap-2">分组名称<KimaTextField v-model="group.name" label="分组名称" required maxlength="100" /></label>
          <div class="grid grid-cols-1 gap-2">上级分组<KimaSelect v-model="group.parentId" label="上级分组" :items="groupItems.filter(item => item.value !== groupEditing)" /></div>
          <label class="grid grid-cols-1 gap-2 md:col-span-2">分组说明<KimaTextarea v-model="group.description" label="分组说明" /></label>
          <div class="grid grid-cols-1 gap-2">排序<KimaNumberField v-model="group.sort" label="分组排序" /></div><KimaCheckbox v-model="group.active" label="开放这个分组" />
          <KimaButton type="submit" :loading="busy">{{ groupEditing ? '保存分组' : '创建分组' }}</KimaButton>
        </form>
      </KimaCard>
      <KimaCard class="p-6">
        <h2 class="text-xl mb-4">周期与资源配置</h2>
        <div class="grid grid-cols-1 gap-2 mb-6">选择产品<KimaSelect v-model="productId" label="选择产品" searchable :items="data.products.map(item => ({ value: item.id, label: item.name }))" :disabled="busy" /></div>
        <form v-if="productId && cycles.length" class="grid grid-cols-1 gap-6" @submit.prevent="saveProduct">
          <div class="grid grid-cols-1 gap-2">所属分组<KimaSelect v-model="groupId" label="所属分组" :items="groupItems" /></div>
          <section class="grid grid-cols-1 gap-4"><h3 class="font-semibold">计费周期</h3><div v-if="cycles.some(item => item.period === 'ontrial')" class="grid gap-2">试用天数<KimaNumberField v-model="trialDays" label="每次试用天数" :min="1" :max="365" /><p class="form-hint">每个主账号对本商品永久只能领取一次。试用周期金额和安装费均填写0。</p></div>
            <div v-for="(cycle, index) in cycles" :key="index" class="grid grid-cols-1 gap-4 rounded-2xl border p-4 md:grid-cols-4" style="border-color: var(--kima-color-outline-variant)">
              <div class="grid grid-cols-1 gap-2">周期<KimaSelect v-model="cycle.period" label="计费周期" :items="periodItems.map(item => ({ value: item.period, label: item.label }))" /></div>
              <label class="grid grid-cols-1 gap-2">周期金额（{{ productCurrency }}）<KimaTextField v-model="cycle.priceYuan" label="周期金额" inputmode="decimal" required /></label>
              <label class="grid grid-cols-1 gap-2">安装费（{{ productCurrency }}）<KimaTextField v-model="cycle.setupYuan" label="安装费" inputmode="decimal" required /></label>
              <div class="flex items-center gap-2"><KimaCheckbox v-model="cycle.active" label="开放" /><KimaButton variant="text" :disabled="cycles.length <= 1" @click="cycles.splice(index, 1)">移除</KimaButton></div>
            </div>
            <KimaButton variant="tonal" :disabled="cycles.length >= 10" @click="addPeriod">增加计费周期</KimaButton>
            <p class="form-hint">未配置月付时沿用产品基础月价。停用月付请保留月付行并关闭“开放”。一次性产品没有续费。</p>
          </section>
          <section class="grid grid-cols-1 gap-4"><h3 class="font-semibold">可选资源</h3>
            <KimaCard v-for="(option, index) in options" :key="index" class="p-5 grid grid-cols-1 gap-4">
              <div class="grid grid-cols-1 gap-4 md:grid-cols-3"><label class="grid grid-cols-1 gap-2">显示名称<KimaTextField v-model="option.name" label="配置名称" required /></label><label class="grid grid-cols-1 gap-2">开发标识<KimaTextField v-model="option.key" label="配置标识" pattern="[a-z][a-z0-9_]{0,39}" required /></label><div class="grid grid-cols-1 gap-2">选项类型<KimaSelect v-model="option.kind" label="选项类型" :items="[{value:'select',label:'下拉选择'},{value:'quantity',label:'数量资源'},{value:'boolean',label:'开关附加项'}]" /></div></div>
              <div class="flex flex-wrap items-center gap-4"><KimaCheckbox v-if="option.kind === 'select'" v-model="option.required" label="默认选择第一项" /><KimaCheckbox v-model="option.active" label="启用配置" /><KimaButton variant="text" @click="options.splice(index, 1)">移除配置</KimaButton></div>
              <template v-if="option.kind === 'select'">
                <div v-for="(choice, choiceIndex) in option.choices" :key="choiceIndex" class="grid grid-cols-1 gap-3 border-t pt-4" style="border-color: var(--kima-color-outline-variant)">
                  <div class="grid grid-cols-1 gap-3 md:grid-cols-3"><label class="grid grid-cols-1 gap-2">选项文字<KimaTextField v-model="choice.label" label="选项文字" required /></label><label class="grid grid-cols-1 gap-2">选项值<KimaTextField v-model="choice.value" label="选项值" required /></label><label class="grid grid-cols-1 gap-2">安装费（{{ productCurrency }}）<KimaTextField v-model="choice.setupYuan" label="选项安装费" inputmode="decimal" /></label></div>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"><label v-for="cycle in cycles" :key="cycle.period" class="grid grid-cols-1 gap-2">{{ periodItems.find(item => item.period === cycle.period)?.label }}加价（{{ productCurrency }}）<KimaTextField v-model="choice.pricesYuan[cycle.period]" label="周期加价" placeholder="0.00" inputmode="decimal" /></label></div>
                  <KimaButton variant="text" :disabled="option.choices.length <= 1" @click="option.choices.splice(choiceIndex, 1)">移除选项</KimaButton>
                </div>
                <KimaButton variant="tonal" @click="option.choices.push({ value: 'choice_' + (option.choices.length + 1), label: '', pricesYuan: {}, setupYuan: '0.00' })">增加选项</KimaButton>
              </template>
              <template v-else>
                <div v-if="option.kind === 'quantity'" class="grid grid-cols-1 gap-3 sm:grid-cols-2"><div class="grid grid-cols-1 gap-2">最少数量<KimaNumberField v-model="option.minimum" label="最少数量" :min="0" /></div><div class="grid grid-cols-1 gap-2">最多数量<KimaNumberField v-model="option.maximum" label="最多数量" :min="option.minimum" :max="100000" /></div></div>
                <label class="grid grid-cols-1 gap-2">{{ option.kind === 'quantity' ? '每单位' : '启用时' }}安装费（{{ productCurrency }}）<KimaTextField v-model="option.setupYuan" label="配置安装费" inputmode="decimal" /></label>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"><label v-for="cycle in cycles" :key="cycle.period" class="grid grid-cols-1 gap-2">{{ periodItems.find(item => item.period === cycle.period)?.label }}{{ option.kind === 'quantity' ? '每单位' : '' }}加价（{{ productCurrency }}）<KimaTextField v-model="option.pricesYuan[cycle.period]" label="配置周期加价" placeholder="0.00" inputmode="decimal" /></label></div>
              </template>
            </KimaCard>
            <KimaButton variant="tonal" :disabled="options.length >= 50" @click="addOption">增加资源配置</KimaButton>
          </section>
          <KimaButton type="submit" :loading="busy" :disabled="busy">保存产品配置</KimaButton>
        </form>
      </KimaCard>
      <CatalogueRules v-if="productId" :key="productId" :product-id="productId" :options="options.filter(item => item.active).map(item => ({ ...item, choices: item.choices.map(choice => ({value:choice.value,label:choice.label})) }))" :periods="periodItems" :currency="data.products.find(item => item.id === productId)?.currency || 'CNY'" :currency-decimals="data.products.find(item => item.id === productId)?.currencyDecimals" />
      <CataloguePromotions :products="data.products" :periods="periodItems" />
    </div>
  </div>
</template>
