<!-- 服务升降级：先核对剩余时间差价，再创建真实变更账单，资源变更由供应商确认。调用：/console/upgrades?serviceId=<ID>。 -->
<script setup lang="ts">
import { KimaCheckbox } from '@kernel4632/kima';
import type { Product, ProductConfiguration, ProductOption, BillingPeriod } from '~/types/api';
import type { ManagedService, ServiceUpgrade } from '~/features/lifecycle';
import { periodNames, upgradeNames } from '~/features/lifecycle';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '更改服务方案', robots: 'noindex, nofollow' });
const api = useApi(), route = useRoute(), router = useRouter();
const { data: services, error: serviceError } = await useAsyncData('upgrade-services', () => api<ManagedService[]>('/services'));
const { data: history, pending, error, refresh } = await useAsyncData('service-upgrades', () => api<ServiceUpgrade[]>('/service-upgrades'));
const serviceId = ref(String(route.query.serviceId || '')), productId = ref(''), period = ref<BillingPeriod>('month'), configuration = ref<ProductConfiguration>({}), quote = ref<ServiceUpgrade | null>(null), accepted = ref(false), busy = ref(false), failure = ref(''), key = ref('');
interface UpgradeOptions {
    currentProductId: string;
    configuration: ProductConfiguration;
    period: BillingPeriod;
    targets: Product[];
    canUpgrade: boolean;
    reason: string | null;
}
const options = ref<UpgradeOptions | null>(null);
const serviceItems = computed(() => [{ value: '', label: '选择需要变更的服务' }, ...(services.value ?? []).filter(item => ['active', 'suspended'].includes(item.status)).map(item => ({ value: item.id, label: item.name || item.productName || item.id.slice(0, 8) }))]);
const calendarPeriods = ['month', 'quarter', 'halfyear', 'year', 'biennium', 'triennium'];
function availablePeriods(target: Product) {
    const cycles = target.periods ?? [];
    const active = cycles.filter(item => item.active);
    if (!cycles.some(item => item.period === 'month'))
        active.unshift({ period: 'month', priceCents: target.priceCents, setupCents: '0', active: true });
    const source = options.value?.period;
    return active.filter(item => item.period !== 'ontrial' && (item.period === source || ['hour', 'day', 'ontrial'].includes(source ?? '') && calendarPeriods.includes(item.period)));
}
const productItems = computed(() => options.value?.targets.filter(item => availablePeriods(item).length).map(item => ({ value: item.id, label: item.name })) ?? []);
const product = computed(() => options.value?.targets.find(item => item.id === productId.value));
const periodItems = computed(() => product.value ? availablePeriods(product.value).map(item => ({ value: item.period, label: `${periodNames[item.period]} · ${money(item.priceCents, product.value!.currency)}` })) : []);
const effectiveOptions = ref<ProductOption[]>([]), normalizing = ref(false), normalized = ref(false);
let normalizationRevision = 0, normalizationTimer: ReturnType<typeof setTimeout> | undefined;
let reading = 0; // 较早服务的慢回包不能覆盖刚选择的服务
watch(serviceId, async (id) => {
    const current = ++reading;
    options.value = null;
    productId.value = '';
    quote.value = null;
    failure.value = '';
    if (!id)
        return;
    try {
        const result = await api<UpgradeOptions>(`/services/${id}/upgrade-options`);
        if (current !== reading)
            return;
        options.value = result;
        const compatible = result.targets.filter(item => availablePeriods(item).length);
        productId.value = compatible.some(item => item.id === result.currentProductId) ? result.currentProductId : compatible[0]?.id ?? '';
    }
    catch (reason) {
        if (current === reading)
            failure.value = apiMessage(reason);
    }
}, { immediate: true });
watch(productId, () => {
    configuration.value = {};
    effectiveOptions.value = product.value?.options ?? [];
    for (const option of effectiveOptions.value) {
        const old = productId.value === options.value?.currentProductId ? options.value.configuration[option.key] : undefined;
        configuration.value[option.key] = old ?? (option.kind === 'quantity' ? option.minimum : option.kind === 'boolean' ? false : option.required ? option.choices[0]?.value || '' : '');
    }
    period.value = (periodItems.value.some(item => item.value === options.value?.period) ? options.value!.period : periodItems.value[0]?.value ?? 'month');
    quote.value = null;
    accepted.value = false;
});
// 联动配置以服务端规则为准。修正下游配置后重新核对，过期回包不能覆盖新的选择。
watch([productId, period, configuration], () => {
    const revision = ++normalizationRevision;
    clearTimeout(normalizationTimer);
    quote.value = null;
    accepted.value = false;
    normalized.value = false;
    failure.value = '';
    if (!product.value || !periodItems.value.some(item => item.value === period.value)) {
        normalizing.value = false;
        return;
    }
    normalizing.value = true;
    const body = { productId: productId.value, quantity: 1, period: period.value, configuration: { ...configuration.value } };
    normalizationTimer = setTimeout(async () => {
        try {
            const result = await api<{
                configuration: ProductConfiguration;
                options?: ProductOption[];
            }>('/catalogue/my-quote', { method: 'POST', body });
            if (revision !== normalizationRevision)
                return;
            const identity = (value: ProductConfiguration) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
            if (body.productId !== productId.value || body.period !== period.value || identity(body.configuration) !== identity(configuration.value))
                return;
            effectiveOptions.value = result.options ?? product.value?.options ?? [];
            if (identity(configuration.value) !== identity(result.configuration))
                configuration.value = result.configuration;
            normalized.value = true;
        }
        catch (reason) {
            if (revision === normalizationRevision)
                failure.value = apiMessage(reason);
        }
        finally {
            if (revision === normalizationRevision)
                normalizing.value = false;
        }
    }, 180);
}, { deep: true });
onBeforeUnmount(() => { clearTimeout(normalizationTimer); normalizationRevision++; reading++; });
async function requestQuote() {
    if (!serviceId.value || !productId.value || !normalized.value || normalizing.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        quote.value = await api<ServiceUpgrade>(`/services/${serviceId.value}/upgrade-quote`, { method: 'POST', body: { productId: productId.value, configuration: configuration.value, period: period.value } });
        key.value = crypto.randomUUID();
        accepted.value = false;
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function submit() {
    if (!quote.value || !accepted.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        const result = await api<{
            invoiceId: string;
            status: string;
        }>(`/services/${serviceId.value}/upgrades`, { method: 'POST', headers: { 'Idempotency-Key': key.value }, body: { quoteId: quote.value.id } });
        await router.push(result.status === 'paid' ? `/console/services/${serviceId.value}` : `/console/invoices/${result.invoiceId}`);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
const shown = computed(() => history.value?.filter(item => !serviceId.value || item.serviceId === serviceId.value) ?? []);
</script>
<template>
  <div>
    <AppLink :to="serviceId?`/console/services/${serviceId}`:'/console/services'" :underline="false" class="auth-back mb-6">返回服务</AppLink>
    <header class="page-heading">
      <div>
        <h1>更改方案与配置</h1>
        <p>核对目标配置与计费周期，确认费用后再交给供应商变更。</p>
      </div>
    </header>
    <KimaAlert v-if="serviceError" variant="danger" class="mb-5">{{ apiMessage(serviceError) }}</KimaAlert>
    <section class="panel p-5 sm:p-7 grid grid-cols-1 gap-5">
      <label class="field-label min-w-0">
        <span class="form-label">需要变更的服务</span>
        <KimaSelect v-model="serviceId" label="需要变更的服务" :items="serviceItems" :disabled="busy" />
      </label>
      <KimaAlert v-if="options && !options.canUpgrade">{{ options.reason }}</KimaAlert>
      <template v-if="options?.canUpgrade">
        <label class="field-label min-w-0">
          <span class="form-label">目标方案</span>
          <KimaSelect v-model="productId" label="目标方案" :items="productItems" :disabled="busy" />
        </label>
        <label class="field-label min-w-0" v-if="periodItems.length">
          <span class="form-label">变更后的计费周期</span>
          <KimaSelect v-model="period" label="变更后的计费周期" :items="periodItems" :disabled="busy" />
        </label>
        <p class="form-hint">当前为{{ periodNames[options.period] || options.period }}。试用、时付和日付服务可转为产品支持的包月或包年周期。这里只显示同一供应商的方案。</p>
        <KimaAlert v-if="!productItems.length">当前没有支持此服务计费周期的同供应商方案，请联系支持团队。</KimaAlert>
        <ProductOptions v-model="configuration" :options="effectiveOptions" :disabled="busy" />
        <p v-if="normalizing" class="form-hint" aria-live="polite">正在核对可选配置…</p>
        <div>
          <KimaButton variant="tonal" :loading="busy" :disabled="!productId || normalizing || !normalized" @click="requestQuote">核对本次差价</KimaButton>
        </div>
      </template>
      <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
    </section>
    <section v-if="quote" class="panel p-5 sm:p-7 mt-6">
      <h2 class="font-semibold text-xl">确认这次变更</h2>
      <dl class="grid grid-cols-1 gap-5 sm:grid-cols-2 mt-6">
        <div>
          <dt class="muted text-sm">目标方案</dt>
          <dd class="mt-1">{{ quote.productName }}</dd>
        </div>
        <div>
          <dt class="muted text-sm">本次应付差价</dt>
          <dd class="numbers text-3xl mt-1">{{ money(quote.amountCents, quote.currency, quote.currencyDecimals) }}</dd>
        </div>
        <div>
          <dt class="muted text-sm">变更前的周期价格</dt>
          <dd class="mt-1">
            {{ money(quote.oldRenewCents, quote.currency, quote.currencyDecimals) }}
            /
            {{ periodNames[quote.sourcePeriod || options?.period || quote.period] }}
          </dd>
        </div>
        <div>
          <dt class="muted text-sm">变更后的周期价格</dt>
          <dd class="mt-1">{{ money(quote.renewAmountCents, quote.currency, quote.currencyDecimals) }} / {{ periodNames[quote.period] }}</dd>
        </div>
      </dl>
      <dl v-if="Object.keys(quote.configurationLabels).length" class="grid grid-cols-1 gap-3 mt-5">
        <div v-for="(value,name) in quote.configurationLabels" :key="name" class="flex justify-between flex-wrap gap-3">
          <dt class="muted">{{ name }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
      <KimaAlert v-if="quote.cycleChange" class="mt-6">转换周期按新周期价格扣除旧周期尚未使用的金额，抵扣按整数分计算，不重复收取开通费，也不产生现金退款。供应商确认变更后，新的计费周期开始。</KimaAlert>
      <KimaAlert v-else class="mt-6">本次只收取剩余时间的正差价，按整数分向上取整，不重复收取开通费。降配不产生本期退款；下一次续费按新的周期价格。实际配置在供应商确认后更新。</KimaAlert>
      <p class="form-hint mt-4">此报价有效至 {{ new Date(quote.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) }}。</p>
      <KimaCheckbox v-model="accepted" label="我已核对目标配置、差价和后续续费价格" :disabled="busy" class="mt-5" />
      <KimaButton class="mt-5 w-full sm:w-auto" :loading="busy" :disabled="!accepted" @click="submit">
        {{ quote.amountCents==='0'?'确认，提交变更任务':'确认，创建差价账单' }}
      </KimaButton>
    </section>
    <section class="mt-8">
      <header class="page-heading">
        <div>
          <h2 class="text-xl font-semibold">变更记录</h2>
        </div>
        <KimaButton variant="text" :disabled="pending" @click="refresh">刷新</KimaButton>
      </header>
      <RequestState
        :pending="pending && !history"
        :error="error"
        :empty="!shown.length"
        title="还没有变更记录"
        description="已确认的方案变更会保留在这里。"
        @retry="refresh"
      />
      <div class="grid grid-cols-1 gap-4">
        <article v-for="item in shown" :key="item.id" class="panel p-5 sm:p-7">
          <div class="flex justify-between flex-wrap gap-3">
            <h3 class="font-semibold">{{ item.productName }}</h3>
            <KimaChip>{{ item.jobState==='failed'?'任务需要跟进':upgradeNames[item.status] || item.status }}</KimaChip>
          </div>
          <p class="muted mt-3">
            本次差价
            {{ money(item.amountCents, item.currency, item.currencyDecimals) }}
            · 新周期价
            {{ money(item.renewAmountCents, item.currency, item.currencyDecimals) }}
            /
            {{ periodNames[item.period] }}
            ·
            {{ date(item.createdAt) }}
          </p>
          <p v-if="item.jobError" class="mt-3 break-words">{{ item.jobError }}</p>
          <div class="mt-4 flex flex-wrap gap-4">
            <AppLink
              v-if="item.invoiceId"
              :to="`/console/invoices/${item.invoiceId}`"
              :underline="false"
              class="min-h-11 inline-flex items-center"
            >
              查看差价账单
            </AppLink>
            <AppLink :to="`/console/services/${item.serviceId}`" :underline="false" class="min-h-11 inline-flex items-center">查看服务</AppLink>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
