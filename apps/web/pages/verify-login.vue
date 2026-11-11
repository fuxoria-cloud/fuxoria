<!-- 手机登录：密码与短信验证码两种方式都保留本地MFA。调用：/verify-login。 -->
<script setup lang="ts">
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
useSeoMeta({ title: '手机登录', robots: 'noindex, nofollow' });
const account = useAccount(), api = useApi(), route = useRoute(), router = useRouter();
const { data: options } = await useAsyncData('access-options', () => api<{
    smsEnabled: boolean;
    emailEnabled: boolean;
    phonePasswordEnabled: boolean;
}>('/auth/access-options'), { server: false });
const mode = ref('password'), phone = ref(''), password = ref(''), code = ref(''), challenge = ref<{
    id: string;
    destination: string;
} | null>(null), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false), busy = ref(false), failure = ref('');
const modes = computed(() => [{ value: 'password', label: '手机号与密码' }, ...(options.value?.smsEnabled ? [{ value: 'code', label: '短信验证码' }] : [])]);
async function submit() {
    busy.value = true;
    failure.value = '';
    try {
        await account.verified(mode.value === 'password' ? 'phone-login' : 'verify-login', mode.value === 'password' ? { phone: phone.value.trim(), password: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } : { id: challenge.value?.id, code: code.value.trim(), ...(factorOpen.value ? factorProof(proof.value) : {}) });
        const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') && !route.query.next.startsWith('//') && !route.query.next.includes('\\') ? route.query.next : '/console';
        await router.push(next);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
        if (/双因素|恢复码/.test(failure.value))
            factorOpen.value = true;
    }
    finally {
        busy.value = false;
    }
}
</script>
<template>
  <div class="page-width py-12">
    <section class="panel p-6 sm:p-9 max-w-xl mx-auto">
      <AppLink to="/login" :underline="false" class="auth-back mb-6">邮箱密码登录</AppLink>
      <h1 class="text-3xl font-semibold">用手机号登录</h1>
      <p class="muted mt-3 mb-7">使用已验证绑定的手机号。已开启双因素认证时，安全验证继续生效。</p>
      <label class="field-label min-w-0">
        <span class="form-label">登录方式</span>
        <KimaSelect v-model="mode" label="登录方式" :items="modes" :disabled="busy" class="mb-5" />
      </label>
      <AccessChallenge v-if="mode==='code'" purpose="login" @issued="value=>{challenge=value;code=''}" />
      <form class="grid grid-cols-1 gap-5 mt-5" @submit.prevent="submit">
        <template v-if="mode==='password'">
          <label class="field-label min-w-0">
            <span class="form-label">已验证手机号</span>
            <KimaTextField
              v-model="phone"
              label="已验证手机号"
              type="tel"
              maxlength="16"
              placeholder="+8613800000000"
              autocomplete="username"
              required
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">登录密码</span>
            <KimaTextField
              v-model="password"
              label="登录密码"
              type="password"
              autocomplete="current-password"
              maxlength="128"
              required
              :disabled="busy"
            />
          </label>
        </template>
        <template v-else-if="challenge">
          <KimaAlert>验证码已发送到 {{ challenge.destination }}。</KimaAlert>
          <label class="field-label min-w-0">
            <span class="form-label">短信验证码</span>
            <KimaTextField
              v-model="code"
              label="短信验证码"
              inputmode="numeric"
              pattern="[0-9]{6}"
              minlength="6"
              maxlength="6"
              autocomplete="one-time-code"
              required
              :disabled="busy"
            />
          </label>
        </template>
        <KimaCollapsible v-model:open="factorOpen" label="已启用双因素认证？填写安全验证">
          <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
        </KimaCollapsible>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
        <KimaButton type="submit" :loading="busy" :disabled="mode==='code' && !challenge">登录</KimaButton>
      </form>
      <div class="flex flex-wrap justify-between gap-4 mt-6">
        <AppLink to="/recover">忘记密码</AppLink>
        <AppLink to="/verify-register">验证注册</AppLink>
      </div>
    </section>
  </div>
</template>
