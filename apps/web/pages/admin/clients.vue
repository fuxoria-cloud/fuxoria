<!-- 客户管理：搜索客户、保存内部备注与分组，管理折扣和逾期暂停豁免。调用：管理员访问/admin/clients。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '客户管理', robots: 'noindex, nofollow' });
interface Client {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  groupId: string | null;
  groupName?: string;
  notes: string;
  phone: string;
  company: string;
  orderCount?: number;
  serviceCount?: number;
}
interface Group {
  id: string;
  name: string;
  color: string;
  discountPercent: number;
  suspendExempt: boolean;
  separateInvoices: boolean;
  clientCount: number;
}
const api = useApi(),
  keyword = ref(''),
  search = ref(''),
  groupFilter = ref(''),
  page = ref(1);
const endpoint = computed(
  () =>
    `/admin/clients?page=${page.value}&limit=25&keyword=${encodeURIComponent(search.value)}${groupFilter.value ? `&groupId=${groupFilter.value}` : ''}`,
);
const { data, pending, error, refresh } = await useAsyncData(
  computed(() => `identity-clients:${endpoint.value}`),
  () => api<{ items: Client[]; total: number }>(endpoint.value),
);
const { data: groups, refresh: refreshGroups } = await useAsyncData(
  'identity-client-groups',
  () => api<Group[]>('/admin/client-groups'),
);
const choices = computed(() => [
  { value: '', label: '不分组' },
  ...(groups.value ?? []).map((item) => ({ value: item.id, label: item.name })),
]);
const mode = ref<'client' | 'group' | ''>(''),
  editing = ref(''),
  deleting = ref(false),
  busy = ref(false),
  message = ref(''),
  success = ref('');
