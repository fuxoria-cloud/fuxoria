<!-- 联盟推荐：分享真实归因链接、核对佣金来源、转余额与申请提现。调用：主账号访问/console/affiliates。 -->
<script setup lang="ts">
import { money, toCents } from '~/features/money';
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '联盟推荐', robots: 'noindex, nofollow' });
interface Summary {
  profile: { code: string; enabled: boolean } | null;
  settings: {
    enabled: boolean;
    holdDays: number;
    minimumWithdrawCents: string;
    initialRule: Rule;
    renewalRule: Rule;
    reorderRule: Rule;
  };
  availableCents: string;
  balanceCents: string;
  reservedCents: string;
  pendingCents: string;
  refundPending: boolean;
  referralCount: number;
}
interface Rule {
  kind: string;
  value: string;
}
interface Commission {
  id: string;
  invoiceNumber: string;
  category: string;
  quotedCents: string;
  releasedCents: string | null;
  reversedCents: string;
  status: string;
  releaseAt: string;
}
interface Withdrawal {
  id: string;
  amountCents: string;
  status: string;
  payee: { method: string; name: string; account: string };
  createdAt: string;
  decisionReason?: string;
  reference?: string;
  evidenceUrl?: string;
  paidAt?: string;
}
const api = useApi(),
  page = ref(1);
const { data, pending, error, refresh } = await useAsyncData(
  'affiliate-summary',
  () => api<Summary>('/affiliates'),
);
const { data: commissions, refresh: refreshCommissions } = await useAsyncData(
  computed(() => `affiliate-commissions:${page.value}`),
  () =>
    api<Commission[]>(`/affiliates/commissions?page=${page.value}&limit=25`),
);
const { data: withdrawals, refresh: refreshWithdrawals } = await useAsyncData(
  'affiliate-withdrawals',
  () => api<Withdrawal[]>('/affiliates/withdrawals'),
);
const mode = ref<'transfer' | 'withdraw' | ''>(''),
  yuan = ref(''),
  payee = reactive({ method: 'bank', name: '', account: '' }),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' });
const busy = ref(''),
  message = ref(''),
  success = ref('');
const link = computed(() =>
  data.value?.profile && import.meta.client
    ? `${location.origin}/register?ref=${encodeURIComponent(data.value.profile.code)}`
    : '',
);
const categories: Record<string, string> = {
    initial: '首次购买',
    renewal: '续费',
    reorder: '再次购买',
  },
  statuses: Record<string, string> = {
    pending: '待处理',
    paid: '已登记打款',
    rejected: '已驳回',
    cancelled: '已撤回',
  };
