<!-- 验证与换绑：发送渠道由实际配置决定，确认时核对验证码、本人密码和第二因素。调用：/console/verification。 -->
<script setup lang="ts">
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '邮箱与手机验证', robots: 'noindex, nofollow' });
interface VerificationState {
    email: string | null;
    phone: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    emailEnabled: boolean;
    smsEnabled: boolean;
}
const api = useApi(), account = useAccount();
const { data, pending, error, refresh } = await useAsyncData('account-verification', () => api<VerificationState>('/auth/verification'));
const channel = ref<'email' | 'sms'>('email'), destination = ref(data.value?.email ?? ''), challenge = ref<{
    id: string;
    expiresAt: string;
} | null>(null), code = ref(''), password = ref(''), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false), busy = ref(false), failure = ref(''), success = ref(''), cooldown = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
const enabled = computed(() => channel.value === 'email' ? data.value?.emailEnabled : data.value?.smsEnabled);
watch(channel, value => { destination.value = (value === 'email' ? data.value?.email : data.value?.phone) ?? ''; challenge.value = null; code.value = ''; password.value = ''; proof.value.code = ''; failure.value = ''; success.value = ''; });
async function send() {
    busy.value = true;
    failure.value = '';
    success.value = '';
    try {
        const result = await api<{
            id: string;
            expiresAt: string;
            retryAfterSeconds: number;
        }>('/auth/verification/challenges', { method: 'POST', body: { channel: channel.value, destination: destination.value.trim() } });
        challenge.value = result;
        code.value = '';
        cooldown.value = result.retryAfterSeconds;
        clearInterval(timer);
        timer = setInterval(() => {
            cooldown.value = Math.max(0, cooldown.value - 1);
            if (!cooldown.value)
                clearInterval(timer);
        }, 1000);
        success.value = channel.value === 'email' ? '验证码已发送，请查看目标邮箱。' : '验证码已发送，请查看目标手机。';
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function confirm() {
    if (!challenge.value)
        return;
    busy.value = true;
    failure.value = '';
    success.value = '';
    try {
        await api('/auth/verification/confirm', { method: 'POST', body: { id: challenge.value.id, code: code.value.trim(), password: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } });
        challenge.value = null;
        code.value = '';
        password.value = '';
        proof.value.code = '';
        clearNuxtData('account-settings');
        await Promise.all([account.load(), refresh()]);
        success.value = '验证资料已保存，当前登录已更新，其它旧会话已失效。';
    }
    catch (reason) {
        failure.value = apiMessage(reason);
        if (/双因素|验证码和恢复码|双重验证/.test(failure.value))
            factorOpen.value = true;
    }
    finally {
        busy.value = false;
    }
}
onBeforeUnmount(() => { clearInterval(timer); password.value = ''; proof.value.code = ''; }); // 密码与验证码只留在本次表单
</script>
<template>
  <div>
    <AppLink to="/console/settings" :underline="false" class="auth-back mb-6">返回账户与安全</AppLink>
    <header class="page-heading">
      <div>
        <h1>邮箱与手机验证</h1>
        <p>验证你能收到消息的地址，也可以在这里更换绑定资料。</p>
      </div>
    </header>
    <RequestState :pending="pending && !data" :error="error" @retry="refresh" />
    <template v-if="data && !error">
      <div class="grid grid-cols-1 gap-5 md:grid-cols-2 mb-7">
        <section class="panel p-6">
          <div class="flex flex-wrap justify-between items-center gap-3">
            <h2 class="font-semibold text-lg">登录邮箱</h2>
            <KimaChip>{{ data.emailVerified?'已验证':'尚未验证' }}</KimaChip>
          </div>
          <p class="break-all mt-4">{{ data.email || '尚未绑定邮箱' }}</p>
        </section>
        <section class="panel p-6">
          <div class="flex flex-wrap justify-between items-center gap-3">
            <h2 class="font-semibold text-lg">联系手机</h2>
            <KimaChip>{{ data.phoneVerified?'已验证':'尚未验证' }}</KimaChip>
          </div>
          <p class="break-all mt-4">{{ data.phone || '还没有填写' }}</p>
        </section>
      </div>
      <section class="panel p-5 sm:p-7">
        <div class="grid grid-cols-1 gap-5">
          <label class="field-label min-w-0">
            <span class="form-label">希望验证哪项资料</span>
            <KimaSelect
              v-model="channel"
              label="希望验证哪项资料"
              :items="[{value:'email',label:'登录邮箱'},{value:'sms',label:'联系手机'}]"
              :disabled="busy"
            />
          </label>
          <KimaAlert v-if="!enabled">{{ channel==='email'?'邮箱验证渠道尚未启用，请联系支持团队。':'手机验证渠道尚未启用，请联系支持团队。' }}</KimaAlert>
          <template v-else>
            <label class="field-label min-w-0">
              <span class="form-label">{{ channel==='email'?'目标邮箱':'目标手机号' }}</span>
              <KimaTextField
                v-model="destination"
                :label="channel==='email'?'目标邮箱':'目标手机号'"
                :type="channel==='email'?'email':'tel'"
                :maxlength="channel==='email'?254:16"
                :placeholder="channel==='email'?'name@example.com':'+8613800000000'"
                :hint="channel==='sms'?'请包含+和国家区号，不填写空格。':'填写当前邮箱可验证原地址，填写新邮箱可申请更换。'"
                :disabled="busy || !!challenge"
              />
            </label>
            <div>
              <KimaButton
                variant="tonal"
                :disabled="busy || cooldown>0 || !destination.trim()"
                :loading="busy && !challenge"
                @click="send"
              >
                {{ cooldown?`${cooldown}秒后可重新发送`:challenge?'重新发送验证码':'发送验证码' }}
              </KimaButton>
              <KimaButton v-if="challenge" variant="text" :disabled="busy" @click="challenge=null;code=''">修改接收地址</KimaButton>
            </div>
          </template>
          <form v-if="challenge" class="grid grid-cols-1 gap-5" @submit.prevent="confirm">
            <KimaAlert>验证码10分钟内有效，只能使用一次。确认时需要当前登录密码；已开启双因素认证的账户还需要安全验证。</KimaAlert>
            <label class="field-label min-w-0">
              <span class="form-label">6位验证码</span>
              <KimaTextField
                v-model="code"
                label="6位验证码"
                inputmode="numeric"
                pattern="[0-9]{6}"
                minlength="6"
                maxlength="6"
                autocomplete="one-time-code"
                required
                :disabled="busy"
              />
            </label>
            <label class="field-label min-w-0">
              <span class="form-label">当前登录密码</span>
              <KimaTextField
                v-model="password"
                label="当前登录密码"
                type="password"
                autocomplete="current-password"
                maxlength="128"
                required
                :disabled="busy"
              />
            </label>
            <KimaCollapsible v-model:open="factorOpen" label="已启用双因素认证？填写安全验证">
              <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
            </KimaCollapsible>
            <div>
              <KimaButton type="submit" :loading="busy">验证并保存</KimaButton>
            </div>
          </form>
          <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
          <KimaAlert v-if="success" aria-live="polite">{{ success }}</KimaAlert>
        </div>
      </section>
    </template>
  </div>
</template>
