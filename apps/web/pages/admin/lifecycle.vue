<!-- 服务生命周期工作台：审批取消与实际资源任务分开显示。调用：/admin/lifecycle。 -->
<script setup lang="ts">
import type { ManagedService, Cancellation, ServiceUpgrade } from '~/features/lifecycle';
import { cancellationNames, periodNames, upgradeNames } from '~/features/lifecycle';
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
import { serviceActionNames } from '~/features/service';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '服务生命周期', robots: 'noindex, nofollow' });
const api = useApi(), search = ref(''), filter = ref('pending');
const { data: requests, pending, error, refresh } = await useAsyncData('admin-service-cancellations', () => api<Cancellation[]>('/admin/service-cancellations'));
const { data: services, error: serviceError, refresh: refreshServices } = await useAsyncData('admin-lifecycle-services', () => api<ManagedService[]>('/admin/services'));
const { data: upgrades, error: upgradeError, refresh: refreshUpgrades } = await useAsyncData('admin-service-upgrades', () => api<ServiceUpgrade[]>('/admin/service-upgrades'));
const shown = computed(() => requests.value?.filter(item => (!filter.value || item.status === filter.value) && `${item.serviceName} ${item.email || item.phone || ''} ${item.reason}`.toLowerCase().includes(search.value.trim().toLowerCase())) ?? []);
const selected = ref<Cancellation | null>(null), decision = ref<'approve' | 'reject'>('approve'), reason = ref(''), password = ref(''), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false), busy = ref(false), failure = ref(''), success = ref('');
const open = computed({ get: () => !!selected.value, set: (value: boolean) => {
        if (!value && !busy.value)
            selected.value = null;
    } });
