<!-- 联盟运营：配置首购/续费/复购规则，管理推荐资格，凭实际打款记录处理提现。调用：/admin/affiliates。 -->
<script setup lang="ts">
import { money, amount, toCents } from '~/features/money';
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '联盟推荐管理', robots: 'noindex, nofollow' });
interface Rule {
  kind: string;
  value: string;
}
interface Settings {
  enabled: boolean;
  initialRule: Rule;
  renewalRule: Rule;
  reorderRule: Rule;
  holdDays: number;
  minimumWithdrawCents: string;
}
interface Referrer {
  id: string;
  name: string;
  email: string;
  enabled: boolean;
  referralCount: number;
  balanceCents: string;
}
interface Withdrawal {
  id: string;
  email: string;
  amountCents: string;
  status: string;
  payee: { method: string; name: string; account: string };
  createdAt: string;
  reference?: string;
  evidenceUrl?: string;
  decisionReason?: string;
}
const api = useApi(),
  route = useRoute(),
  router = useRouter(),
  page = ref(1);
const tab = computed(() =>
  ['withdrawals', 'referrers', 'settings'].includes(String(route.query.tab))
    ? String(route.query.tab)
    : 'withdrawals',
);
const {
  data: settings,
  error: settingsError,
  refresh: refreshSettings,
} = await useAsyncData('affiliate-admin-settings', () =>
  api<Settings>('/admin/affiliates/settings'),
);
const {
  data: referrers,
  error: referrerError,
  refresh: refreshReferrers,
} = await useAsyncData(
  computed(() => `affiliate-admin-referrers:${page.value}`),
  () => api<Referrer[]>(`/admin/affiliates?page=${page.value}&limit=25`),
);
const {
  data: withdrawals,
  error: withdrawalError,
  refresh: refreshWithdrawals,
} = await useAsyncData(
  computed(() => `affiliate-admin-withdrawals:${page.value}`),
  () =>
    api<Withdrawal[]>(
      `/admin/affiliate-withdrawals?page=${page.value}&limit=25`,
    ),
);
const error = computed(() =>
  tab.value === 'settings'
    ? settingsError.value
    : tab.value === 'referrers'
      ? referrerError.value
      : withdrawalError.value,
);
const form = reactive({
  enabled: false,
  initialKind: 'percent',
  initialValue: '10.00',
  renewalKind: 'percent',
  renewalValue: '5.00',
  reorderKind: 'percent',
  reorderValue: '10.00',
  holdDays: '30',
  minimum: '100.00',
});
watch(
  settings,
  (value) => {
    if (value)
      Object.assign(form, {
        enabled: value.enabled,
        initialKind: value.initialRule.kind,
        initialValue: amount(value.initialRule.value),
        renewalKind: value.renewalRule.kind,
        renewalValue: amount(value.renewalRule.value),
        reorderKind: value.reorderRule.kind,
        reorderValue: amount(value.reorderRule.value),
        holdDays: String(value.holdDays),
        minimum: amount(value.minimumWithdrawCents),
      });
  },
  { immediate: true },
);
const selected = ref<Withdrawal | null>(null),
  referrer = ref<Referrer | null>(null),
  busy = ref(''),
  message = ref(''),
  success = ref(''),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const action = ref('pay'),
  reason = ref(''),
  reference = ref(''),
  evidence = ref(''),
  paidAt = ref(''),
  confirmed = ref(false);
const statuses: Record<string, string> = {
    pending: '待处理',
    paid: '已登记打款',
    rejected: '已驳回',
    cancelled: '已撤回',
  },
  methods: Record<string, string> = {
    bank: '银行转账',
    alipay: '支付宝',
    wechat: '微信',
  };
