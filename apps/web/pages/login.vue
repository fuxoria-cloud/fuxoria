<!-- 登录：原生表单支持密码管理器与粘贴。调用：访问 /login?next=/console。 -->
<script setup lang="ts">
import { ArrowLeft01Icon, CloudIcon } from '@hugeicons/core-free-icons'; // 登录页沿用品牌图形
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
useSeoMeta({ title: '登录', robots: 'noindex, nofollow' }); // 账户入口不参与搜索索引
definePageMeta({ layout: false }); // 登录使用独立窄表单
const account = useAccount(); // 会话操作集中在账户主体
const route = useRoute(); // 登录完成回到用户原本要去的页面
const email = ref('');
const password = ref(''); // 密码不写入浏览器持久化存储
const factorVisible = ref(false); // 密码通过但需要第二因素时展开安全输入
const proof = ref({ mode: 'totp' as 'totp' | 'recovery', code: '' }); // 不把验证码或恢复码写入持久化存储
const busy = ref(false);
const message = ref(''); // 按钮状态和错误只属于本次提交
const api = useApi();
const { data: providers } = await useAsyncData('oauth-providers', () => api<{ id: string; name: string }[]>('/oauth/providers'), { server: false });
const oauthMessage = computed(() => route.query.oauth === 'unbound' ? '这个第三方身份还没有绑定狐岚云账号。请先登录或创建账户，再到身份与认证中绑定。' : route.query.oauth === 'failed' ? '第三方登录没有完成，请重新选择通道，或使用密码登录。' : '');
async function thirdParty(id: string) {
  busy.value = true; message.value = '';
  try { const result = await api<{ url: string }>(`/oauth/${id}/start`, { method: 'POST', body: { next: typeof route.query.next === 'string' ? route.query.next : '/console' } }); window.location.assign(result.url); }
  catch (error) { message.value = apiMessage(error); busy.value = false; }
}
/** 登录并返回同站页面，拒绝协议相对地址和站外跳转。 */
async function submit() {
  // 表单提交是外部输入边界
  busy.value = true;
  message.value = ''; // 提交期间防止重复发送
  try {
    // 只在界面入口接住登录错误
    await account.login(
      email.value,
      password.value,
      factorVisible.value ? factorProof(proof.value) : {},
    ); // 服务端验证邮箱和密码
    const next = typeof route.query.next === 'string' ? route.query.next : '/console'; // 无来源时进入总览
    await router.push(
      next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/console',
    ); // 只接受站内路径
  } catch (error) {
    message.value = apiMessage(error);
    if (
      message.value.includes('双因素') ||
      message.value.includes('验证码') ||
      message.value.includes('恢复码')
    )
      factorVisible.value = true;
  } finally {
    // 错误与表单放在一起
    busy.value = false;
  } // 请求完成恢复表单
}
</script>
<template>
  <div class="auth-shell">
    <aside class="auth-story">
      <Brand />
      <div class="auth-story-content">
        <img class="auth-mascot" src="/brand/fuxoria-mascot.png" alt="" width="320" height="320" />
        <h2>
          你的创造，
          <br />
          有一片安心的云。
        </h2>
        <p>看看服务是否一切顺利，处理一张账单，或聊聊遇到的问题。日常的事，慢慢安排好。</p>
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
      <h1>欢迎回来。</h1>
      <p>登录狐岚云，继续照顾你的云上日常。</p>
      <KimaAlert v-if="oauthMessage" variant="info" class="mt-5">{{ oauthMessage }}</KimaAlert>
      <div v-if="providers?.length" class="grid gap-3 mt-6"><KimaButton v-for="provider in providers" :key="provider.id" variant="tonal" :disabled="busy" @click="thirdParty(provider.id)">使用{{ provider.name }}登录</KimaButton></div>
      <form @submit.prevent="submit">
        <div class="form-field">
          <label class="field-label">
            <span class="form-label">邮箱</span>
            <KimaTextField
              label="邮箱"
              v-model="email"
              type="email"
              autocomplete="username"
              inputmode="email"
              placeholder="you@example.com"
              required
              :disabled="busy"
            />
          </label>
        </div>
        <div class="form-field">
          <label class="field-label">
            <span class="form-label">密码</span>
            <KimaTextField
              label="密码"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </label>
        </div>
        <KimaCollapsible v-model:open="factorVisible" label="使用双因素验证码或恢复码" class="mt-6">
          <SecondFactor
            v-model="proof"
            :required="factorVisible"
            :disabled="busy || !factorVisible"
          />
        </KimaCollapsible>
        <p v-if="message" class="inline-error" role="alert">{{ message }}</p>
        <KimaButton variant="filled" class="button button-primary" :disabled="busy" type="submit">
          {{ busy ? '正在登录…' : '登录' }}
        </KimaButton>
      </form>
      <div class="grid grid-cols-1 gap-3 mt-6">
        <AppLink to="/verify-login">使用手机或验证码登录</AppLink>
        <AppLink to="/recover">忘记密码？验证身份后找回</AppLink>
        <AppLink to="/verify-register">通过邮箱或手机验证码注册</AppLink>
      </div>
      <div class="auth-bottom">
        第一次来？
        <AppLink :underline="false" to="/register">创建账户</AppLink>
      </div>
    </main>
  </div>
</template>
