<!-- 账户设置：修改资料、密码、认证器与会话；密钥和恢复码只留在当前页面。
调用：登录后访问 /console/settings；所有操作由后端重新核对密码与第二因素。
-->
<script setup lang="ts">
import {
  UserSettings01Icon,
  SecurityCheckIcon,
  Key01Icon,
  Logout03Icon,
  Copy01Icon,
  Download01Icon,
} from '@hugeicons/core-free-icons'; // 与KIMA共用图标
import { factorProof, type FactorInput } from '~/features/factor'; // 身份验证方式只定义一次
import '~/assets/css/settings.css'; // 设置页只定义自己的业务布局
definePageMeta({ layout: 'console', middleware: 'account' }); // 后端仍会独立验证账号权限
useSeoMeta({ title: '账户与安全', robots: 'noindex, nofollow' }); // 私有资料不参与索引
interface Profile {
  id: string;
  email: string;
  name: string;
  role: string;
  phone: string;
  phoneCode: string;
  company: string;
  country: string;
  address: string;
  language: string;
  timezone: string;
}
interface SecurityState {
  enabled: boolean;
  setupPending: boolean;
  recoveryCodesRemaining: number;
  totpAvailable: boolean;
}
interface PendingSetup {
  secret: string;
  otpauthUrl: string;
  expiresAt: string;
}
const api = useApi(); // 请求携带HttpOnly会话
const { data: countries } = await useAsyncData('account-countries', () =>
  api<{ code: string; name: string; phoneCode: string }[]>('/country'),
); // 用原项目公开地区资料替代手填技术代码
const regions = computed(() => [
  { value: '', label: '暂不填写' },
  ...(countries.value ?? []).map((item) => ({ value: item.code, label: item.name })),
]); // 表单显示完整名称，服务端仍保存统一代码
const account = useAccount(); // 名称修改后同步外壳资料
const { data, pending, error, refresh } = await useAsyncData('account-settings', async () => {
  const [profile, security] = await Promise.all([
    api<Profile>('/auth/profile'),
    api<SecurityState>('/auth/security'),
  ]); // 一次读取资料与安全事实
  return { profile, security }; // 不向浏览器缓存明文凭据
});
const profile = reactive({
  name: '',
  phone: '',
  phoneCode: '',
  company: '',
  country: '',
  address: '',
  language: 'zh-cn',
  timezone: 'Asia/Shanghai',
}); // 表单只保存可编辑资料
watch(
  () => data.value?.profile,
  (value) => {
    if (value)
      Object.assign(profile, {
        name: value.name,
        phone: value.phone,
        phoneCode: value.phoneCode,
        company: value.company,
        country: value.country,
        address: value.address,
        language: value.language,
        timezone: value.timezone,
      });
  },
  { immediate: true },
); // API刷新后以最终资料为准
const busy = ref(''),
  message = ref(''),
  success = ref(''); // 错误紧贴当前设置，保留用户输入
const currentPassword = ref(''),
  newPassword = ref(''),
  confirmPassword = ref(''); // 口令不写入本地存储
const passwordProof = ref<FactorInput>({ mode: 'totp', code: '' }); // 改密只提交一种第二因素
const credential = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' }); // 安全动作需要重新证明身份
const setup = ref<PendingSetup | null>(null),
  code = ref(''); // 临时密钥离开页面后丢弃
const recoveryCodes = ref<string[]>([]),
  recoveryOpen = ref(false); // 恢复码只能从启用或重置成功响应读取
const languages = [
  { value: 'zh-cn', label: '简体中文' },
  { value: 'en-us', label: 'English' },
]; // 保存账号偏好，不伪造界面已全量翻译

// --- 保存个人资料 ---
async function saveProfile() {
  busy.value = 'profile';
  message.value = '';
  success.value = ''; // 防止并发提交相互覆盖
  try {
    await api<Profile>('/auth/profile', { method: 'PUT', body: profile }); // 可编辑字段由后端白名单约束
    await account.load();
    await refresh(); // 外壳同步新的显示名称
    success.value = '资料已保存。'; // 只在服务端成功后显示结果
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 失败保留当前输入
    busy.value = '';
  } // 用户可以修正后重试
}