const password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const client = reactive({
  name: '',
  email: '',
  newPassword: '',
  groupId: '',
  disabled: false,
  notes: '',
});
const group = reactive({
  name: '',
  color: '#61afef',
  discountPercent: '0',
  suspendExempt: false,
  separateInvoices: false,
});
function beginClient(item?: Client) {
  mode.value = 'client';
  editing.value = item?.id ?? '';
  deleting.value = false;
  message.value = '';
  password.value = '';
  proof.value.code = '';
  Object.assign(client, {
    name: item?.name ?? '',
    email: item?.email ?? '',
    newPassword: '',
    groupId: item?.groupId ?? '',
    disabled: item?.disabled ?? false,
    notes: item?.notes ?? '',
  });
}
function beginGroup(item?: Group) {
  mode.value = 'group';
  editing.value = item?.id ?? '';
  deleting.value = false;
  message.value = '';
  password.value = '';
  proof.value.code = '';
  Object.assign(group, {
    name: item?.name ?? '',
    color: item?.color ?? '#61afef',
    discountPercent: String(item?.discountPercent ?? 0),
    suspendExempt: item?.suspendExempt ?? false,
    separateInvoices: item?.separateInvoices ?? false,
  });
}
async function submit() {
  busy.value = true;
  message.value = '';
  success.value = '';
  try {
    const confirm = { password: password.value, ...factorProof(proof.value) };
    if (mode.value === 'group')
      await api(
        `/admin/client-groups${editing.value ? `/${editing.value}` : ''}`,
        {
          method: deleting.value ? 'DELETE' : editing.value ? 'PUT' : 'POST',
          body: deleting.value
            ? confirm
            : {
                ...group,
                discountPercent: Number(group.discountPercent),
                ...confirm,
              },
        },
      );
    else
      await api(`/admin/clients${editing.value ? `/${editing.value}` : ''}`, {
        method: editing.value ? 'PUT' : 'POST',
        body: {
          name: client.name,
          groupId: client.groupId || null,
          notes: client.notes,
          ...(editing.value
            ? { disabled: client.disabled }
            : { email: client.email, newPassword: client.newPassword }),
          ...confirm,
        },
      });
    success.value = deleting.value
      ? '客户组已删除。'
      : mode.value === 'group'
        ? '客户组已保存。'
        : '客户资料已保存。';
    mode.value = '';
    password.value = '';
    client.newPassword = '';
    proof.value.code = '';
    await Promise.all([refresh(), refreshGroups()]);
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
function runSearch() {
  page.value = 1;
  search.value = keyword.value.trim();
}
watch(groupFilter, () => {
  page.value = 1;
});
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">客户关系</p>
        <h1>客户与分组</h1>
        <p class="muted">管理客户资料、内部备注及分组权益。</p>
      </div>
      <div class="identity-actions">
        <AppLink to="/admin">管理概况</AppLink
        ><KimaButton @click="beginClient()">添加客户</KimaButton>
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
          <div class="panel-header">
            <h2>客户</h2>
            <span class="muted">{{ data?.total ?? 0 }} 位</span>
          </div>
          <form class="identity-toolbar" @submit.prevent="runSearch">
            <label
              ><span>姓名或邮箱</span
              ><KimaTextField
                v-model="keyword"
                label="搜索客户"
                maxlength="100" /></label
            ><div
              ><span>客户组</span
              ><KimaSelect
                v-model="groupFilter"
                label="筛选客户组"
                :items="[
                  { value: '', label: '全部客户组' },
                  ...choices.slice(1),
                ]" /></div><KimaButton type="submit" variant="tonal">搜索</KimaButton>
          </form>
          <KimaSkeleton v-if="pending" /><KimaEmptyState
            v-else-if="!data?.items.length && !error"
            heading="没有匹配的客户"
            description="换个姓名或邮箱试试。"
          />
          <article
            v-for="item in data?.items"
            :key="item.id"
            class="identity-record"
          >
            <h3>
              {{ item.name }} <KimaChip v-if="item.disabled">已停用</KimaChip>
            </h3>
            <p>{{ item.email || item.phone || item.name }}</p>
            <p class="muted">
              {{ item.groupName ?? '不分组'
              }}<template v-if="item.company"> · {{ item.company }}</template>
            </p>
            <p v-if="item.notes" class="muted whitespace-pre-wrap">
              {{ item.notes }}
            </p>
            <KimaButton variant="tonal" @click="beginClient(item)"
              >管理客户</KimaButton
            >
          </article>
          <div v-if="(data?.total ?? 0) > 25" class="identity-actions mt-6">
            <KimaButton
              variant="tonal"
              :disabled="page <= 1 || pending"
              @click="page--"
              >上一页</KimaButton
            ><span>第 {{ page }} 页</span
            ><KimaButton
              variant="tonal"
              :disabled="page * 25 >= (data?.total ?? 0) || pending"
              @click="page++"
              >下一页</KimaButton
            >
          </div>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>客户组</h2>
            <KimaButton variant="tonal" @click="beginGroup()"
              >添加分组</KimaButton
            >
          </div>
          <p v-if="!groups?.length" class="muted">
            尚未设置客户组。新客户按标准价格购买。
          </p>
          <article
            v-for="item in groups"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }}</h3>
            <p class="muted">
              {{ item.clientCount }} 位客户 · 减免
              {{ item.discountPercent }}%<template v-if="item.suspendExempt">
                · 逾期免自动暂停</template
              ><template v-if="item.separateInvoices"> · 单独出账</template>
            </p>
            <div class="identity-actions">
              <KimaButton variant="tonal" @click="beginGroup(item)"
                >编辑</KimaButton
              ><KimaButton
                variant="text"
                @click="
                  beginGroup(item);
                  deleting = true;
                "
                >删除</KimaButton
              >
            </div>
          </article>
        </section>
      </div>
      <section class="panel">
        <form v-if="mode" class="identity-stack" @submit.prevent="submit">
          <h2>
            {{
              deleting
                ? '删除客户组'
                : mode === 'group'
                  ? editing
                    ? '编辑客户组'
                    : '添加客户组'
                  : editing
                    ? '管理客户'
                    : '添加客户'
            }}
          </h2>
          <template v-if="mode === 'client'"
            ><label
              ><span>姓名</span
              ><KimaTextField
                v-model="client.name"
                label="客户姓名"
                required
                maxlength="60" /></label
            ><template v-if="!editing"
              ><label
                ><span>邮箱</span
                ><KimaTextField
                  v-model="client.email"
                  label="客户邮箱"
                  type="email"
                  required
                  maxlength="254" /></label
              ><label
                ><span>初始密码</span
                ><KimaTextField
                  v-model="client.newPassword"
                  label="客户初始密码"
                  type="password"
                  required
                  minlength="12"
                  maxlength="128"
                  autocomplete="new-password" /></label></template
            ><label v-else
              ><span>邮箱</span
              ><KimaTextField
                :model-value="client.email"
                label="客户邮箱"
                disabled /></label
            ><div
              ><span>客户组</span
              ><KimaSelect
                v-model="client.groupId"
                label="客户组"
                :items="choices" /></div><label v-if="editing" class="identity-check"
              ><input
                v-model="client.disabled"
                type="checkbox"
              />停用此客户的登录与密钥</label
            ><label
              ><span>内部备注</span
              ><KimaTextarea
                v-model="client.notes"
                label="内部备注"
                :maxlength="10000"
                hint="仅管理员可见。" /></label></template
          ><template v-else-if="!deleting"
            ><label
              ><span>分组名称</span
              ><KimaTextField
                v-model="group.name"
                label="客户组名称"
                required
                maxlength="80" /></label
            ><label
              ><span>标识颜色</span
              ><KimaTextField
                v-model="group.color"
                label="标识颜色"
                pattern="#[0-9a-fA-F]{6}"
                required /></label
            ><label
              ><span>价格减免百分比</span
              ><KimaTextField
                v-model="group.discountPercent"
                label="价格减免百分比"
                type="number"
                min="0"
                max="100"
                step="1"
                required
                hint="0表示原价；10表示减免10%，客户支付90%。" /></label
            ><label class="identity-check"
              ><input
                v-model="group.suspendExempt"
                type="checkbox"
              />逾期时免于自动暂停服务</label
            ><label class="identity-check"
              ><input
                v-model="group.separateInvoices"
                type="checkbox"
              />按服务单独出账</label
            ></template
          >
          <p v-else>
            确认删除 {{ group.name }}？组内仍有客户时，请先调整客户分组。
          </p>
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
              deleting ? '确认删除' : '保存'
            }}</KimaButton
            ><KimaButton
              variant="text"
              :disabled="busy"
              @click="
                mode = '';
                password = '';
                client.newPassword = '';
                proof.code = '';
              "
              >取消</KimaButton
            >
          </div>
        </form>
        <div v-else>
          <h2>选择一位客户</h2>
          <p class="muted">
            客户停用后，现有登录和密钥即时失效。分组权益会参与后续报价及服务周期处理。
          </p>
          <AppLink to="/admin/roles">管理运营人员的访问权限</AppLink>
        </div>
      </section>
    </div>
  </div>
</template>
