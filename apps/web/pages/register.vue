<!-- 注册：创建邮箱账户后进入工作台。调用：访问 /register。 -->
<script setup lang="ts">
import { ArrowLeft01Icon, SparklesIcon } from '@hugeicons/core-free-icons'; // 注册与首页保留同一品牌语气
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
useSeoMeta({ title: '创建账户', robots: 'noindex, nofollow' }); // 个人账户入口不收录
definePageMeta({ layout: false }); // 表单使用独立登录布局
const account = useAccount(); // 注册后重新读取服务端会话
const referral = useCookie<string | null>('yunzou_referral'); // 首次推荐归因由服务端核验，不承担认证功能
const name = ref('');
const email = ref('');
const password = ref(''); // 只收集创建账户所需字段
const busy = ref(false);
const message = ref(''); // 本次注册的提交反馈
/** 创建账户并读取服务端设置的登录状态。 */
async function submit() {
  // 表单入口处理外部输入
  busy.value = true;
  message.value = ''; // 阻止重复点击造成多次提交
  try {
    // 账户错误在表单旁解释
    await account.register({ name: name.value.trim(), email: email.value.trim(), password: password.value, ...(referral.value ? { referralCode: referral.value } : {}) }); // 同一会话主体处理注册与并发旧身份回包
    referral.value = null; // 注册确认后不再给其他人沿用当前归因
    await router.push('/console'); // 新账户从自己的工作台开始
  } catch (error) {
    message.value = apiMessage(error);
  } finally {
    // 不覆盖用户已填好的字段
    busy.value = false;
  } // 可以修正错误后再次提交
}
</script>
<template>
  <div class="auth-shell">
    <aside class="auth-story">
      <Brand />
      <div class="auth-story-content">
        <img class="auth-mascot" src="/brand/fuxoria-mascot.png" alt="" width="320" height="320" />
        <h2>
          从一个想法，
          <br />
          开始新的旅程。
        </h2>
        <p>先给自己一个小小的空间。之后的产品、服务和账单，都可以在这里慢慢安排。</p>
      </div>
      <p class="auth-story-foot">狐岚云 · 把精力留给创造</p>
    </aside>
    <main class="auth-form">
      <div class="theme-bar">
        <span class="muted text-sm">你的云上空间</span>
        <ThemeSwitch />
      </div>
      <div class="mobile-brand"><Brand /></div>
      <AppLink :underline="false" to="/" class="auth-back">
        <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
        返回首页
      </AppLink>
      <h1>认识一下吧。</h1>
      <p>创建账户，开启你的云上空间。</p>
      <p v-if="referral" class="muted text-sm">本次注册通过推荐链接进入。<button type="button" class="min-h-11 px-2 underline" @click="referral = null">清除推荐归因</button></p>
      <form @submit.prevent="submit">
        <div class="form-field">
          <label class="field-label">
            <span class="form-label">怎么称呼你</span>
            <KimaTextField
              label="怎么称呼你"
              v-model="name"
              autocomplete="nickname"
              placeholder="你的名字"
              maxlength="60"
              required
              :disabled="busy"
            />
          </label>
        </div>
        <div class="form-field">
          <label class="field-label">
            <span class="form-label">邮箱</span>
            <KimaTextField
              label="邮箱"
              v-model="email"
              type="email"
              inputmode="email"
              autocomplete="username"
              placeholder="you@example.com"
              required
              :disabled="busy"
            />
          </label>
        </div>
        <div class="form-field">
          <label class="field-label">
            <span class="form-label">设置密码</span>
            <KimaTextField
              label="设置密码"
              v-model="password"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              required
              :disabled="busy"
              aria-describedby="password-hint"
            />
          </label>
          <p id="password-hint" class="form-hint">至少 12 个字符，可以使用密码管理器生成。</p>
        </div>
        <p v-if="message" class="inline-error" role="alert">{{ message }}</p>
        <KimaButton variant="filled" class="button button-primary" :disabled="busy" type="submit">
          {{ busy ? '正在创建…' : '创建账户' }}
        </KimaButton>
      </form>
      <div class="mt-6"><AppLink to="/verify-register">使用邮箱或手机验证码注册</AppLink></div>
      <div class="auth-bottom">
        已经有账户？
        <AppLink :underline="false" to="/login">去登录</AppLink>
      </div>
    </main>
  </div>
</template>