// --- 更新密码并撤销旧会话 ---
async function changePassword() {
  message.value = '';
  success.value = ''; // 当前操作取代旧反馈
  if (newPassword.value !== confirmPassword.value) {
    message.value = '两次输入的新密码不一致。';
    return;
  } // 在表单边界立即提示
  busy.value = 'password'; // 提交中不再发第二次修改
  try {
    await api('/auth/password', {
      method: 'POST',
      body: {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        ...factorProof(passwordProof.value),
      },
    }); // 后端重新核验并撤销旧版本会话
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    passwordProof.value.code = ''; // 成功后清除敏感输入
    success.value = '密码已更新，其它登录会话已失效。'; // 当前会话由后端重新签发
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 保留可修正的错误原因
    busy.value = '';
  } // 操作结束恢复控件
}

// --- 设置认证器 ---
async function beginSetup() {
  busy.value = 'setup';
  message.value = '';
  success.value = ''; // 密钥只通过这次有密码证明的请求生成
  try {
    setup.value = await api<PendingSetup>('/auth/mfa/setup', {
      method: 'POST',
      body: { password: credential.value },
    }); // 不向任何第三方二维码服务发送密钥
    credential.value = '';
    await refresh(); // 密码用完即清除
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 未配置或校验失败时不展示假密钥
    busy.value = '';
  } // 用户可以继续输入认证器验证码
}

async function confirmSetup() {
  busy.value = 'confirm';
  message.value = '';
  success.value = ''; // 确认前仍然没有开启MFA
  try {
    const result = await api<{ enabled: boolean; recoveryCodes: string[] }>('/auth/mfa/confirm', {
      method: 'POST',
      body: { code: code.value.trim() },
    }); // 真实验证码由服务端消费
    recoveryCodes.value = result.recoveryCodes;
    recoveryOpen.value = true;
    setup.value = null;
    code.value = ''; // 恢复码只显示此次响应
    await refresh();
    success.value = '双重验证已开启，请保存一次性恢复码。'; // 账号状态以服务器为准
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 错误不丢失待确认密钥
    busy.value = '';
  } // 可在验证码更新后重试
}

async function securityAction(action: 'cancel' | 'disable' | 'recovery' | 'sessions') {
  busy.value = action;
  message.value = '';
  success.value = ''; // 一次只执行一种凭据变更
  try {
    const path = action === 'sessions' ? '/auth/sessions/revoke' : `/auth/mfa/${action}`; // 只有这四个明确安全操作
    const body =
      action === 'cancel'
        ? { password: credential.value }
        : { password: credential.value, ...factorProof(proof.value) }; // 取消待设置只需密码，其余按需第二因素
    const result = await api<{ recoveryCodes?: string[] }>(path, { method: 'POST', body }); // 不接受任意路径或动作字符串
    credential.value = '';
    proof.value.code = ''; // 成功后不继续保留认证材料
    if (action === 'cancel') setup.value = null; // 被取消密钥不能再确认
    if (result.recoveryCodes) {
      recoveryCodes.value = result.recoveryCodes;
      recoveryOpen.value = true;
    } // 新恢复码只显示一次
    await refresh(); // 反映实际启用状态与恢复码数量
    success.value =
      action === 'disable'
        ? '双重验证已关闭，其它登录会话已失效。'
        : action === 'recovery'
          ? '恢复码已更换，旧的未用恢复码已作废。'
          : action === 'sessions'
            ? '其它登录会话已退出。'
            : '待确认设置已取消。'; // 告知这个动作的具体影响
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 不把未知结果当成功
    busy.value = '';
  } // 恢复界面操作
}

// --- 由用户主动保存恢复码 ---
async function copyCodes() {
  try {
    await navigator.clipboard.writeText(recoveryCodes.value.join('\n'));
    success.value = '恢复码已复制，请保存在安全的位置。';
  } catch {
    // 只响应用户点击，秘密不发往网络
    message.value = '浏览器不允许复制，请手动选取或下载恢复码。';
  } // 保留可行的保存方式
}
function downloadCodes() {
  const file = new Blob(
    [`狐岚云一次性恢复码\n每条只能使用一次，请单独安全保管。\n\n${recoveryCodes.value.join('\n')}\n`],
    { type: 'text/plain;charset=utf-8' },
  ); // 文件只在当前浏览器生成
  const url = URL.createObjectURL(file),
    link = document.createElement('a'); // 不建立远程下载地址
  link.href = url;
  link.download = '狐岚云-一次性恢复码.txt';
  link.click(); // 用户明确点击下载后才保存
  setTimeout(() => URL.revokeObjectURL(url), 1000); // 下载启动后释放临时资源
}
</script>

