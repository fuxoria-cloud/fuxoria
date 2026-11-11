<!-- 开发者密钥：按接口授权、设置到期、一次显示和即时撤销。调用：登录主账号访问/console/developer。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '开发者密钥', robots: 'noindex, nofollow' });
interface Key {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}
const api = useApi();
const { data, error, pending, refresh } = await useAsyncData(
  'identity-api-keys',
  () => api<Key[]>('/api-keys'),
);
const { data: scopes } = await useAsyncData('identity-api-key-scopes', () =>
  api<{ key: string; subject: string }[]>('/api-keys/permissions'),
);
const name = ref(''),
  days = ref('90'),
  selected = ref<string[]>([]),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const busy = ref(false),
  opened = ref(false),
  revokeId = ref(''),
  message = ref(''),
  success = ref(''),
  token = ref('');
const terms = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
  { value: '365', label: '365天' },
];
function begin(id = '') {
  revokeId.value = id;
  opened.value = true;
  password.value = '';
  proof.value.code = '';
  message.value = '';
}
async function submit() {
  busy.value = true;
  message.value = '';
  success.value = '';
  try {
    const confirm = { password: password.value, ...factorProof(proof.value) };
    if (revokeId.value) {
      await api(`/api-keys/${revokeId.value}`, {
        method: 'DELETE',
        body: confirm,
      });
      success.value = '密钥已撤销，后续调用会被拒绝。';
    } else {
      const result = await api<Key & { token: string }>('/api-keys', {
        method: 'POST',
        body: {
          name: name.value,
          expiresDays: Number(days.value),
          permissions: selected.value,
          ...confirm,
        },
      });
      token.value = result.token;
      name.value = '';
      selected.value = [];
    }
    password.value = '';
    proof.value.code = '';
    opened.value = false;
    await refresh();
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(token.value);
    success.value = '密钥已复制，请保存到自己的秘密管理工具。';
  } catch {
    message.value = '无法自动复制，请选中上方密钥手动复制。';
  }
}
function status(item: Key) {
  return item.revokedAt
    ? '已撤销'
    : Date.parse(item.expiresAt) <= Date.now()
      ? '已到期'
      : '可用';
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">连接自己的工具</p>
        <h1>开发者密钥</h1>
        <p class="muted">为每项自动化单独创建密钥，按接口授权并设置有效期。</p>
      </div>
      <KimaButton @click="begin()">创建密钥</KimaButton>
    </div>
    <KimaAlert
      v-if="error"
      variant="danger"
      :description="apiMessage(error)"
    /><KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    />
    <section v-if="token" class="panel mb-6 identity-stack">
      <h2>请现在保存密钥</h2>
      <p>完整密钥只显示这一次。离开此页后，可以撤销并重新创建。</p>
      <code class="identity-secret">{{ token }}</code>
      <div class="identity-actions">
        <KimaButton @click="copy">复制密钥</KimaButton
        ><KimaButton variant="text" @click="token = ''"
          >已保存，隐藏密钥</KimaButton
        >
      </div>
    </section>
    <div class="identity-grid">
      <section class="panel">
        <div class="panel-header"><h2>已有密钥</h2></div>
        <KimaSkeleton v-if="pending" /><KimaEmptyState
          v-else-if="!data?.length && !error"
          heading="还没有密钥"
          description="只有需要自动化调用时才创建。"
        />
        <article v-for="item in data" :key="item.id" class="identity-record">
          <h3>{{ item.name }}</h3>
          <p>
            <code>{{ item.prefix }}…</code> · {{ status(item) }}
          </p>
          <p class="muted">
            {{ item.permissions.length }} 项授权 ·
            {{ date(item.expiresAt) }} 到期
          </p>
          <p class="muted">上次调用：{{ date(item.lastUsedAt) }}</p>
          <details>
            <summary class="identity-check">查看接口范围</summary>
            <p v-for="scope in item.permissions" :key="scope">
              <code class="break-all text-sm">{{ scope }}</code>
            </p>
          </details>
          <KimaButton
            v-if="!item.revokedAt"
            variant="tonal"
            @click="begin(item.id)"
            >撤销密钥</KimaButton
          >
        </article>
      </section>
      <section class="panel">
        <form v-if="opened" class="identity-stack" @submit.prevent="submit">
          <h2>{{ revokeId ? '撤销密钥' : '创建密钥' }}</h2>
          <template v-if="!revokeId"
            ><label
              ><span>用途名称</span
              ><KimaTextField
                v-model="name"
                label="用途名称"
                placeholder="例如：自己的服务监控"
                required
                maxlength="80" /></label
            ><label
              ><span>有效期</span
              ><KimaSelect
                v-model="days"
                label="有效期"
                :items="terms" /></label
            ><PermissionScopes
              v-model="selected"
              :items="scopes ?? []"
              :disabled="busy"
          /></template>
          <p v-else>撤销后，使用此密钥的工具将无法继续调用。</p>
          <div class="identity-proof identity-stack">
            <h3>主账号确认</h3>
            <label
              ><span>当前密码</span
              ><KimaTextField
                v-model="password"
                label="当前密码"
                type="password"
                required
                autocomplete="current-password" /></label
            ><SecondFactor v-model="proof" />
          </div>
          <KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton
              type="submit"
              :loading="busy"
              :disabled="busy || (!revokeId && !selected.length)"
              >{{ revokeId ? '确认撤销' : '创建并显示密钥' }}</KimaButton
            ><KimaButton
              variant="text"
              :disabled="busy"
              @click="
                opened = false;
                password = '';
                proof.code = '';
              "
              >取消</KimaButton
            >
          </div>
        </form>
        <div v-else class="identity-stack">
          <h2>如何调用</h2>
          <p class="muted">
            请求使用本站的 <code>/api/v1</code> 前缀，在 Authorization 中传入
            Bearer 密钥。金额字段以分为单位的整数字符串传输。
          </p>
          <code class="identity-secret">Authorization: Bearer yz_你的密钥</code>
          <p class="muted">
            请将密钥保存在服务端。密钥权限随账号和管理角色实时收紧，修改密码后需要重新创建。
          </p>
          <AppLink to="/console/settings">账户与安全</AppLink>
        </div>
      </section>
    </div>
  </div>
</template>
