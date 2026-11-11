<!-- 管理角色与人员：真实接口权限、复制角色、添加管理员或客服、撤销访问。调用：管理员访问/admin/roles。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '角色与管理员', robots: 'noindex, nofollow' });
interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  disabled: boolean;
  memberCount: number;
}
interface Staff {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'support';
  roleId: string | null;
  roleName?: string;
  disabled: boolean;
}
const api = useApi();
const {
  data: roles,
  error,
  refresh: refreshRoles,
} = await useAsyncData('identity-admin-roles', () =>
  api<Role[]>('/admin/roles'),
);
const { data: staff, refresh: refreshStaff } = await useAsyncData(
  'identity-administrators',
  () => api<Staff[]>('/admin/administrators'),
);
const { data: scopes } = await useAsyncData('identity-admin-scopes', () =>
  api<{ key: string; subject: string }[]>('/admin/permissions'),
);
const mode = ref<'role' | 'staff' | 'copy' | 'delete' | ''>(''),
  editing = ref(''),
  busy = ref(false),
  message = ref(''),
  success = ref('');
const role = reactive({
  name: '',
  description: '',
  permissions: [] as string[],
  disabled: false,
});
const member = reactive({
  name: '',
  email: '',
  newPassword: '',
  role: 'admin',
  roleId: '',
  disabled: false,
});
const password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const choices = computed(() => [
  { value: '', label: '最高管理员（全部权限）' },
  ...(roles.value ?? [])
    .filter((item) => !item.disabled)
    .map((item) => ({ value: item.id, label: item.name })),
]);
function beginRole(item?: Role, action: 'role' | 'copy' | 'delete' = 'role') {
  mode.value = action;
  editing.value = item?.id ?? '';
  Object.assign(role, {
    name: item ? (action === 'copy' ? `${item.name} 副本` : item.name) : '',
    description: item?.description ?? '',
    permissions: [...(item?.permissions ?? [])],
    disabled: item?.disabled ?? false,
  });
  clearProof();
}
function beginStaff(item?: Staff) {
  mode.value = 'staff';
  editing.value = item?.id ?? '';
  Object.assign(member, {
    name: item?.name ?? '',
    email: item?.email ?? '',
    newPassword: '',
    role: item?.role ?? 'admin',
    roleId: item?.roleId ?? '',
    disabled: item?.disabled ?? false,
  });
  clearProof();
}
function clearProof() {
  message.value = '';
  password.value = '';
  proof.value.code = '';
}
async function submit() {
  busy.value = true;
  message.value = '';
  success.value = '';
  try {
    const confirm = { password: password.value, ...factorProof(proof.value) };
    if (mode.value === 'staff')
      await api(
        `/admin/administrators${editing.value ? `/${editing.value}` : ''}`,
        {
          method: editing.value ? 'PUT' : 'POST',
          body: {
            roleId: member.role === 'support' ? null : member.roleId || null,
            ...(editing.value
              ? { disabled: member.disabled }
              : {
                  name: member.name,
                  email: member.email,
                  newPassword: member.newPassword,
                  role: member.role,
                }),
            ...confirm,
          },
        },
      );
    else
      await api(
        `/admin/roles${editing.value ? `/${editing.value}` : ''}${mode.value === 'copy' ? '/copy' : ''}`,
        {
          method:
            mode.value === 'delete'
              ? 'DELETE'
              : mode.value === 'copy' || !editing.value
                ? 'POST'
                : 'PUT',
          body:
            mode.value === 'delete'
              ? confirm
              : mode.value === 'copy'
                ? { name: role.name, ...confirm }
                : { ...role, ...confirm },
        },
      );
    mode.value = '';
    clearProof();
    member.newPassword = '';
    await Promise.all([refreshRoles(), refreshStaff()]);
    success.value = '管理权限已保存，新的访问范围立即生效。';
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
        <p class="eyebrow">团队分工</p>
        <h1>角色与管理员</h1>
        <p class="muted">把日常运营交给合适的人，每个角色只开放需要的操作。</p>
      </div>
      <div class="identity-actions">
        <AppLink to="/admin">管理概况</AppLink
        ><KimaButton @click="beginRole()">创建角色</KimaButton>
      </div>
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
    <div class="identity-grid">
      <div class="identity-stack">
        <section class="panel">
          <div class="panel-header"><h2>管理角色</h2></div>
          <p class="muted">
            最高管理员拥有全部权限。普通角色按下方接口范围授权。
          </p>
          <KimaEmptyState
            v-if="roles && !roles.length"
            heading="还没有自定义角色"
            description="可先为客服、财务或运营创建专用角色。"
          />
          <article v-for="item in roles" :key="item.id" class="identity-record">
            <h3>
              {{ item.name }} <KimaChip v-if="item.disabled">已停用</KimaChip>
            </h3>
            <p v-if="item.description" class="muted">{{ item.description }}</p>
            <p class="muted">
              {{ item.memberCount }} 位成员 ·
              {{ item.permissions.length }} 项权限
            </p>
            <div class="identity-actions">
              <KimaButton variant="tonal" @click="beginRole(item)"
                >编辑</KimaButton
              ><KimaButton variant="text" @click="beginRole(item, 'copy')"
                >复制</KimaButton
              ><KimaButton variant="text" @click="beginRole(item, 'delete')"
                >删除</KimaButton
              >
            </div>
          </article>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>运营人员</h2>
            <KimaButton variant="tonal" @click="beginStaff()"
              >添加人员</KimaButton
            >
          </div>
          <article v-for="item in staff" :key="item.id" class="identity-record">
            <h3>
              {{ item.name }} <KimaChip v-if="item.disabled">已停用</KimaChip>
            </h3>
            <p>{{ item.email }}</p>
            <p class="muted">
              {{
                item.role === 'support'
                  ? '客服（由支持部门授权）'
                  : (item.roleName ?? '最高管理员')
              }}
            </p>
            <KimaButton variant="tonal" @click="beginStaff(item)"
              >调整权限</KimaButton
            >
          </article>
        </section>
      </div>
      <section class="panel">
        <form v-if="mode" class="identity-stack" @submit.prevent="submit">
          <h2>
            {{
              mode === 'staff'
                ? editing
                  ? '调整人员权限'
                  : '添加运营人员'
                : mode === 'copy'
                  ? '复制角色'
                  : mode === 'delete'
                    ? '删除角色'
                    : editing
                      ? '编辑角色'
                      : '创建角色'
            }}
          </h2>
          <template v-if="mode === 'staff'"
            ><template v-if="!editing"
              ><label
                ><span>姓名</span
                ><KimaTextField
                  v-model="member.name"
                  label="运营人员姓名"
                  maxlength="60"
                  required /></label
              ><label
                ><span>邮箱</span
                ><KimaTextField
                  v-model="member.email"
                  label="运营人员邮箱"
                  type="email"
                  required /></label
              ><label
                ><span>初始密码</span
                ><KimaTextField
                  v-model="member.newPassword"
                  label="运营人员初始密码"
                  type="password"
                  required
                  minlength="12"
                  maxlength="128"
                  autocomplete="new-password" /></label
              ><div
                ><span>人员类型</span
                ><KimaSelect
                  v-model="member.role"
                  label="人员类型"
                  :items="[
                    { value: 'admin', label: '管理员' },
                    { value: 'support', label: '客服' },
                  ]" /></div></template>
            <p v-else>{{ member.name }} · {{ member.email }}</p>
            <div v-if="member.role === 'admin'"
              ><span>管理角色</span
              ><KimaSelect
                v-model="member.roleId"
                label="管理角色"
                :items="choices"
            /></div>
            <p v-else class="muted">客服的工单范围由支持部门成员关系决定。</p>
            <label v-if="editing" class="identity-check"
              ><input
                v-model="member.disabled"
                type="checkbox"
              />停用登录与密钥</label
            ></template
          >
          <p v-else-if="mode === 'delete'">
            确认删除 {{ role.name }}？仍有成员使用的角色不能删除。
          </p>
          <template v-else
            ><label
              ><span>角色名称</span
              ><KimaTextField
                v-model="role.name"
                label="角色名称"
                maxlength="80"
                required /></label
            ><template v-if="mode === 'role'"
              ><label
                ><span>说明</span
                ><KimaTextarea
                  v-model="role.description"
                  label="角色说明"
                  :maxlength="500" /></label
              ><label class="identity-check"
                ><input
                  v-model="role.disabled"
                  type="checkbox"
                />停用此角色</label
              ><PermissionScopes
                v-model="role.permissions"
                :items="scopes ?? []"
                :disabled="busy" /></template
          ></template>
          <div class="identity-proof identity-stack">
            <h3>管理员确认</h3>
            <label
              ><span>当前密码</span
              ><KimaTextField
                v-model="password"
                label="管理员当前密码"
                type="password"
                required
                autocomplete="current-password" /></label
            ><SecondFactor v-model="proof" />
          </div>
          <KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton type="submit" :loading="busy" :disabled="busy">{{
              mode === 'delete' ? '确认删除' : '保存'
            }}</KimaButton
            ><KimaButton
              variant="text"
              :disabled="busy"
              @click="
                mode = '';
                clearProof();
                member.newPassword = '';
              "
              >取消</KimaButton
            >
          </div>
        </form>
        <div v-else>
          <h2>按工作分配权限</h2>
          <p class="muted">
            角色权限来自当前真实接口。普通管理员不能授予超出自己范围的权限，也不能改动自己正在使用的角色。系统始终保留一位可登录的最高管理员。
          </p>
          <AppLink to="/admin/clients">返回客户管理</AppLink>
        </div>
      </section>
    </div>
  </div>
</template>