<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>账户与安全</h1>
        <p>把资料照顾好，也给账号多一层保护。</p>
      </div>
    </header>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <KimaAlert v-if="message" class="settings-feedback" variant="danger" heading="请核对后重试">
      {{ message }}
    </KimaAlert>
    <KimaAlert v-if="success" class="settings-feedback" variant="success" heading="操作已保存">
      {{ success }}
    </KimaAlert>
    <div v-if="!pending && !error && data" class="settings-grid">
      <section class="panel settings-profile">
        <header class="panel-header">
          <h2>
            <KimaIcon :icon="UserSettings01Icon" :size="24" />
            个人资料
          </h2>
        </header>
        <form class="content-padding" @submit.prevent="saveProfile">
          <div class="settings-fields">
            <label>
              <span class="form-label">显示名称</span>
              <KimaTextField
                v-model="profile.name"
                label="显示名称"
                autocomplete="name"
                required
                maxlength="60"
                :disabled="!!busy"
              />
            </label>
            <label>
              <span class="form-label">登录邮箱</span>
              <KimaTextField
                :model-value="data.profile.email || '尚未绑定邮箱'"
                label="登录邮箱"
                readonly
                hint="此处显示当前登录邮箱。"
              />
            </label>
            <label>
              <span class="form-label">电话区号</span>
              <KimaTextField
                v-model="profile.phoneCode"
                label="电话区号"
                placeholder="例如 86"
                inputmode="tel"
                maxlength="10"
                :disabled="!!busy"
              />
            </label>
            <label>
              <span class="form-label">联系电话</span>
              <KimaTextField
                v-model="profile.phone"
                label="联系电话"
                autocomplete="tel-national"
                inputmode="tel"
                maxlength="30"
                :disabled="!!busy"
              />
            </label>
            <label>
              <span class="form-label">公司或组织</span>
              <KimaTextField
                v-model="profile.company"
                label="公司或组织"
                autocomplete="organization"
                maxlength="120"
                :disabled="!!busy"
              />
            </label>
            <div>
              <span class="form-label">国家或地区</span>
              <KimaSelect
                v-model="profile.country"
                label="国家或地区"
                :items="regions"
                :disabled="!!busy"
              />
            </div>
            <div>
              <span class="form-label">偏好语言</span>
              <KimaSelect
                v-model="profile.language"
                label="偏好语言"
                :items="languages"
                :disabled="!!busy"
              />
            </div>
            <label>
              <span class="form-label">时区</span>
              <KimaTextField
                v-model="profile.timezone"
                label="时区"
                placeholder="Asia/Shanghai"
                required
                maxlength="64"
                :disabled="!!busy"
              />
            </label>
            <label class="settings-wide">
              <span class="form-label">联系地址</span>
              <KimaTextarea
                v-model="profile.address"
                label="联系地址"
                autocomplete="street-address"
                :rows="3"
                :maxlength="500"
                :disabled="!!busy"
              />
            </label>
          </div>
          <div class="form-actions">
            <KimaButton type="submit" :loading="busy === 'profile'" :disabled="!!busy">
              保存资料
            </KimaButton>
          </div>
        </form>
      </section>

      <section class="panel">
        <header class="panel-header">
          <h2>
            <KimaIcon :icon="Key01Icon" :size="24" />
            修改密码
          </h2>
        </header>
        <form class="content-padding" @submit.prevent="changePassword">
          <label>
            <span class="form-label">当前密码</span>
            <KimaTextField
              v-model="currentPassword"
              label="当前密码"
              type="password"
              autocomplete="current-password"
              required
              :disabled="!!busy"
            />
          </label>
          <label class="form-field">
            <span class="form-label">新密码</span>
            <KimaTextField
              v-model="newPassword"
              label="新密码"
              type="password"
              autocomplete="new-password"
              required
              minlength="12"
              maxlength="128"
              hint="至少12位，可以使用密码管理器生成。"
              :disabled="!!busy"
            />
          </label>
          <label class="form-field">
            <span class="form-label">再次输入新密码</span>
            <KimaTextField
              v-model="confirmPassword"
              label="再次输入新密码"
              type="password"
              autocomplete="new-password"
              required
              minlength="12"
              maxlength="128"
              :disabled="!!busy"
            />
          </label>
          <SecondFactor
            v-if="data.security.enabled"
            v-model="passwordProof"
            class="form-field"
            required
            :disabled="!!busy"
          />
          <div class="form-actions">
            <KimaButton type="submit" :loading="busy === 'password'" :disabled="!!busy">
              更新密码
            </KimaButton>
          </div>
        </form>
      </section>

      <section class="panel">
        <header class="panel-header">
          <h2>
            <KimaIcon :icon="SecurityCheckIcon" :size="24" />
            双重验证
          </h2>
          <span class="muted">{{ data.security.enabled ? '已开启' : '未开启' }}</span>
        </header>
        <div class="content-padding">
          <p v-if="data.security.enabled" class="muted">
            已开启。登录和重要安全操作需要身份验证器的验证码；设备不在身边时，可使用一次性恢复码。当前还有
            {{ data.security.recoveryCodesRemaining }} 条可用恢复码。
          </p>
          <p v-else class="muted">
            开启后，密码之外还需要一个验证码。请先在手机上准备兼容 TOTP 的身份验证器。
          </p>
          <p v-if="!data.security.totpAvailable" class="inline-error">
            服务商暂未开放认证器设置，请联系服务商。
          </p>
          <div v-if="setup" class="settings-enrollment">
            <KimaQrCode :value="setup.otpauthUrl" label="身份验证器导入二维码" :size="220" />
            <div>
              <p>用身份验证器扫描二维码，或手动填写密钥：</p>
              <code class="settings-secret">{{ setup.secret }}</code>
              <p class="form-hint">密钥只在这次设置中显示，请勿转发或公开截图。</p>
            </div>
            <form class="settings-wide" @submit.prevent="confirmSetup">
              <label>
                <span class="form-label">认证器当前的6位验证码</span>
                <KimaTextField
                  v-model="code"
                  label="认证器当前的6位验证码"
                  inputmode="numeric"
                  pattern="[0-9]{6}"
                  maxlength="6"
                  autocomplete="one-time-code"
                  required
                  :disabled="!!busy"
                />
              </label>
              <div class="form-actions">
                <KimaButton type="submit" :loading="busy === 'confirm'" :disabled="!!busy">
                  确认开启
                </KimaButton>
              </div>
            </form>
          </div>
          <form class="form-field" @submit.prevent="beginSetup">
            <label>
              <span class="form-label">验证当前密码</span>
              <KimaTextField
                v-model="credential"
                label="验证当前密码"
                type="password"
                autocomplete="current-password"
                required
                :disabled="!!busy"
              />
            </label>
            <SecondFactor
              v-if="data.security.enabled"
              v-model="proof"
              class="form-field"
              required
              :disabled="!!busy"
            />
            <div class="form-actions">
              <KimaButton
                v-if="!data.security.enabled && !data.security.setupPending"
                type="submit"
                :disabled="!!busy || !data.security.totpAvailable"
                :loading="busy === 'setup'"
              >
                设置身份验证器
              </KimaButton>
              <KimaButton
                v-if="data.security.setupPending"
                type="button"
                variant="tonal"
                :disabled="!!busy || !credential"
                @click="securityAction('cancel')"
              >
                取消待确认设置
              </KimaButton>
              <KimaButton
                v-if="data.security.enabled"
                type="button"
                variant="tonal"
                :disabled="!!busy || !credential"
                @click="securityAction('recovery')"
              >
                更换恢复码
              </KimaButton>
              <KimaButton
                v-if="data.security.enabled"
                type="button"
                variant="text"
                :disabled="!!busy || !credential"
                @click="securityAction('disable')"
              >
                关闭双重验证
              </KimaButton>
            </div>
          </form>
          <div class="settings-sessions">
            <h3>
              <KimaIcon :icon="Logout03Icon" :size="22" />
              退出其它设备
            </h3>
            <p class="form-hint">
              如果在共用设备上登录过，填写上方当前密码和需要的验证码后，可以一次退出其它登录会话。
            </p>
            <KimaButton
              variant="tonal"
              :disabled="!!busy || !credential"
              :loading="busy === 'sessions'"
              @click="securityAction('sessions')"
            >
              退出其它设备
            </KimaButton>
          </div>
        </div>
      </section>
    </div>
    <KimaDrawer
      v-model:open="recoveryOpen"
      title="保存一次性恢复码"
      description="这些恢复码只显示这一次。请单独保存，避免与密码放在同一处。"
      placement="right"
    >
      <div class="settings-recovery">
        <code v-for="value in recoveryCodes" :key="value">{{ value }}</code>
      </div>
      <div class="form-actions">
        <KimaButton variant="tonal" @click="copyCodes">
          <template #leading><KimaIcon :icon="Copy01Icon" :size="20" /></template>
          复制
        </KimaButton>
        <KimaButton variant="tonal" @click="downloadCodes">
          <template #leading><KimaIcon :icon="Download01Icon" :size="20" /></template>
          下载
        </KimaButton>
      </div>
      <template #footer>
        <KimaButton
          @click="
            recoveryOpen = false;
            recoveryCodes = [];
          "
        >
          我已安全保存
        </KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