let attempt = { body: '', key: '' };
function describe(rule: Rule) {
  return rule.kind === 'fixed'
    ? `每笔 ${money(rule.value)}（以净收款为上限）`
    : `${BigInt(rule.value) / 100n}${BigInt(rule.value) % 100n ? `.${String(BigInt(rule.value) % 100n).padStart(2, '0')}` : ''}%`;
}
function begin(action: 'transfer' | 'withdraw') {
  mode.value = action;
  message.value = '';
  password.value = '';
  proof.value.code = '';
}
async function update() {
  await refresh();
  await Promise.all([refreshCommissions(), refreshWithdrawals()]);
}
async function activate() {
  busy.value = 'activate';
  message.value = '';
  try {
    await api('/affiliates/activate', { method: 'POST' });
    await update();
    success.value = '联盟推荐已启用，可以分享自己的链接了。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value);
    success.value = '推荐链接已复制。';
  } catch {
    message.value = '无法自动复制，请选中链接手动复制。';
  }
}
async function submit() {
  busy.value = 'submit';
  message.value = '';
  success.value = '';
  try {
    const fields = {
        amountCents: toCents(yuan.value),
        ...(mode.value === 'withdraw' ? { payee: { ...payee } } : {}),
      },
      fingerprint = JSON.stringify({ action: mode.value, ...fields });
    if (attempt.body !== fingerprint)
      attempt = { body: fingerprint, key: crypto.randomUUID() };
    await api(
      mode.value === 'withdraw'
        ? '/affiliates/withdrawals'
        : '/affiliates/transfers',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: {
          ...fields,
          password: password.value,
          ...factorProof(proof.value),
        },
      },
    );
    success.value =
      mode.value === 'withdraw'
        ? '提现申请已提交，金额已预留，等待核对实际打款。'
        : '佣金已转入账户余额。';
    mode.value = '';
    yuan.value = '';
    password.value = '';
    proof.value.code = '';
    await update();
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function cancel(id: string) {
  busy.value = id;
  message.value = '';
  try {
    await api(`/affiliates/withdrawals/${id}/cancel`, { method: 'POST' });
    await update();
    success.value = '提现申请已撤回，预留金额已释放。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">把狐岚云分享给伙伴</p>
        <h1>联盟推荐</h1>
        <p class="muted">
          朋友通过你的链接注册并实际付款后，按规则获得推荐收益。
        </p>
      </div>
      <KimaButton variant="tonal" :disabled="!!busy || pending" @click="update"
        >刷新佣金</KimaButton
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
      v-if="message && !mode"
      variant="danger"
      :description="message"
      class="mb-6"
    />
    <KimaSkeleton v-if="pending" /><template v-if="data"
      ><section v-if="!data.profile" class="panel identity-stack">
        <h2>
          {{ data.settings.enabled ? '开启你的推荐链接' : '联盟推荐暂未开放' }}
        </h2>
        <p class="muted">
          收益来自被推荐客户的真实业务付款。等待期
          {{ data.settings.holdDays }} 天，最低提现
          {{ money(data.settings.minimumWithdrawCents) }}。
        </p>
        <KimaButton
          v-if="data.settings.enabled"
          :loading="busy === 'activate'"
          :disabled="!!busy"
          @click="activate"
          >启用联盟推荐</KimaButton
        >
      </section>
      <template v-else
        ><div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4 mb-6">
          <KimaCard class="stat-card"
            ><p class="muted">可用收益</p>
            <p class="text-2xl font-semibold mt-3">
              {{ money(data.availableCents) }}
            </p></KimaCard
          ><KimaCard class="stat-card"
            ><p class="muted">等待期收益</p>
            <p class="text-2xl font-semibold mt-3">
              {{ money(data.pendingCents) }}
            </p></KimaCard
          ><KimaCard class="stat-card"
            ><p class="muted">提现预留</p>
            <p class="text-2xl font-semibold mt-3">
              {{ money(data.reservedCents) }}
            </p></KimaCard
          ><KimaCard class="stat-card"
            ><p class="muted">成功推荐</p>
            <p class="text-2xl font-semibold mt-3">
              {{ data.referralCount }} 位
            </p></KimaCard
          >
        </div>
        <KimaAlert
          v-if="!data.profile.enabled"
          variant="warning"
          description="当前推荐资格已停用，请联系管理员核对。"
          class="mb-6"
        /><KimaAlert
          v-if="data.refundPending"
          variant="warning"
          description="相关订单有退款正在处理，收益转出暂时保留，确认结果后会按净额更新。"
          class="mb-6"
        /><KimaAlert
          v-if="BigInt(data.balanceCents) < 0n"
          variant="warning"
          :description="`已兑现收益受到后续退款影响，待追偿 ${money((-BigInt(data.balanceCents)).toString())}。后续佣金会先抵扣此金额。`"
          class="mb-6"
        />
        <div class="identity-grid">
          <div class="identity-stack">
            <section class="panel identity-stack">
              <h2>你的推荐链接</h2>
              <code class="identity-secret">{{ link }}</code>
              <div class="identity-actions">
                <KimaButton variant="tonal" @click="copy">复制链接</KimaButton
                ><KimaButton
                  :disabled="
                    !data.profile.enabled || BigInt(data.availableCents) <= 0n
                  "
                  @click="begin('transfer')"
                  >转入账户余额</KimaButton
                ><KimaButton
                  variant="tonal"
                  :disabled="
                    !data.profile.enabled ||
                    BigInt(data.availableCents) <
                      BigInt(data.settings.minimumWithdrawCents)
                  "
                  @click="begin('withdraw')"
                  >申请提现</KimaButton
                >
              </div>
              <p class="muted">
                首次购买 {{ describe(data.settings.initialRule) }}；续费
                {{ describe(data.settings.renewalRule) }}；再次购买
                {{
                  describe(data.settings.reorderRule)
                }}。收益以付款时规则为准，退款会按净额冲回。
              </p>
            </section>
            <section class="panel">
              <div class="panel-header"><h2>佣金记录</h2></div>
              <p v-if="!commissions?.length" class="muted">
                暂时没有符合规则的真实付款。
              </p>
              <article
                v-for="item in commissions"
                :key="item.id"
                class="identity-record"
              >
                <h3>账单 #{{ item.invoiceNumber }}</h3>
                <p>
                  {{ categories[item.category] }} ·
                  {{
                    item.status === 'pending'
                      ? '等待期'
                      : item.status === 'void'
                        ? '净额为零'
                        : '已释放'
                  }}
                </p>
                <p>
                  报价 {{ money(item.quotedCents)
                  }}<template v-if="item.releasedCents !== null">
                    · 已释放 {{ money(item.releasedCents) }}</template
                  >
                </p>
                <p v-if="BigInt(item.reversedCents) > 0n" class="muted">
                  退款冲回 {{ money(item.reversedCents) }}
                </p>
                <p v-if="item.status === 'pending'" class="muted">
                  {{ date(item.releaseAt) }} 后符合条件时释放
                </p>
              </article>
              <div class="identity-actions mt-5">
                <KimaButton variant="text" :disabled="page <= 1" @click="page--"
                  >上一页</KimaButton
                ><span>第 {{ page }} 页</span
                ><KimaButton
                  variant="text"
                  :disabled="(commissions?.length ?? 0) < 25"
                  @click="page++"
                  >下一页</KimaButton
                >
              </div>
            </section>
          </div>
          <div class="identity-stack">
            <section v-if="mode" class="panel">
              <form class="identity-stack" @submit.prevent="submit">
                <h2>{{ mode === 'withdraw' ? '申请提现' : '转入账户余额' }}</h2>
                <p class="muted">
                  可用 {{ money(data.availableCents)
                  }}<template v-if="mode === 'withdraw'"
                    >，最低提现
                    {{ money(data.settings.minimumWithdrawCents) }}</template
                  >。
                </p>
                <label
                  ><span>金额（元）</span
                  ><KimaTextField
                    v-model="yuan"
                    label="收益转出金额（元）"
                    inputmode="decimal"
                    required
                    pattern="[0-9]+(\.[0-9]{1,2})?" /></label
                ><template v-if="mode === 'withdraw'"
                  ><label
                    ><span>收款方式</span
                    ><KimaSelect
                      v-model="payee.method"
                      label="提现收款方式"
                      :items="[
                        { value: 'bank', label: '银行转账' },
                        { value: 'alipay', label: '支付宝' },
                        { value: 'wechat', label: '微信' },
                      ]" /></label
                  ><label
                    ><span>收款人姓名</span
                    ><KimaTextField
                      v-model="payee.name"
                      label="提现收款人姓名"
                      required
                      maxlength="100"
                      autocomplete="name" /></label
                  ><label
                    ><span>收款账号</span
                    ><KimaTextField
                      v-model="payee.account"
                      label="提现收款账号"
                      required
                      maxlength="200" /></label
                ></template>
                <div class="identity-proof identity-stack">
                  <label
                    ><span>当前密码</span
                    ><KimaTextField
                      v-model="password"
                      label="收益转出确认密码"
                      type="password"
                      required
                      autocomplete="current-password" /></label
                  ><SecondFactor v-model="proof" />
                </div>
                <KimaAlert v-if="message" variant="danger" :description="message" />
                <div class="identity-actions">
                  <KimaButton
                    type="submit"
                    :loading="!!busy"
                    :disabled="!!busy"
                    >{{
                      mode === 'withdraw' ? '提交提现申请' : '确认转入'
                    }}</KimaButton
                  ><KimaButton
                    variant="text"
                    :disabled="!!busy"
                    @click="
                      mode = '';
                      password = '';
                      proof.code = '';
                    "
                    >取消</KimaButton
                  >
                </div>
              </form>
            </section>
            <section class="panel">
              <div class="panel-header"><h2>提现记录</h2></div>
              <p v-if="!withdrawals?.length" class="muted">尚未申请提现。</p>
              <article
                v-for="item in withdrawals"
                :key="item.id"
                class="identity-record"
              >
                <h3>
                  {{ money(item.amountCents) }} · {{ statuses[item.status] }}
                </h3>
                <p class="muted">
                  {{ date(item.createdAt) }} · {{ item.payee.name }}
                </p>
                <p v-if="item.decisionReason" class="muted">
                  {{ item.decisionReason }}
                </p>
                <p v-if="item.reference" class="muted">
                  打款凭据：{{ item.reference }}
                </p>
                <a
                  v-if="item.evidenceUrl"
                  :href="item.evidenceUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="identity-check"
                  >查看打款记录</a
                ><KimaButton
                  v-if="item.status === 'pending'"
                  variant="text"
                  :disabled="!!busy"
                  @click="cancel(item.id)"
                  >撤回申请</KimaButton
                >
              </article>
            </section>
          </div>
        </div></template
      ></template
    >
  </div>
</template>