function begin(item: Cancellation, action: 'approve' | 'reject') { selected.value = item; decision.value = action; reason.value = ''; password.value = ''; proof.value = { mode: 'totp', code: '' }; factorOpen.value = false; failure.value = ''; success.value = ''; }
async function reload() { await Promise.all([refresh(), refreshServices(), refreshUpgrades()]); }
async function submit() {
    if (!selected.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        const result = await api<{
            status: string;
        }>(`/admin/service-cancellations/${selected.value.id}/decide`, { method: 'POST', body: { action: decision.value, reason: reason.value.trim(), password: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } });
        success.value = cancellationNames[result.status] || '审批已保存。';
        selected.value = null;
        password.value = '';
        proof.value.code = '';
        await reload();
    }
    catch (reason_) {
        failure.value = apiMessage(reason_);
        if (/双因素|验证码|恢复码/.test(failure.value))
            factorOpen.value = true;
    }
    finally {
        busy.value = false;
    }
}
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>服务生命周期</h1>
        <p>先核对客户意愿，再安排资源取消；执行结果由任务回报。</p>
      </div>
      <div class="flex gap-4 items-center">
        <AppLink to="/admin" :underline="false">管理首页</AppLink>
        <KimaButton variant="tonal" :disabled="pending || busy" @click="reload">刷新</KimaButton>
      </div>
    </header>
    <KimaAlert v-if="success" class="mb-5">{{ success }}</KimaAlert>
    <section class="panel p-5 mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label class="field-label min-w-0">
        <span class="form-label">查找取消申请</span>
        <KimaTextField v-model="search" label="查找取消申请" placeholder="服务、账户邮箱或取消原因" />
      </label>
      <label class="field-label min-w-0">
        <span class="form-label">申请状态</span>
        <KimaSelect
          v-model="filter"
          label="申请状态"
          :items="[{value:'pending',label:'等待审核'},{value:'approved',label:'等待到期'},{value:'executing',label:'正在终止'},{value:'executed',label:'已经终止'},{value:'rejected',label:'未批准'},{value:'withdrawn',label:'已撤回'},{value:'',label:'全部状态'}]"
        />
      </label>
    </section>
    <RequestState
      :pending="pending && !requests"
      :error="error"
      :empty="!shown.length"
      title="没有符合条件的申请"
      description="更换筛选条件，或稍后再来查看。"
      @retry="refresh"
    />
    <div class="grid grid-cols-1 gap-5">
      <article v-for="item in shown" :key="item.id" class="panel p-5 sm:p-7">
        <div class="flex flex-wrap justify-between gap-3">
          <div>
            <h2 class="font-semibold text-lg break-words">{{ item.serviceName }}</h2>
            <p class="muted text-sm mt-2 break-all">{{ item.email || item.phone || '客户账号' }}</p>
          </div>
          <KimaChip>{{ cancellationNames[item.status] || item.status }}</KimaChip>
        </div>
        <dl class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt class="muted text-sm">客户申请</dt>
            <dd>{{ item.mode==='immediate'?'审核后立即取消':'当前周期到期后取消' }}</dd>
          </div>
          <div>
            <dt class="muted text-sm">提交时间</dt>
            <dd>{{ date(item.createdAt) }}</dd>
          </div>
        </dl>
        <p class="mt-5 whitespace-pre-wrap break-words">{{ item.reason }}</p>
        <div
          v-if="services?.find(service=>service.id===item.serviceId)"
          class="bg-[var(--kima-color-layer-2)] rounded-2xl p-4 mt-5"
        >
          <template v-for="service in services.filter(service=>service.id===item.serviceId)" :key="service.id">
            <div class="flex flex-wrap items-center gap-3">
              <StatusBadge :status="service.status" />
              <span>
                {{ periodNames[service.billingPeriod] || service.billingPeriod }}
                ·
                {{ service.billingMonths===0?'一次性服务':date(service.dueAt)+' 到期' }}
              </span>
            </div>
            <p class="muted mt-3">{{ service.operation?`当前任务：${serviceActionNames[service.operation.action]}`:'当前没有在途操作' }}</p>
          </template>
        </div>
        <p v-if="item.decisionReason" class="muted mt-5 whitespace-pre-wrap">审核说明：{{ item.decisionReason }}</p>
        <p v-if="item.executeAt" class="muted mt-3">安排时间：{{ date(item.executeAt) }}</p>
        <div v-if="item.status==='pending'" class="flex flex-wrap gap-3 mt-6">
          <KimaButton :disabled="busy" @click="begin(item,'approve')">核对并批准</KimaButton>
          <KimaButton variant="tonal" :disabled="busy" @click="begin(item,'reject')">拒绝申请</KimaButton>
        </div>
        <AppLink v-if="item.jobId" to="/admin?tab=jobs" :underline="false" class="min-h-11 inline-flex items-center mt-3">查看执行任务</AppLink>
      </article>
    </div>
    <section class="mt-8">
      <h2 class="font-semibold text-xl mb-5">服务升降级</h2>
      <KimaAlert v-if="upgradeError" variant="danger">升降级记录读取失败，请刷新。</KimaAlert>
      <p v-else-if="!upgrades?.length" class="muted">当前没有已提交的方案变更。</p>
      <div class="grid grid-cols-1 gap-4">
        <article v-for="item in upgrades" :key="item.id" class="panel p-5 sm:p-7">
          <div class="flex flex-wrap justify-between gap-3">
            <h3 class="font-semibold">{{ item.productName }}</h3>
            <KimaChip>{{ item.jobState==='failed'?'任务需要跟进':upgradeNames[item.status] || item.status }}</KimaChip>
          </div>
          <p class="muted mt-3 break-all">
            {{ item.email || item.phone || '客户账号' }}
            · 本次差价
            {{ money(item.amountCents,item.currency,item.currencyDecimals) }}
            · 后续周期价
            {{ money(item.renewAmountCents,item.currency,item.currencyDecimals) }}
          </p>
          <p v-if="item.jobError" class="mt-3 break-words">{{ item.jobError }}</p>
          <AppLink v-if="item.jobId" to="/admin?tab=jobs" :underline="false" class="min-h-11 inline-flex items-center mt-3">查看并跟进实际执行任务</AppLink>
          <AppLink v-if="item.status==='review'" to="/admin?tab=billing-reviews" class="min-h-11 inline-flex items-center mt-3 ml-4">核对已收款项</AppLink>
        </article>
      </div>
    </section>
    <KimaAlert v-if="serviceError" variant="danger" class="mt-5">服务详情读取失败，审批前请刷新核对。</KimaAlert>
    <KimaDrawer
      v-model:open="open"
      :title="decision==='approve'?'批准取消这份服务？':'拒绝这次取消申请？'"
      role="alertdialog"
      placement="right"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form id="cancellation-decision" class="drawer-form" @submit.prevent="submit">
        <p class="font-semibold break-words">{{ selected?.serviceName }}</p>
        <KimaAlert v-if="decision==='approve'">
          {{ selected?.mode==='immediate'?'批准后会排入终止任务。资源何时完成删除，以执行回报为准。':'批准后关闭自动续费，并在当前到期时间安排终止。进入实际执行前，客户可以撤回。' }}
        </KimaAlert>
        <label class="field-label min-w-0">
          <span class="form-label">审核说明</span>
          <KimaTextarea v-model="reason" label="审核说明" required :maxlength="1000" :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">当前管理员密码</span>
          <KimaTextField
            v-model="password"
            label="当前管理员密码"
            type="password"
            autocomplete="current-password"
            required
            maxlength="128"
            :disabled="busy"
          />
        </label>
        <KimaCollapsible v-model:open="factorOpen" label="已启用双因素认证？填写安全验证">
          <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
        </KimaCollapsible>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="selected=null">返回核对</KimaButton>
        <KimaButton type="submit" form="cancellation-decision" :loading="busy">{{ decision==='approve'?'确认批准':'确认拒绝' }}</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
