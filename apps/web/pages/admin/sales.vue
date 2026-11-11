<!-- 员工销售管理：销售组和阶梯、员工启停、客户分配与实际提成兑现。调用：/admin/sales。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import { money, toCents } from '~/features/money';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '销售管理', robots: 'noindex, nofollow' });
interface Group {
  id: string;
  name: string;
  productIds: string[];
  newBps: number;
  renewBps: number;
  upgradeBps: number;
  holdDays: number;
  active: boolean;
}
interface Tier {
  id: string;
  groupId: string;
  currency: string;
  category: string;
  thresholdCents: string;
  rateBps: number;
  active: boolean;
}
interface Person {
  id: string;
  name: string;
  email: string;
  groupId: string;
  enabled: boolean;
}
interface Withdrawal {
  id: string;
  staffId: string;
  email: string;
  currency: string;
  amountCents: string;
  payee: { name: string; method: string; account: string };
  status: string;
  reason?: string;
  reference?: string;
  evidenceUrl?: string;
}
interface Data {
  groups: Group[];
  tiers: Tier[];
  people: Person[];
  assignments: {
    id: string;
    customerId: string;
    staffId: string;
    name: string;
    email: string;
  }[];
  withdrawals: Withdrawal[];
  clients: { id: string; name: string; email: string }[];
  staff: { id: string; name: string; email: string }[];
  products: { id: string; name: string }[];
}
const api = useApi(),
  route = useRoute(),
  router = useRouter();
const { data, error, refresh } = await useAsyncData('admin-sales', () =>
  api<Data>('/admin/sales'),
);
const { data: currencies } = await useAsyncData('sales-admin-currencies', () =>
  api<{ code: string; name: string; decimals: number }[]>('/currencies'),
);
const tab = computed(() =>
    ['people', 'groups', 'tiers', 'assignments', 'withdrawals'].includes(
      String(route.query.tab),
    )
      ? String(route.query.tab)
      : 'people',
  ),
  mode = ref(''),
  editing = ref(''),
  busy = ref(false),
  message = ref(''),
  success = ref(''),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const group = reactive({
    name: '',
    productIds: [] as string[],
    newRate: '10',
    renewRate: '5',
    upgradeRate: '5',
    holdDays: '30',
    active: true,
  }),
  tier = reactive({
    groupId: '',
    currency: 'CNY',
    category: 'new',
    threshold: '0',
    rate: '10',
    active: true,
  }),
  person = reactive({ id: '', groupId: '', enabled: true }),
  assignment = reactive({ customerId: '', staffId: '' }),
  payout = ref<Withdrawal | null>(null),
  action = ref('pay'),
  reason = ref(''),
  reference = ref(''),
  evidence = ref(''),
  paidAt = ref(''),
  confirmed = ref(false);
const groupChoices = computed(() =>
    (data.value?.groups ?? []).map((g) => ({ value: g.id, label: g.name })),
  ),
  staffChoices = computed(() =>
    (data.value?.staff ?? []).map((p) => ({
      value: p.id,
      label: `${p.name} · ${p.email}`,
    })),
  ),
  peopleChoices = computed(() => [
    { value: '', label: '解除分配' },
    ...(data.value?.people ?? [])
      .filter((p) => p.enabled)
      .map((p) => ({ value: p.id, label: `${p.name} · ${p.email}` })),
  ]),
  clientChoices = computed(() =>
    (data.value?.clients ?? []).map((p) => ({
      value: p.id,
      label: `${p.name} · ${p.email}`,
    })),
  ),
  currencyChoices = computed(() =>
    (currencies.value ?? []).map((c) => ({
      value: c.code,
      label: `${c.name} · ${c.code}`,
    })),
  );
const display = (v: string, c: string) =>
  money(v, c, currencies.value?.find((item) => item.code === c)?.decimals);
