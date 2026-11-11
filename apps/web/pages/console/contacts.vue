<!-- 联系人与子账号：联系资料、独立登录与逐操作授权。调用：登录主账号访问/console/contacts。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '联系人与子账号', robots: 'noindex, nofollow' });
interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  notifications: string[];
  permissions: string[];
  active: boolean;
  loginEnabled: boolean;
}
const api = useApi();
const { data, pending, error, refresh } = await useAsyncData(
  'identity-contacts',
  () => api<Contact[]>('/contacts'),
);
const { data: scopes } = await useAsyncData('identity-contact-scopes', () =>
  api<{ key: string; subject: string }[]>('/contacts/permissions'),
);
const empty = () => ({
  name: '',
  email: '',
  phone: '',
  company: '',
  address: '',
  notifications: [] as string[],
  permissions: [] as string[],
  active: true,
  loginEnabled: false,
  newPassword: '',
});
const form = reactive(empty()),
  editing = ref(''),
  opened = ref(false),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const busy = ref(false),
  message = ref(''),
  success = ref(''),
  deleting = ref('');
const notificationNames = [
  { id: 'general', name: '账户通知' },
  { id: 'product', name: '服务通知' },
  { id: 'invoice', name: '账单通知' },
  { id: 'support', name: '工单通知' },
  { id: 'affiliate', name: '推广通知' },
];
function edit(item?: Contact) {
  Object.assign(form, empty());
  if (item)
    Object.assign(form, {
      name: item.name,
      email: item.email,
      phone: item.phone,
      company: item.company,
      address: item.address,
      active: item.active,
      loginEnabled: item.loginEnabled,
      permissions: [...item.permissions],
      notifications: [...item.notifications],
    });
  editing.value = item?.id ?? '';
  deleting.value = '';
  opened.value = true;
  message.value = '';
  password.value = '';
  proof.value.code = '';
}
async function save() {
  busy.value = true;
  message.value = '';
  success.value = '';
  try {
    const { newPassword, ...fields } = form;
    await api(editing.value ? `/contacts/${editing.value}` : '/contacts', {
      method: editing.value ? 'PUT' : 'POST',
      body: {
        ...fields,
        ...(newPassword ? { newPassword } : {}),
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    opened.value = false;
    password.value = '';
    form.newPassword = '';
    proof.value.code = '';
    await refresh();
    success.value = '联系人已保存。授权变化后，子账号需要重新登录。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  busy.value = true;
  message.value = '';
  success.value = '';
  try {
    await api(`/contacts/${deleting.value}`, {
      method: 'DELETE',
      body: { password: password.value, ...factorProof(proof.value) },
    });
    opened.value = false;
    deleting.value = '';
    password.value = '';
    proof.value.code = '';
    await refresh();
    success.value = '联系人已移除，独立登录已撤销。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">一起打理</p>
        <h1>联系人与子账号</h1>
        <p class="muted">为同事保存联系方式，按需要开放独立登录和服务操作。</p>
      </div>
      <KimaButton @click="edit()">添加联系人</KimaButton>
    </div>
    <KimaAlert v-if="error" variant="danger" :description="apiMessage(error)" />
    <KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    />
    <div class="identity-grid">
      <section class="panel">
        <div class="panel-header">
          <h2>我的联系人</h2>
          <span class="muted">{{ data?.length ?? 0 }} 位</span>
        </div>
        <KimaSkeleton v-if="pending" />
        <KimaEmptyState
          v-else-if="!data?.length && !error"
          heading="还没有联系人"
          description="需要共同管理服务时，再添加一位伙伴。"
        />
        <article v-for="item in data" :key="item.id" class="identity-record">
          <h3>{{ item.name }}</h3>
          <p>{{ item.email }}</p>
          <p v-if="item.phone || item.company" class="muted">
            {{ [item.phone, item.company].filter(Boolean).join(' · ') }}
          </p>
          <p class="muted">
            {{
              !item.active
                ? '已停用'
                : item.loginEnabled
                  ? '可独立登录'
                  : '仅保存联系资料'
            }}
            · {{ item.permissions.length }} 项授权
          </p>
          <div class="identity-actions">
            <KimaButton variant="tonal" @click="edit(item)">编辑</KimaButton
            ><KimaButton
              variant="text"
              @click="
                edit(item);
                deleting = item.id;
              "
              >移除</KimaButton
            >
          </div>
        </article>
      </section>
      <section v-if="opened" class="panel">
        <div class="panel-header">
          <h2>
            {{
              deleting ? '移除联系人' : editing ? '编辑联系人' : '添加联系人'
            }}
          </h2>
        </div>
        <form
          class="identity-stack"
          @submit.prevent="deleting ? remove() : save()"
        >
          <template v-if="!deleting"
            ><div class="identity-fields">
              <label
                ><span>姓名</span
                ><KimaTextField
                  v-model="form.name"
                  label="姓名"
                  required
                  maxlength="80"
                  autocomplete="name" /></label
              ><label
                ><span>邮箱</span
                ><KimaTextField
                  v-model="form.email"
                  label="邮箱"
                  type="email"
                  required
                  maxlength="254"
                  autocomplete="email" /></label
              ><label
                ><span>电话</span
                ><KimaTextField
                  v-model="form.phone"
                  label="电话"
                  type="tel"
                  maxlength="40" /></label
              ><label
                ><span>公司</span
                ><KimaTextField
                  v-model="form.company"
                  label="公司"
                  maxlength="120" /></label
              ><label class="identity-wide"
                ><span>地址</span
                ><KimaTextarea
                  v-model="form.address"
                  label="地址"
                  :maxlength="500"
              /></label>
            </div>
            <label class="identity-check"
              ><input
                v-model="form.active"
                type="checkbox"
              />启用此联系人</label
            ><label class="identity-check"
              ><input
                v-model="form.loginEnabled"
                type="checkbox"
              />允许使用独立邮箱和密码登录</label
            >
            <label v-if="form.loginEnabled"
              ><span>{{ editing ? '新密码（留空保留）' : '子账号密码' }}</span
              ><KimaTextField
                v-model="form.newPassword"
                label="子账号密码"
                type="password"
                minlength="12"
                maxlength="128"
                :required="!editing"
                autocomplete="new-password"
                hint="至少12位。请通过安全方式交给联系人本人。"
            /></label>
            <fieldset>
              <legend>接收的通知</legend>
              <label
                v-for="item in notificationNames"
                :key="item.id"
                class="identity-check"
                ><input
                  v-model="form.notifications"
                  type="checkbox"
                  :value="item.id"
                />{{ item.name }}</label
              >
            </fieldset>
            <div v-if="form.loginEnabled">
              <h3>可以执行的操作</h3>
              <PermissionScopes
                v-model="form.permissions"
                :items="scopes ?? []"
                :disabled="busy"
              />
            </div>
          </template>
          <p v-else>
            移除 {{ form.name }} 后，其独立登录和已授予的操作权限都会失效。
          </p>
          <div class="identity-proof identity-stack">
            <h3>主账号确认</h3>
            <label
              ><span>当前密码</span
              ><KimaTextField
                v-model="password"
                label="主账号当前密码"
                type="password"
                required
                autocomplete="current-password" /></label
            ><SecondFactor v-model="proof" />
          </div>
          <KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton type="submit" :loading="busy" :disabled="busy">{{
              deleting ? '确认移除' : '保存联系人'
            }}</KimaButton
            ><KimaButton
              variant="text"
              :disabled="busy"
              @click="
                opened = false;
                password = '';
                form.newPassword = '';
                proof.code = '';
              "
              >取消</KimaButton
            >
          </div>
        </form>
      </section>
      <section v-else class="panel">
        <h2>放心交给伙伴</h2>
        <p class="muted">
          每位子账号拥有自己的登录密码。只开放你选择的操作，账户凭据、授权管理、合同签署和服务转移仍由主账号确认。
        </p>
        <AppLink to="/console/settings">管理自己的账户安全</AppLink>
      </section>
    </div>
  </div>
</template>
