<!-- 公开验证码发送：登录、注册与找回共用真实渠道状态和发送冷却。调用：<AccessChallenge purpose="reset" @issued="..." />。 -->
<script setup lang="ts">
const props = defineProps<{
    purpose: 'login' | 'register' | 'reset';
}>();
const emit = defineEmits<{
    issued: [
        {
            id: string;
            channel: 'email' | 'sms';
            destination: string;
            expiresAt: string;
        }
    ];
}>();
const api = useApi();
const { data, pending, error } = await useAsyncData('access-options', () => api<{
    emailEnabled: boolean;
    smsEnabled: boolean;
    phonePasswordEnabled: boolean;
}>('/auth/access-options'), { server: false });
const channel = ref<'email' | 'sms'>(props.purpose === 'login' ? 'sms' : 'email'), destination = ref(''), cooldown = ref(0), busy = ref(false), failure = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
const channels = computed(() => [...(props.purpose !== 'login' && data.value?.emailEnabled ? [{ value: 'email', label: '邮箱验证' }] : []), ...(data.value?.smsEnabled ? [{ value: 'sms', label: '手机短信验证' }] : [])]);
watch(channels, items => {
    if (!items.some(item => item.value === channel.value))
        channel.value = (items[0]?.value || (props.purpose === 'login' ? 'sms' : 'email')) as 'email' | 'sms';
}, { immediate: true });
watch(channel, () => { destination.value = ''; failure.value = ''; });
async function send() {
    busy.value = true;
    failure.value = '';
    try {
        const result = await api<{
            id: string;
            expiresAt: string;
            retryAfterSeconds: number;
        }>('/auth/challenges', { method: 'POST', body: { purpose: props.purpose, channel: channel.value, destination: destination.value.trim() } });
        emit('issued', { id: result.id, expiresAt: result.expiresAt, channel: channel.value, destination: destination.value.trim() });
        cooldown.value = result.retryAfterSeconds;
        clearInterval(timer);
        timer = setInterval(() => {
            cooldown.value = Math.max(0, cooldown.value - 1);
            if (!cooldown.value)
                clearInterval(timer);
        }, 1000);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <div class="grid grid-cols-1 gap-5">
    <RequestState :pending="pending" :error="error" />
    <KimaAlert v-if="!pending && data && !channels.length">当前没有启用此验证方式，请使用邮箱密码登录或联系支持团队。</KimaAlert>
    <template v-if="channels.length">
      <label class="field-label min-w-0" v-if="channels.length>1">
        <span class="form-label">验证方式</span>
        <KimaSelect v-model="channel" label="验证方式" :items="channels" :disabled="busy" />
      </label>
      <label class="field-label min-w-0">
        <span class="form-label">{{ channel==='email'?'验证邮箱':'已验证手机号' }}</span>
        <KimaTextField
          v-model="destination"
          :label="channel==='email'?'验证邮箱':'已验证手机号'"
          :type="channel==='email'?'email':'tel'"
          :maxlength="channel==='email'?254:16"
          :placeholder="channel==='email'?'name@example.com':'+8613800000000'"
          :hint="channel==='sms'?(purpose==='register'?'填写可接收短信的手机号，包含+和国家区号。':'只能使用已验证绑定的手机号，包含+和国家区号。'):'填写你能接收验证码的邮箱。'"
          :disabled="busy"
        />
      </label>
      <KimaButton variant="tonal" :loading="busy" :disabled="cooldown>0 || !destination.trim()" @click="send">
        {{ cooldown?`${cooldown}秒后可重发`:'发送验证码' }}
      </KimaButton>
    </template>
    <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
  </div>
</template>
