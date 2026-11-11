<!-- 产品选择：KIMA抽屉承接周期与配置，报价逐次请求服务端；旧回包不会覆盖新选择。调用：v-model:open + product。 -->
<script setup lang="ts">
import type { Product, ProductOption, BillingPeriod, ProductConfiguration } from '~/types/api';
const props = defineProps<{ product: Product | null; open: boolean; action: 'buy' | 'cart'; periods: { period: BillingPeriod; label: string }[] }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const router = useRouter();
const api = useApi();
const period = ref<BillingPeriod>('month');
const configuration = ref<ProductConfiguration>({});
type Quote = { unitPriceCents: string; setupCents: string; configuration: ProductConfiguration; periodLabel: string; options?: ProductOption[];currency?:string;currencyDecimals?:number };
const quote = ref<Quote | null>(null);
const effectiveOptions = ref<ProductOption[]>([]);
const loading = ref(false), saving = ref(false), message = ref('');
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let key = '';
const choices = computed(() => {
  const cycles = props.product?.periods || [];
  const items = cycles.filter(item => item.active).map(item => ({ value: item.period, label: `${props.periods.find(period => period.period === item.period)?.label || item.period} · ${money(item.priceCents,props.product?.currency,props.product?.currencyDecimals)}` }));
  if (!cycles.some(item => item.period === 'month') && props.product) items.unshift({ value: 'month', label: `月付 · ${money(props.product.priceCents,props.product.currency,props.product.currencyDecimals)}` });
  return items;
});
watch(() => [props.open, props.product?.id], () => {
  if (!props.open || !props.product) { revision++; return; }
  period.value = (choices.value[0]?.value || 'month') as BillingPeriod;
  configuration.value = {};
  for (const option of props.product.options || []) configuration.value[option.key] = option.kind === 'quantity' ? option.minimum : option.kind === 'boolean' ? false : option.required ? option.choices[0]?.value || '' : '';
  effectiveOptions.value = props.product.options || [];
  quote.value = null; message.value = ''; key = crypto.randomUUID();
  requestQuote();
});
watch([period, configuration], () => { key = crypto.randomUUID(); requestQuote(); }, { deep: true });
function requestQuote() {
  const current = ++revision;
  clearTimeout(timer);
  quote.value = null;
  if (!props.open || !props.product) return;
  loading.value = true; message.value = '';
  const body = { productId: props.product.id, quantity: 1, period: period.value, configuration: { ...configuration.value } };
  timer = setTimeout(async () => {
    try {
      let result: Quote;
      try { result = await api<Quote>('/catalogue/my-quote', { method: 'POST', body }); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 401) throw error; result = await api<Quote>('/catalogue/quote', { method: 'POST', body }); }
      if (current === revision) {
        effectiveOptions.value = result.options || props.product?.options || [];
        const identity = (value: ProductConfiguration) => JSON.stringify(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)));
        if (identity(configuration.value) !== identity(result.configuration)) configuration.value = result.configuration;
        quote.value = result;
      }
    }
    catch (error) { if (current === revision) message.value = apiMessage(error); }
    finally { if (current === revision) loading.value = false; }
  }, 180);
}
onBeforeUnmount(() => { clearTimeout(timer); revision++; });
async function submit() {
  if (!quote.value || !props.product) return;
  saving.value = true; message.value = '';
  const body = { productId: props.product.id, period: period.value, configuration: quote.value.configuration };
  try {
    if (props.action === 'cart') { await api('/cart', { method: 'POST', body: { ...body, quantity: 1 } }); emit('update:open', false); await router.push('/console/cart'); }
    else { const order = await api<{ invoiceId: string; status: string }>('/orders', { method: 'POST', headers: { 'Idempotency-Key': key }, body }); emit('update:open', false); await router.push(order.status === 'paid' ? '/console/services' : `/console/invoices/${order.invoiceId}`); }
  } catch (error) { if ((error as { statusCode?: number }).statusCode === 401) await router.push('/login?next=/products'); else message.value = apiMessage(error); }
  finally { saving.value = false; }
}
</script>
<template>
  <KimaDrawer :open="open" :title="product?.name || '选择产品'" description="选好周期与资源配置，再核对当前报价。" placement="right" @update:open="emit('update:open', $event)">
    <div class="grid grid-cols-1 gap-6">
      <div class="grid grid-cols-1 gap-2"><span class="font-medium">计费周期</span><KimaSelect v-model="period" :items="choices" label="计费周期" :disabled="saving" /></div>
      <ProductOptions v-model="configuration" :options="effectiveOptions" :disabled="saving" />
      <KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
      <div aria-live="polite" class="rounded-2xl border p-5" style="border-color: var(--kima-color-outline-variant)">
        <p class="muted text-sm">每件首次应付</p>
        <p class="numbers text-3xl font-semibold mt-2">{{ loading ? '正在核对…' : quote ? money(quote.unitPriceCents, quote.currency || product?.currency,quote.currencyDecimals ?? product?.currencyDecimals) : '待核对' }}</p>
        <p v-if="quote" class="form-hint mt-2">{{ quote.periodLabel }}{{ BigInt(quote.setupCents) > 0n ? `，含安装费 ${money(quote.setupCents, quote.currency || product?.currency,quote.currencyDecimals ?? product?.currencyDecimals)}` : '' }}。报价已核对当前账号，优惠码可在购物车使用。</p>
        <p v-if="period === 'ontrial'" class="form-hint mt-2">每个主账号仅可试用本商品一次，试用期 {{ product?.trialDays || 7 }} 天，试用不能免费续期。</p>
      </div>
    </div>
    <template #footer><KimaButton class="w-full" :loading="saving" :disabled="loading || !quote || saving" @click="submit">{{ action === 'cart' ? '加入购物车' : '确认，创建订单' }}</KimaButton></template>
  </KimaDrawer>
</template>
