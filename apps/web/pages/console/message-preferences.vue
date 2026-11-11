<!-- 消息偏好：营销退订即时作用于待发任务，免打扰按客户时区计算。调用：/console/message-preferences。 -->
<script setup lang="ts">
import { KimaCheckbox } from '@kernel4632/kima';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '消息接收偏好', robots: 'noindex, nofollow' });
interface Preferences {
    emailMarketing: boolean;
    smsMarketing: boolean;
    siteMarketing: boolean;
    quietEnabled: boolean;
    quietStart: number;
    quietEnd: number;
    timezone: string;
}
const api = useApi(), busy = ref(false), failure = ref(''), success = ref('');
const { data, pending, error, refresh } = await useAsyncData('message-preferences', () => api<Preferences>('/message-preferences'));
const form = reactive({ emailMarketing: false, smsMarketing: false, siteMarketing: false, quietEnabled: false, start: '21:00', end: '08:00' });
function time(value: number) { return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'); }
function minutes(value: string) { const [hour, minute] = value.split(':').map(Number); return hour! * 60 + minute!; }
watch(data, value => {
    if (value)
        Object.assign(form, { emailMarketing: value.emailMarketing, smsMarketing: value.smsMarketing, siteMarketing: value.siteMarketing, quietEnabled: value.quietEnabled, start: time(value.quietStart), end: time(value.quietEnd) });
}, { immediate: true });
async function save() {
    busy.value = true;
    failure.value = '';
    success.value = '';
    try {
        await api('/message-preferences', { method: 'PUT', body: { emailMarketing: form.emailMarketing, smsMarketing: form.smsMarketing, siteMarketing: form.siteMarketing, quietEnabled: form.quietEnabled, quietStart: minutes(form.start), quietEnd: minutes(form.end) } });
        await refresh();
        success.value = '偏好已保存，待发营销消息会按新设置处理。';
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
</script>
<template>
  <div>
    <AppLink to="/console/settings" :underline="false" class="auth-back mb-6">返回账户与安全</AppLink>
    <header class="page-heading">
      <div>
        <h1>消息接收偏好</h1>
        <p>选择愿意接收的营销消息，再留一段不被打扰的时间。</p>
      </div>
    </header>
    <RequestState :pending="pending && !data" :error="error" @retry="refresh" />
    <form v-if="data && !error" class="panel p-5 sm:p-7 grid grid-cols-1 gap-6" @submit.prevent="save">
      <h2 class="font-semibold text-xl">营销订阅</h2>
      <KimaCheckbox v-model="form.emailMarketing" label="接收营销邮件" :disabled="busy" />
      <KimaCheckbox v-model="form.smsMarketing" label="接收营销短信" :disabled="busy" />
      <KimaCheckbox v-model="form.siteMarketing" label="接收营销站内消息" :disabled="busy" />
      <KimaAlert>验证码和必要的安全通知照常送达。取消订阅会停止此渠道尚未发送的营销任务。</KimaAlert>
      <h2 class="font-semibold text-xl">免打扰时间</h2>
      <KimaCheckbox v-model="form.quietEnabled" label="批量通知与关怀消息在这段时间后再发送" :disabled="busy" />
      <div v-if="form.quietEnabled" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label class="field-label min-w-0">
          <span class="form-label">开始时间</span>
          <KimaTextField v-model="form.start" label="开始时间" type="time" required :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">结束时间</span>
          <KimaTextField v-model="form.end" label="结束时间" type="time" required :disabled="busy" />
        </label>
      </div>
      <p class="form-hint">按 {{ data.timezone }} 的本地时间生效，可跨越午夜。时区可在账户资料中修改。</p>
      <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      <KimaAlert v-if="success" aria-live="polite">{{ success }}</KimaAlert>
      <div>
        <KimaButton type="submit" :loading="busy">保存接收偏好</KimaButton>
      </div>
    </form>
  </div>
</template>
