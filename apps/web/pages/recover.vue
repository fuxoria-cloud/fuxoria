<!-- 找回密码：新密码只在表单和Argon2id计算时存在，MFA不会被重置路径关闭。调用：/recover。 -->
<script setup lang="ts">
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
useSeoMeta({ title: '找回密码', robots: 'noindex, nofollow' });
const api = useApi(), account = useAccount();
const challenge = ref<{
    id: string;
    destination: string;
} | null>(null), code = ref(''), password = ref(''), confirmation = ref(''), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false), busy = ref(false), failure = ref(''), success = ref(false);
async function submit() {
    failure.value = '';
    if (password.value !== confirmation.value) {
        failure.value = '两次填写的新密码不同，请核对。';
        return;
    }
    busy.value = true;
    try {
        await api('/auth/recover', { method: 'POST', body: { id: challenge.value?.id, code: code.value.trim(), newPassword: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } });
        password.value = '';
        confirmation.value = '';
        code.value = '';
        proof.value.code = '';
        success.value = true;
        try {
            await account.load();
        }
        catch (reason) {
            if ((reason as {
                statusCode?: number;
            }).statusCode !== 401)
                throw reason;
        }
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
      <AppLink to="/login" :underline="false" class="auth-back mb-6">返回登录</AppLink>
      <h1 class="text-3xl font-semibold">找回密码</h1>
      <p class="muted mt-3 mb-7">证明你能收到绑定地址的验证码，再设置新的登录密码。</p>
      <template v-if="!success">
        <AccessChallenge purpose="reset" @issued="value=>{challenge=value;code=''}" />
        <form v-if="challenge" class="grid grid-cols-1 gap-5 mt-6" @submit.prevent="submit">
          <KimaAlert>重置后全部旧登录会话与API密钥失效。已开启的双因素认证会继续保留。</KimaAlert>
          <label class="field-label min-w-0">
            <span class="form-label">找回验证码</span>
            <KimaTextField
              v-model="code"
              label="找回验证码"
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
            <span class="form-label">新登录密码</span>
            <KimaTextField
              v-model="password"
              label="新登录密码"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              required
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">再次填写新密码</span>
            <KimaTextField
              v-model="confirmation"
              label="再次填写新密码"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              required
              :disabled="busy"
            />
          </label>
          <KimaCollapsible v-model:open="factorOpen" label="已启用双因素认证？填写安全验证">
            <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
          </KimaCollapsible>
          <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
          <KimaButton type="submit" :loading="busy">验证并重置密码</KimaButton>
        </form>
      </template>
      <KimaAlert v-else heading="密码已重置">
        请使用新密码重新登录，双因素认证继续生效。
        <template #action>
          <AppLink to="/login">前往登录</AppLink>
        </template>
      </KimaAlert>
    </section>
  </div>
</template>
