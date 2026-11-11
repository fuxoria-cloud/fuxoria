<!-- 验证注册：手机主账号不伪造邮箱，地址证明与账号创建在单一事务消费。调用：/verify-register。 -->
<script setup lang="ts">
useSeoMeta({ title: '验证注册', robots: 'noindex, nofollow' });
const account = useAccount(), router = useRouter(), route = useRoute(), referralCookie = useCookie<string | null>('yunzou_referral');
const challenge = ref<{
    id: string;
    destination: string;
} | null>(null), name = ref(''), password = ref(''), confirmation = ref(''), code = ref(''), busy = ref(false), failure = ref('');
async function submit() {
    failure.value = '';
    if (password.value !== confirmation.value) {
        failure.value = '两次填写的密码不同，请核对。';
        return;
    }
    busy.value = true;
    try {
        const referral = typeof route.query.ref === 'string' ? route.query.ref : referralCookie.value;
        await account.verified('verify-register', { id: challenge.value?.id, code: code.value.trim(), name: name.value.trim(), password: password.value, ...(referral ? { referralCode: referral } : {}) });
        referralCookie.value = null;
        await router.push('/console');
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
  <div class="page-width py-12">
    <section class="panel p-6 sm:p-9 max-w-xl mx-auto">
      <AppLink to="/register" :underline="false" class="auth-back mb-6">普通邮箱注册</AppLink>
      <h1 class="text-3xl font-semibold">验证后，开启云上空间</h1>
      <p class="muted mt-3 mb-7">使用自己的手机或邮箱，验证后创建独立主账号。</p>
      <AccessChallenge purpose="register" @issued="value=>{challenge=value;code=''}" />
      <form v-if="challenge" class="grid grid-cols-1 gap-5 mt-6" @submit.prevent="submit">
        <label class="field-label min-w-0">
          <span class="form-label">注册验证码</span>
          <KimaTextField
            v-model="code"
            label="注册验证码"
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
          <span class="form-label">怎么称呼你</span>
          <KimaTextField v-model="name" label="怎么称呼你" autocomplete="name" maxlength="60" required :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">登录密码</span>
          <KimaTextField
            v-model="password"
            label="登录密码"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="128"
            required
            :disabled="busy"
          />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">再次填写密码</span>
          <KimaTextField
            v-model="confirmation"
            label="再次填写密码"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="128"
            required
            :disabled="busy"
          />
        </label>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
        <KimaButton type="submit" :loading="busy">验证并注册</KimaButton>
      </form>
      <p class="muted mt-6 text-sm">
        已经有账号？
        <AppLink to="/verify-login">手机号登录</AppLink>
        或
        <AppLink to="/login">邮箱登录</AppLink>
        。
      </p>
    </section>
  </div>
</template>