function rate(v: string) {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(v))
    throw new Error('提成比例最多两位小数');
  const [a, b = ''] = v.split('.'),
    n = BigInt(a!) * 100n + BigInt(b.padEnd(2, '0'));
  if (n > 10000n) throw new Error('提成比例不能超过100%');
  return Number(n);
}
function begin(kind: string, item?: Group | Person | Withdrawal) {
  mode.value = kind;
  editing.value = item?.id ?? '';
  message.value = '';
  password.value = '';
  proof.value.code = '';
  if (kind === 'group') {
    const g = item as Group | undefined;
    Object.assign(group, {
      name: g?.name ?? '',
      productIds: [...(g?.productIds ?? [])],
      newRate: String((g?.newBps ?? 1000) / 100),
      renewRate: String((g?.renewBps ?? 500) / 100),
      upgradeRate: String((g?.upgradeBps ?? 500) / 100),
      holdDays: String(g?.holdDays ?? 30),
      active: g?.active ?? true,
    });
  }
  if (kind === 'person') {
    const p = item as Person | undefined;
    Object.assign(person, {
      id: p?.id ?? '',
      groupId: p?.groupId ?? '',
      enabled: p?.enabled ?? true,
    });
  }
  if (kind === 'payout') {
    payout.value = item as Withdrawal;
    action.value = 'pay';
    reason.value = '';
    reference.value = '';
    evidence.value = '';
    paidAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    confirmed.value = false;
  }
}
async function submit() {
  busy.value = true;
  message.value = '';
  try {
    const proofBody = { password: password.value, ...factorProof(proof.value) };
    if (mode.value === 'group')
      await api(
        `/admin/sales/groups${editing.value ? '/' + editing.value : ''}`,
        {
          method: editing.value ? 'PUT' : 'POST',
          body: {
            name: group.name,
            productIds: group.productIds,
            newBps: rate(group.newRate),
            renewBps: rate(group.renewRate),
            upgradeBps: rate(group.upgradeRate),
            holdDays: Number(group.holdDays),
            active: group.active,
            ...proofBody,
          },
        },
      );
    else if (mode.value === 'tier')
      await api('/admin/sales/tiers', {
        method: 'POST',
        body: {
          groupId: tier.groupId,
          currency: tier.currency,
          category: tier.category,
          thresholdCents: toCents(
            tier.threshold,
            true,
            tier.currency,
            currencies.value?.find((c) => c.code === tier.currency)?.decimals,
          ),
          rateBps: rate(tier.rate),
          active: tier.active,
          ...proofBody,
        },
      });
    else if (mode.value === 'person')
      await api(`/admin/sales/people/${person.id}`, {
        method: 'PUT',
        body: {
          groupId: person.groupId,
          enabled: person.enabled,
          ...proofBody,
        },
      });
    else if (mode.value === 'assignment')
      await api('/admin/sales/assignments', {
        method: 'POST',
        body: {
          customerId: assignment.customerId,
          staffId: assignment.staffId || null,
          ...proofBody,
        },
      });
    else if (mode.value === 'delete-group' || mode.value === 'delete-tier')
      await api(
        `/admin/sales/${mode.value === 'delete-group' ? 'groups' : 'tiers'}/${editing.value}`,
        { method: 'DELETE', body: proofBody },
      );
    else if (mode.value === 'payout' && payout.value)
      await api(`/admin/sales/withdrawals/${payout.value.id}/process`, {
        method: 'POST',
        body: {
          action: action.value,
          reason: reason.value,
          ...(action.value === 'pay'
            ? {
                reference: reference.value,
                paidAt: new Date(paidAt.value).toISOString(),
                ...(evidence.value ? { evidenceUrl: evidence.value } : {}),
              }
            : {}),
          ...proofBody,
        },
      });
    mode.value = '';
    password.value = '';
    proof.value.code = '';
    await refresh();
    success.value = '销售设置与处理结果已保存。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
watch(tab, () => {
  mode.value = '';
  password.value = '';
  proof.value.code = '';
  message.value = '';
});
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">员工分工与业绩</p>
        <h1>销售管理</h1>
        <p class="muted">
          按实际客户归属、实收和退款净额核对员工提成，与联盟推荐分别留账。
        </p>
      </div>
      <AppLink to="/admin/reports">经营报表</AppLink>
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
    <div class="identity-actions mb-6">
      <KimaButton
        v-for="item in [
          { id: 'people', name: '销售员工' },
          { id: 'groups', name: '销售组' },
          { id: 'tiers', name: '月业绩阶梯' },
          { id: 'assignments', name: '客户归属' },
          { id: 'withdrawals', name: '提成兑现' },
        ]"
        :key="item.id"
        :variant="tab === item.id ? 'filled' : 'tonal'"
        @click="router.push({ query: { ...route.query, tab: item.id } })"
        >{{ item.name }}</KimaButton
      >
    </div>
    <div class="identity-grid">
      <section class="panel">
        <template v-if="tab === 'people'"
          ><div class="panel-header">
            <h2>销售员工</h2>
            <KimaButton variant="tonal" @click="begin('person')"
              >添加员工</KimaButton
            >
          </div>
          <article
            v-for="item in data?.people"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }} · {{ item.enabled ? '启用' : '停用' }}</h3>
            <p class="muted">
              {{ item.email }} ·
              {{ data?.groups.find((g) => g.id === item.groupId)?.name }}
            </p>
            <KimaButton variant="tonal" @click="begin('person', item)"
              >调整分组与状态</KimaButton
            >
          </article></template
        ><template v-else-if="tab === 'groups'"
          ><div class="panel-header">
            <h2>销售组</h2>
            <KimaButton variant="tonal" @click="begin('group')"
              >新建销售组</KimaButton
            >
          </div>
          <article
            v-for="item in data?.groups"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }} · {{ item.active ? '启用' : '停用' }}</h3>
            <p class="muted">
              新购{{ item.newBps / 100 }}% · 续费{{ item.renewBps / 100 }}% ·
              升降级{{ item.upgradeBps / 100 }}% · 等待{{ item.holdDays }}天
            </p>
            <div class="identity-actions">
              <KimaButton variant="tonal" @click="begin('group', item)"
                >编辑</KimaButton
              ><KimaButton variant="text" @click="begin('delete-group', item)"
                >删除</KimaButton
              >
            </div>
          </article></template
        ><template v-else-if="tab === 'tiers'"
          ><div class="panel-header">
            <h2>月业绩阶梯</h2>
            <KimaButton variant="tonal" @click="begin('tier')"
              >设置阶梯</KimaButton
            >
          </div>
          <p class="muted">
            按上海时区的本月累计净实收，为当前成交行选择门槛内最高阶梯；已有计提保存原规则。
          </p>
          <article
            v-for="item in data?.tiers"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ data?.groups.find((g) => g.id === item.groupId)?.name }}</h3>
            <p>
              {{ item.currency }} · {{ item.category }} · 满{{
                display(item.thresholdCents, item.currency)
              }}按{{ item.rateBps / 100 }}%
            </p>
            <p class="muted">
              {{
                item.active ? '启用' : '停用'
              }}；相同组、币种、类型与门槛再次保存可调整规则。
            </p>
            <KimaButton
              variant="text"
              @click="
                mode = 'delete-tier';
                editing = item.id;
                password = '';
                proof.code = '';
              "
              >删除阶梯</KimaButton
            >
          </article></template
        ><template v-else-if="tab === 'assignments'"
          ><div class="panel-header">
            <h2>客户归属</h2>
            <KimaButton variant="tonal" @click="begin('assignment')"
              >分配客户</KimaButton
            >
          </div>
          <article
            v-for="item in data?.assignments"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }}</h3>
            <p class="muted">
              {{ item.email }} →
              {{ data?.people.find((p) => p.id === item.staffId)?.name }}
            </p>
          </article></template
        ><template v-else
          ><h2>提成兑现</h2>
          <article
            v-for="item in data?.withdrawals"
            :key="item.id"
            class="identity-record"
          >
            <h3>
              {{ display(item.amountCents, item.currency) }} · {{ item.status }}
            </h3>
            <p class="muted">{{ item.email }} · {{ item.payee.name }}</p>
            <KimaButton variant="tonal" @click="begin('payout', item)">{{
              item.status === 'pending' ? '核对并处理' : '查看记录'
            }}</KimaButton>
          </article></template
        >
      </section>
      <section class="panel">
        <form v-if="mode" class="identity-stack" @submit.prevent="submit">
          <h2>
            {{
              mode === 'group'
                ? '销售组规则'
                : mode === 'tier'
                  ? '设置阶梯'
                  : mode === 'person'
                    ? '员工分组'
                    : mode === 'assignment'
                      ? '分配客户'
                      : mode === 'payout'
                        ? '核对兑现申请'
                        : '确认删除'
            }}
          </h2>
          <template v-if="mode === 'group'"
            ><label
              ><span>组名</span
              ><KimaTextField
                v-model="group.name"
                label="销售组名称"
                required
                maxlength="100"
            /></label>
            <div class="identity-fields">
              <label
                ><span>新购比例（%）</span
                ><KimaTextField
                  v-model="group.newRate"
                  label="销售新购比例"
                  required
                  inputmode="decimal" /></label
              ><label
                ><span>续费比例（%）</span
                ><KimaTextField
                  v-model="group.renewRate"
                  label="销售续费比例"
                  required
                  inputmode="decimal" /></label
              ><label
                ><span>升降级比例（%）</span
                ><KimaTextField
                  v-model="group.upgradeRate"
                  label="销售升降级比例"
                  required
                  inputmode="decimal" /></label
              ><label
                ><span>等待期（天）</span
                ><KimaTextField
                  v-model="group.holdDays"
                  label="销售等待天数"
                  required
                  type="number"
                  min="0"
                  max="365"
              /></label>
            </div>
            <label class="identity-check"
              ><input
                v-model="group.active"
                type="checkbox"
              />启用此销售组</label
            >
            <fieldset>
              <legend>计提商品（不选表示全部）</legend>
              <label
                v-for="item in data?.products"
                :key="item.id"
                class="identity-check"
                ><input
                  v-model="group.productIds"
                  type="checkbox"
                  :value="item.id"
                />{{ item.name }}</label
              >
            </fieldset></template
          ><template v-else-if="mode === 'tier'"
            ><div>
              <span>销售组</span
              ><KimaSelect
                v-model="tier.groupId"
                label="阶梯销售组"
                :items="groupChoices"
              />
            </div>
            <div>
              <span>币种</span
              ><KimaSelect
                v-model="tier.currency"
                label="阶梯币种"
                :items="currencyChoices"
              />
            </div>
            <div>
              <span>业务类型</span
              ><KimaSelect
                v-model="tier.category"
                label="阶梯业务类型"
                :items="[
                  { value: 'new', label: '新购' },
                  { value: 'renew', label: '续费' },
                  { value: 'upgrade', label: '升降级' },
                ]"
              />
            </div>
            <label
              ><span>本月净实收门槛</span
              ><KimaTextField
                v-model="tier.threshold"
                label="销售阶梯门槛"
                inputmode="decimal"
                required /></label
            ><label
              ><span>比例（%）</span
              ><KimaTextField
                v-model="tier.rate"
                label="销售阶梯比例"
                inputmode="decimal"
                required /></label
            ><label class="identity-check"
              ><input v-model="tier.active" type="checkbox" />启用阶梯</label
            ></template
          ><template v-else-if="mode === 'person'"
            ><div>
              <span>员工</span
              ><KimaSelect
                v-model="person.id"
                label="销售员工"
                :items="staffChoices"
                :disabled="!!editing"
              />
            </div>
            <div>
              <span>销售组</span
              ><KimaSelect
                v-model="person.groupId"
                label="员工销售组"
                :items="groupChoices"
              />
            </div>
            <label class="identity-check"
              ><input
                v-model="person.enabled"
                type="checkbox"
              />启用销售分工</label
            ></template
          ><template v-else-if="mode === 'assignment'"
            ><div>
              <span>客户</span
              ><KimaSelect
                v-model="assignment.customerId"
                label="销售归属客户"
                :items="clientChoices"
              />
            </div>
            <div>
              <span>员工</span
              ><KimaSelect
                v-model="assignment.staffId"
                label="客户归属员工"
                :items="peopleChoices"
              />
            </div>
            <p class="muted">
              变更仅影响之后的实际付款，旧归属和已有提成继续保留。
            </p></template
          ><template v-else-if="mode === 'payout' && payout"
            ><p>
              {{ payout.email }} ·
              {{ display(payout.amountCents, payout.currency) }}
            </p>
            <p>{{ payout.payee.name }} · {{ payout.payee.method }}</p>
            <code class="identity-secret">{{ payout.payee.account }}</code>
            <p v-if="payout.reference">原打款凭据：{{ payout.reference }}</p>
            <template v-if="payout.status === 'pending'"
              ><div>
                <span>处理方式</span
                ><KimaSelect
                  v-model="action"
                  label="销售兑现处理方式"
                  :items="[
                    { value: 'pay', label: '登记已完成的实际打款' },
                    { value: 'reject', label: '驳回并释放预留' },
                  ]"
                />
              </div>
              <template v-if="action === 'pay'"
                ><label
                  ><span>实际打款凭据</span
                  ><KimaTextField
                    v-model="reference"
                    label="销售实际打款凭据"
                    required
                    maxlength="200" /></label
                ><label
                  ><span>实际打款时间</span
                  ><KimaTextField
                    v-model="paidAt"
                    label="销售实际打款时间"
                    type="datetime-local"
                    required /></label
                ><label
                  ><span>证据链接（选填）</span
                  ><KimaTextField
                    v-model="evidence"
                    label="销售打款证据链接"
                    type="url" /></label
                ><label class="identity-check"
                  ><input
                    v-model="confirmed"
                    type="checkbox"
                    required
                  />已核对实际打款金额、收款人和凭据。</label
                ></template
              ><label
                ><span>处理说明</span
                ><KimaTextarea
                  v-model="reason"
                  label="销售兑现处理说明"
                  :required="action === 'reject'"
                  :maxlength="1000" /></label></template
          ></template>
          <p v-else>
            删除前请确认记录。已有员工或计提历史的销售组保留，可通过停用控制后续业务。
          </p>
          <template v-if="mode !== 'payout' || payout?.status === 'pending'"
            ><div class="identity-proof identity-stack">
              <label
                ><span>管理员当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="销售管理确认密码"
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
                :disabled="
                  busy || (mode === 'payout' && action === 'pay' && !confirmed)
                "
                >保存</KimaButton
              ><KimaButton
                variant="text"
                @click="
                  mode = '';
                  password = '';
                  proof.code = '';
                "
                >取消</KimaButton
              >
            </div></template
          >
        </form>
        <div v-else>
          <h2>先分工，再核对实际业绩</h2>
          <p class="muted">
            销售员工仅从自己的工作台读取分配客户和提成。新购、续费和升降级分别配置规则，币种和月业绩分别计算。
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
