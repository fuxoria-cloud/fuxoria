<!-- 双方确认的服务转移：每个动作重新确认主账号身份。调用：/console/transfers。 -->
<script setup lang="ts">
import type { ServiceTransfer } from '~/features/lifecycle';
import { transferNames } from '~/features/lifecycle';
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '服务转移', robots: 'noindex, nofollow' });
const api = useApi(), account = useAccount();
const { data, pending, error, refresh } = await useAsyncData('service-transfers', () => api<ServiceTransfer[]>('/service-transfers'));
const selected = ref<ServiceTransfer | null>(null), action = ref<'accept' | 'reject' | 'cancel'>('accept'), password = ref(''), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false), busy = ref(false), failure = ref(''), success = ref('');
const names = { accept: '接收服务', reject: '拒绝转移', cancel: '撤销邀请' };
const open = computed({ get: () => !!selected.value, set: (value: boolean) => {
        if (!value && !busy.value)
            selected.value = null;
    } });
function begin(item: ServiceTransfer, command: 'accept' | 'reject' | 'cancel') { selected.value = item; action.value = command; password.value = ''; proof.value = { mode: 'totp', code: '' }; factorOpen.value = false; failure.value = ''; success.value = ''; }
function available(item: ServiceTransfer) { return item.status === 'pending' && new Date(item.expiresAt).getTime() > Date.now(); } // 已过期邀请不显示可执行动作
async function submit() {
    if (!selected.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        await api(`/service-transfers/${selected.value.id}/${action.value}`, { method: 'POST', body: { password: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } });
        success.value = action.value === 'accept' ? '服务已接收，可以在我的服务中查看。' : action.value === 'reject' ? '已拒绝这次转移。' : '转移邀请已撤销。';
        selected.value = null;
        password.value = '';
        proof.value.code = '';
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
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
        <h1>服务转移</h1>
        <p>发出的邀请和等待你确认的服务，都在这里。</p>
      </div>
      <KimaButton variant="tonal" :disabled="pending || busy" @click="refresh">刷新记录</KimaButton>
    </header>
    <KimaAlert v-if="success" class="mb-5">
      {{ success }}
      <AppLink to="/console/services">查看我的服务</AppLink>
    </KimaAlert>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="data?.length===0"
      title="还没有转移记录"
      description="要转出服务，请打开对应服务的详情页。"
      action="查看我的服务"
      to="/console/services"
      @retry="refresh"
    />
    <div class="grid grid-cols-1 gap-5">
      <article v-for="item in data" :key="item.id" class="panel p-5 sm:p-7">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="font-semibold text-lg break-words">{{ item.serviceName }}</h2>
          <KimaChip>{{ item.status==='pending' && !available(item)?'已过期':transferNames[item.status] || item.status }}</KimaChip>
        </div>
        <p class="muted mt-3">{{ item.senderId===account.user.value?.id?'你发出的邀请':'等待你接收的服务' }}</p>
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
          <div>
            <dt class="muted text-sm">转出账户</dt>
            <dd class="break-all">{{ (item.senderEmail || item.senderPhone || item.senderId) }}</dd>
          </div>
          <div>
            <dt class="muted text-sm">接收账户</dt>
            <dd class="break-all">{{ (item.recipientEmail || item.recipientPhone || item.recipientId) }}</dd>
          </div>
          <div>
            <dt class="muted text-sm">发出时间</dt>
            <dd>{{ date(item.createdAt) }}</dd>
          </div>
          <div>
            <dt class="muted text-sm">邀请有效至</dt>
            <dd>{{ date(item.expiresAt) }}</dd>
          </div>
        </dl>
        <div v-if="available(item)" class="flex flex-wrap gap-3 mt-6">
          <template v-if="item.recipientId===account.user.value?.id">
            <KimaButton :disabled="busy" @click="begin(item,'accept')">接收服务</KimaButton>
            <KimaButton variant="tonal" :disabled="busy" @click="begin(item,'reject')">拒绝</KimaButton>
          </template>
          <KimaButton v-if="item.senderId===account.user.value?.id" variant="tonal" :disabled="busy" @click="begin(item,'cancel')">撤销邀请</KimaButton>
        </div>
      </article>
    </div>
    <KimaDrawer
      v-model:open="open"
      :title="names[action]"
      role="alertdialog"
      placement="right"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form id="transfer-decision" class="drawer-form" @submit.prevent="submit">
        <p class="font-semibold">{{ selected?.serviceName }}</p>
        <KimaAlert v-if="action==='accept'">确认后你将获得这份服务的管理权。原购买账户的账单与余额不会转入，自动续费需要你重新授权。</KimaAlert>
        <p v-else>{{ action==='reject'?'拒绝后，这次邀请会结束，服务仍由原账户管理。':'撤销后，对方不能再接受这次邀请，服务继续由你管理。' }}</p>
        <label class="field-label min-w-0">
          <span class="form-label">当前登录密码</span>
          <KimaTextField
            v-model="password"
            label="当前登录密码"
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
        <KimaButton variant="tonal" :disabled="busy" @click="selected=null">稍后处理</KimaButton>
        <KimaButton type="submit" form="transfer-decision" :loading="busy">确认{{ names[action] }}</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