const kinds = [
  { value: 'percent', label: '按净收款百分比' },
  { value: 'fixed', label: '固定金额（不超过净收款）' },
];
function clear() {
  message.value = '';
  password.value = '';
  proof.value.code = '';
}
function choose(item: Withdrawal) {
  selected.value = item;
  referrer.value = null;
  action.value = 'pay';
  reason.value = '';
  reference.value = '';
  evidence.value = '';
  paidAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  confirmed.value = false;
  clear();
}
function chooseReferrer(item: Referrer) {
  referrer.value = item;
  selected.value = null;
  clear();
}
async function saveSettings() {
  busy.value = 'settings';
  message.value = '';
  try {
    await api('/admin/affiliates/settings', {
      method: 'PUT',
      body: {
        enabled: form.enabled,
        initialRule: {
          kind: form.initialKind,
          value: toCents(form.initialValue, true),
        },
        renewalRule: {
          kind: form.renewalKind,
          value: toCents(form.renewalValue, true),
        },
        reorderRule: {
          kind: form.reorderKind,
          value: toCents(form.reorderValue, true),
        },
        holdDays: Number(form.holdDays),
        minimumWithdrawCents: toCents(form.minimum),
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    await refreshSettings();
    success.value = '联盟规则已保存，仅作用于后续付款。';
    clear();
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function toggle() {
  if (!referrer.value) return;
  busy.value = 'referrer';
  message.value = '';
  try {
    await api(`/admin/affiliates/${referrer.value.id}`, {
      method: 'PUT',
      body: {
        enabled: !referrer.value.enabled,
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    await refreshReferrers();
    referrer.value = null;
    clear();
    success.value = '推荐资格已更新。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function settle(id: string) {
  busy.value = id;
  message.value = '';
  try {
    await api(`/admin/affiliates/${id}/settle`, { method: 'POST' });
    await refreshReferrers();
    success.value = '已按真实付款、退款及等待期核对佣金。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function process() {
  if (!selected.value) return;
  busy.value = 'process';
  message.value = '';
  try {
    await api(`/admin/affiliate-withdrawals/${selected.value.id}/process`, {
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
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    await Promise.all([refreshWithdrawals(), refreshReferrers()]);
    selected.value = null;
    clear();
    success.value = '提现处理结果已保存。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
watch(tab, () => {
  page.value = 1;
  selected.value = null;
  referrer.value = null;
  clear();
});
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">推荐与收益</p>
        <h1>联盟推荐管理</h1>
        <p class="muted">
          佣金来自实际业务付款。提现预留、打款和退款冲回各有独立记录。
        </p>
      </div>
      <AppLink to="/admin">管理概况</AppLink>
    </div>
    <div class="identity-actions mb-6">
      <KimaButton
        v-for="item in [
          { id: 'withdrawals', label: '提现申请' },
          { id: 'referrers', label: '推荐人' },
          { id: 'settings', label: '佣金规则' },
        ]"
        :key="item.id"
        :variant="tab === item.id ? 'filled' : 'tonal'"
        :aria-pressed="tab === item.id"
        @click="router.push({ query: { ...route.query, tab: item.id } })"
        >{{ item.label }}</KimaButton
      >
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
    /><KimaAlert
      v-if="message && !selected && !referrer && tab !== 'settings'"
      variant="danger"
      :description="message"
      class="mb-6"
    />
    <form
      v-if="tab === 'settings'"
      class="panel identity-stack"
      @submit.prevent="saveSettings"
    >
      <h2>佣金规则</h2>
      <label class="identity-check"
        ><input v-model="form.enabled" type="checkbox" />开放联盟推荐</label
      >
      <div class="identity-fields">
        <template
          v-for="item in [
            { label: '首次购买', kind: 'initialKind', value: 'initialValue' },
            { label: '续费', kind: 'renewalKind', value: 'renewalValue' },
            { label: '再次购买', kind: 'reorderKind', value: 'reorderValue' },
          ]"
          :key="item.kind"
          ><div
            ><span>{{ item.label }}方式</span
            ><KimaSelect
              v-model="
                form[item.kind as 'initialKind' | 'renewalKind' | 'reorderKind']
              "
              :label="`${item.label}佣金方式`"
              :items="kinds" /></div><label
            ><span
              >{{ item.label
              }}{{
                form[
                  item.kind as 'initialKind' | 'renewalKind' | 'reorderKind'
                ] === 'percent'
                  ? '比例（%）'
                  : '金额（元）'
              }}</span
            ><KimaTextField
              v-model="
                form[
                  item.value as 'initialValue' | 'renewalValue' | 'reorderValue'
                ]
              "
              :label="`${item.label}佣金数值`"
              inputmode="decimal"
              required /></label></template
        ><label
          ><span>等待期（天）</span
          ><KimaTextField
            v-model="form.holdDays"
            label="佣金等待天数"
            type="number"
            min="0"
            max="365"
            step="1"
            required /></label
        ><label
          ><span>最低提现（元）</span
          ><KimaTextField
            v-model="form.minimum"
            label="最低提现金额（元）"
            inputmode="decimal"
            required
        /></label>
      </div>
      <p class="muted">
        每笔佣金保存付款时的规则。信用消费在实际完整还款后才计佣；充值和信用还款单本身不重复计佣。退款会追加反向记录，已兑现部分保留待追偿事实。
      </p>
      <div class="identity-proof identity-stack">
        <label
          ><span>管理员当前密码</span
          ><KimaTextField
            v-model="password"
            label="规则确认密码"
            type="password"
            required
            autocomplete="current-password" /></label
        ><SecondFactor v-model="proof" />
      </div>
      <KimaAlert
        v-if="message"
        variant="danger"
        :description="message"
      /><KimaButton type="submit" :loading="!!busy" :disabled="!!busy"
        >保存规则</KimaButton
      >
    </form>
    <div v-else class="identity-grid">
      <section class="panel">
        <template v-if="tab === 'referrers'"
          ><div class="panel-header"><h2>推荐人</h2></div>
          <KimaEmptyState
            v-if="referrers && !referrers.length"
            heading="暂无推荐人"
            description="客户启用联盟推荐后会显示在这里。"
          />
          <article
            v-for="item in referrers"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.name }} · {{ item.enabled ? '启用' : '停用' }}</h3>
            <p class="muted">{{ item.email }}</p>
            <p>
              {{ item.referralCount }} 位注册归因 · 净佣金
              {{ money(item.balanceCents) }}
            </p>
            <div class="identity-actions">
              <KimaButton variant="tonal" @click="chooseReferrer(item)"
                >调整资格</KimaButton
              ><KimaButton
                variant="text"
                :loading="busy === item.id"
                :disabled="!!busy"
                @click="settle(item.id)"
                >核对佣金</KimaButton
              >
            </div>
          </article></template
        ><template v-else
          ><div class="panel-header"><h2>提现申请</h2></div>
          <KimaEmptyState
            v-if="withdrawals && !withdrawals.length"
            heading="暂无提现申请"
            description="客户提交后会预留佣金，等待实际处理。"
          />
          <article
            v-for="item in withdrawals"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ money(item.amountCents) }} · {{ statuses[item.status] }}</h3>
            <p>{{ item.payee.name }} · {{ methods[item.payee.method] }}</p>
            <p class="muted">{{ item.email }} · {{ date(item.createdAt) }}</p>
            <KimaButton variant="tonal" @click="choose(item)">{{
              item.status === 'pending' ? '核对并处理' : '查看记录'
            }}</KimaButton>
          </article></template
        >
        <div class="identity-actions mt-5">
          <KimaButton variant="text" :disabled="page <= 1" @click="page--"
            >上一页</KimaButton
          ><span>第 {{ page }} 页</span
          ><KimaButton
            variant="text"
            :disabled="
              (tab === 'referrers'
                ? (referrers?.length ?? 0)
                : (withdrawals?.length ?? 0)) < 25
            "
            @click="page++"
            >下一页</KimaButton
          >
        </div>
      </section>
      <section class="panel">
        <form v-if="referrer" class="identity-stack" @submit.prevent="toggle">
          <h2>{{ referrer.enabled ? '停用' : '恢复' }}推荐资格</h2>
          <p>{{ referrer.name }} · {{ referrer.email }}</p>
          <p class="muted">
            停用后停止后续归因和新佣金，已产生的财务记录保留。
          </p>
          <div class="identity-proof identity-stack">
            <label
              ><span>管理员当前密码</span
              ><KimaTextField
                v-model="password"
                label="推荐资格确认密码"
                type="password"
                required
                autocomplete="current-password" /></label
            ><SecondFactor v-model="proof" />
          </div>
          <KimaAlert
            v-if="message"
            variant="danger"
            :description="message"
          /><KimaButton type="submit" :loading="!!busy" :disabled="!!busy"
            >确认{{ referrer.enabled ? '停用' : '恢复' }}</KimaButton
          >
        </form>
        <div v-else-if="selected" class="identity-stack">
          <h2>提现 {{ money(selected.amountCents) }}</h2>
          <p>{{ selected.email }}</p>
          <div class="identity-proof">
            <p>
              {{ selected.payee.name }} · {{ methods[selected.payee.method] }}
            </p>
            <code class="identity-secret">{{ selected.payee.account }}</code>
          </div>
          <p v-if="selected.decisionReason">
            处理说明：{{ selected.decisionReason }}
          </p>
          <p v-if="selected.reference">实际凭据：{{ selected.reference }}</p>
          <a
            v-if="selected.evidenceUrl"
            :href="selected.evidenceUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="identity-check"
            >查看打款证据</a
          >
          <form
            v-if="selected.status === 'pending'"
            class="identity-stack"
            @submit.prevent="process"
          >
            <div
              ><span>处理方式</span
              ><KimaSelect
                v-model="action"
                label="提现处理方式"
                :items="[
                  { value: 'pay', label: '登记已完成的实际打款' },
                  { value: 'reject', label: '驳回并释放预留' },
                ]" /></div><template v-if="action === 'pay'"
              ><label
                ><span>实际打款流水或凭据编号</span
                ><KimaTextField
                  v-model="reference"
                  label="实际打款凭据"
                  required
                  maxlength="200" /></label
              ><label
                ><span>实际打款时间</span
                ><KimaTextField
                  v-model="paidAt"
                  label="实际打款时间"
                  type="datetime-local"
                  required /></label
              ><label
                ><span>证据链接（选填，HTTPS）</span
                ><KimaTextField
                  v-model="evidence"
                  label="打款证据链接"
                  type="url"
                  placeholder="https://" /></label
              ><label class="identity-check"
                ><input
                  v-model="confirmed"
                  type="checkbox"
                  required
                />我已核对收款人、金额与实际打款凭据。</label
              ></template
            ><label
              ><span
                >处理说明{{
                  action === 'reject' ? '（必填）' : '（选填）'
                }}</span
              ><KimaTextarea
                v-model="reason"
                label="提现处理说明"
                :required="action === 'reject'"
                :maxlength="1000"
            /></label>
            <div class="identity-proof identity-stack">
              <label
                ><span>管理员当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="提现确认密码"
                  type="password"
                  required
                  autocomplete="current-password" /></label
              ><SecondFactor v-model="proof" />
            </div>
            <KimaAlert
              v-if="message"
              variant="danger"
              :description="message"
            /><KimaButton
              type="submit"
              :loading="!!busy"
              :disabled="!!busy || (action === 'pay' && !confirmed)"
              >保存处理结果</KimaButton
            >
          </form>
        </div>
        <div v-else>
          <h2>逐笔核对，留下事实</h2>
          <p class="muted">
            确认前核对收款资料和佣金净额。登记实际打款时，需要唯一凭据和时间；驳回申请会释放预留金额。
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
