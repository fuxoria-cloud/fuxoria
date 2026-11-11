<!-- 开票中心：保存个人/企业抬头、选择真实已付账单、跟踪开票交付。调用：/console/vouchers。 -->
<script setup lang="ts">
import { money } from "~/features/money";
import "~/assets/css/identity.css";
definePageMeta({ layout: "console", middleware: "account" });
useSeoMeta({ title: "开票中心", robots: "noindex, nofollow" });
interface Profile {
  id: string;
  title: string;
  type: string;
  taxNumber: string;
  invoiceType: string;
  bank: string;
  bankAccount: string;
  address: string;
  phone: string;
  email: string;
  shippingAddress: string;
}
interface TaxRequest {
  id: string;
  number: string;
  profile: Profile;
  amountCents: string;
  currency?: string;
  currencyDecimals?: number;
  redDocument?: {
    invoiceNumber: string;
    documentUrl?: string;
    reason: string;
    createdAt: string;
  };
  status: string;
  invoiceNumber?: string;
  documentUrl?: string;
  trackingNumber?: string;
  decisionReason?: string;
  createdAt: string;
}
const api = useApi(),
  base = useRuntimeConfig().public.apiBase;
const { data, pending, error, refresh } = await useAsyncData(
  "document-tax-requests",
  () => api<TaxRequest[]>("/tax-requests"),
);
const { data: profiles, refresh: refreshProfiles } = await useAsyncData(
  "document-tax-profiles",
  () => api<Profile[]>("/tax-profiles"),
);
const { data: invoices, refresh: refreshInvoices } = await useAsyncData(
  "document-tax-eligible",
  () =>
    api<
      {
        id: string;
        number: string;
        amountCents: string;
        currency?: string;
        currencyDecimals?: number;
        paidAt: string;
      }[]
    >("/tax-eligible-invoices"),
);
const mode = ref<"request" | "profile" | "">(""),
  editing = ref(""),
  deleting = ref(""),
  busy = ref(""),
  message = ref(""),
  success = ref("");
const account = useAccount();
const blank = () => ({
  title: "",
  type: "person",
  taxNumber: "",
  invoiceType: "ordinary",
  bank: "",
  bankAccount: "",
  address: "",
  phone: "",
  email: account.user.value?.email ?? "",
  shippingAddress: "",
});
const profile = reactive(blank()),
  profileId = ref(""),
  invoiceIds = ref<string[]>([]),
  note = ref("");
const labels: Record<string, string> = {
  pending: "待处理",
  approved: "待开具",
  issued: "已开具",
  rejected: "已驳回",
  cancelled: "已撤回",
};
const invoiceCurrency = ref("CNY");
const currencyChoices = computed(() =>
  [
    ...new Set((invoices.value || []).map((item) => item.currency || "CNY")),
  ].map((code) => ({ value: code, label: code })),
);
const eligibleInvoices = computed(
  () =>
    invoices.value?.filter(
      (item) => (item.currency || "CNY") === invoiceCurrency.value,
    ) || [],
);
watch(
  currencyChoices,
  (choices) => {
    if (
      choices.length &&
      !choices.some((item) => item.value === invoiceCurrency.value)
    )
      invoiceCurrency.value = choices[0]!.value;
  },
  { immediate: true },
);
watch(invoiceCurrency, () => {
  invoiceIds.value = [];
}); // 不同货币必须分别申请
const total = computed(() =>
  (invoices.value ?? [])
    .filter((item) => invoiceIds.value.includes(item.id))
    .reduce((sum, item) => sum + BigInt(item.amountCents), 0n)
    .toString(),
);
const profileOptions = computed(() =>
  (profiles.value ?? []).map((item) => ({
    value: item.id,
    label: `${item.title} · ${item.invoiceType === "special" ? "专用发票" : "普通发票"}`,
  })),
);
let attempt = { body: "", key: "" };
function edit(item?: Profile) {
  Object.assign(profile, blank());
  if (item)
    for (const key of Object.keys(profile) as (keyof typeof profile)[])
      profile[key] = item[key];
  editing.value = item?.id ?? "";
  mode.value = "profile";
  message.value = "";
  deleting.value = "";
}
async function saveProfile() {
  busy.value = "profile";
  message.value = "";
  try {
    await api(`/tax-profiles${editing.value ? `/${editing.value}` : ""}`, {
      method: editing.value ? "PUT" : "POST",
      body: profile,
    });
    await refreshProfiles();
    mode.value = "";
    success.value = "开票抬头已保存。";
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = "";
  }
}
async function removeProfile(id: string) {
  busy.value = id;
  message.value = "";
  try {
    await api(`/tax-profiles/${id}`, { method: "DELETE" });
    await refreshProfiles();
    deleting.value = "";
    if (profileId.value === id) profileId.value = "";
    success.value = "开票抬头已删除，已有申请保留原抬头快照。";
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = "";
  }
}
async function create() {
  busy.value = "request";
  message.value = "";
  success.value = "";
  try {
    const body = {
        profileId: profileId.value,
        invoiceIds: [...invoiceIds.value].sort(),
        note: note.value,
      },
      fingerprint = JSON.stringify(body);
    if (attempt.body !== fingerprint)
      attempt = { body: fingerprint, key: crypto.randomUUID() };
    await api("/tax-requests", {
      method: "POST",
      headers: { "Idempotency-Key": attempt.key },
      body,
    });
    invoiceIds.value = [];
    note.value = "";
    mode.value = "";
    await Promise.all([refresh(), refreshInvoices()]);
    success.value = "开票申请已提交，可在记录中查看处理结果。";
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = "";
  }
}
async function cancel(id: string) {
  busy.value = id;
  message.value = "";
  try {
    await api(`/tax-requests/${id}/cancel`, { method: "POST" });
    await Promise.all([refresh(), refreshInvoices()]);
    success.value = "待处理申请已撤回，可重新选择账单申请。";
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = "";
  }
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">票据留存</p>
        <h1>开票中心</h1>
        <p class="muted">保存抬头，按实际已付账单申请开票并查看交付结果。</p>
      </div>
      <KimaButton
        @click="
          mode = 'request';
          message = '';
        "
        >申请开票</KimaButton
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
    <div class="identity-grid">
      <div class="identity-stack">
        <section class="panel">
          <div class="panel-header"><h2>开票记录</h2></div>
          <KimaSkeleton v-if="pending" /><KimaEmptyState
            v-else-if="!data?.length && !error"
            heading="还没有开票申请"
            description="已支付的账单可按实际可开票金额申请。"
          />
          <article v-for="item in data" :key="item.id" class="identity-record">
            <h3>{{ item.profile.title }}</h3>
            <p>
              {{
                money(
                  item.amountCents,
                  item.currency || "CNY",
                  item.currencyDecimals,
                )
              }}
              ·
              {{ labels[item.status] ?? item.status }}
            </p>
            <p class="muted">
              申请 #{{ item.number }} · {{ date(item.createdAt) }}
            </p>
            <p v-if="item.invoiceNumber">发票号码：{{ item.invoiceNumber }}</p>
            <p v-if="item.redDocument" class="form-hint">
              已全额红冲 · 红字票号 {{ item.redDocument.invoiceNumber }}
            </p>
            <KimaLink
              v-if="item.redDocument?.documentUrl"
              :href="item.redDocument.documentUrl"
              target="_blank"
              >查看红字发票</KimaLink
            >
            <p v-if="item.trackingNumber">
              寄送单号：{{ item.trackingNumber }}
            </p>
            <p v-if="item.decisionReason" class="muted">
              {{ item.decisionReason }}
            </p>
            <div class="identity-actions">
              <a
                v-if="item.documentUrl"
                :href="item.documentUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="min-h-11 inline-flex items-center px-3"
                >查看已开具发票</a
              ><a
                :href="`${base}/tax-requests/${item.id}/document`"
                download
                class="min-h-11 inline-flex items-center px-3"
                >下载申请记录</a
              ><KimaButton
                v-if="item.status === 'pending'"
                variant="text"
                :disabled="!!busy"
                @click="cancel(item.id)"
                >撤回申请</KimaButton
              >
            </div>
          </article>
        </section>
        <section class="panel">
          <div class="panel-header">
            <h2>开票抬头</h2>
            <KimaButton variant="tonal" @click="edit()">添加抬头</KimaButton>
          </div>
          <p v-if="!profiles?.length" class="muted">
            申请前，先保存一个个人或企业抬头。
          </p>
          <article
            v-for="item in profiles"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.title }}</h3>
            <p class="muted">
              {{ item.type === "company" ? "企业" : "个人" }} ·
              {{ item.invoiceType === "special" ? "专用发票" : "普通发票" }}
            </p>
            <p v-if="item.taxNumber" class="muted">
              税号：{{ item.taxNumber }}
            </p>
            <p class="muted">{{ item.email }}</p>
            <div class="identity-actions">
              <KimaButton variant="tonal" @click="edit(item)">编辑</KimaButton
              ><KimaButton
                v-if="deleting !== item.id"
                variant="text"
                @click="deleting = item.id"
                >删除</KimaButton
              ><template v-else
                ><KimaButton
                  :disabled="!!busy"
                  :loading="busy === item.id"
                  @click="removeProfile(item.id)"
                  >确认删除</KimaButton
                ><KimaButton variant="text" @click="deleting = ''"
                  >取消</KimaButton
                ></template
              >
            </div>
          </article>
        </section>
      </div>
      <section class="panel">
        <form
          v-if="mode === 'request'"
          class="identity-stack"
          @submit.prevent="create"
        >
          <h2>申请开票</h2>
          <div>
            <span>开票抬头</span
            ><KimaSelect
              v-model="profileId"
              label="开票抬头"
              :items="profileOptions"
            />
          </div>
          <KimaButton v-if="!profiles?.length" variant="tonal" @click="edit()"
            >先添加抬头</KimaButton
          >
          <div v-if="currencyChoices.length > 1">
            <span>开票币种</span
            ><KimaSelect
              v-model="invoiceCurrency"
              label="开票币种"
              :items="currencyChoices"
            />
          </div>
          <fieldset>
            <legend>选择已付账单</legend>
            <p v-if="!invoices?.length" class="muted">
              暂无可申请的账单。未付款、退款中或已申请开票的账单无法重复使用。
            </p>
            <label
              v-for="item in eligibleInvoices"
              :key="item.id"
              class="identity-check"
              ><input
                v-model="invoiceIds"
                type="checkbox"
                :value="item.id"
              /><span
                >账单 #{{ item.number }} ·
                {{
                  money(
                    item.amountCents,
                    item.currency || "CNY",
                    item.currencyDecimals,
                  )
                }}<small class="block muted"
                  >{{ date(item.paidAt) }} 付款</small
                ></span
              ></label
            >
          </fieldset>
          <p>
            申请金额：<strong>{{
              money(
                total,
                invoiceCurrency,
                eligibleInvoices[0]?.currencyDecimals,
              )
            }}</strong>
          </p>
          <label
            ><span>补充说明（选填）</span
            ><KimaTextarea
              v-model="note"
              label="开票补充说明"
              :maxlength="1000" /></label
          ><KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton
              type="submit"
              :loading="!!busy"
              :disabled="!!busy || !profileId || !invoiceIds.length"
              >提交申请</KimaButton
            ><KimaButton variant="text" @click="mode = ''">取消</KimaButton>
          </div>
        </form>
        <form
          v-else-if="mode === 'profile'"
          class="identity-stack"
          @submit.prevent="saveProfile"
        >
          <h2>{{ editing ? "编辑开票抬头" : "添加开票抬头" }}</h2>
          <div>
            <span>抬头类型</span
            ><KimaSelect
              v-model="profile.type"
              label="抬头类型"
              :items="[
                { value: 'person', label: '个人' },
                { value: 'company', label: '企业' },
              ]"
            />
          </div>
          <label
            ><span>抬头名称</span
            ><KimaTextField
              v-model="profile.title"
              label="抬头名称"
              required
              maxlength="200"
          /></label>
          <div>
            <span>发票类型</span
            ><KimaSelect
              v-model="profile.invoiceType"
              label="发票类型"
              :items="[
                { value: 'ordinary', label: '普通发票' },
                ...(profile.type === 'company'
                  ? [{ value: 'special', label: '专用发票' }]
                  : []),
              ]"
            />
          </div>
          <label v-if="profile.type === 'company'"
            ><span>纳税人识别号</span
            ><KimaTextField
              v-model="profile.taxNumber"
              label="纳税人识别号"
              required
              maxlength="50" /></label
          ><label
            ><span>接收邮箱</span
            ><KimaTextField
              v-model="profile.email"
              label="发票接收邮箱"
              type="email"
              required
              maxlength="254"
          /></label>
          <div class="identity-fields">
            <label
              ><span>开户银行</span
              ><KimaTextField
                v-model="profile.bank"
                label="开户银行"
                :required="profile.invoiceType === 'special'"
                maxlength="200" /></label
            ><label
              ><span>银行账号</span
              ><KimaTextField
                v-model="profile.bankAccount"
                label="银行账号"
                :required="profile.invoiceType === 'special'"
                maxlength="100"
                inputmode="numeric" /></label
            ><label class="identity-wide"
              ><span>注册地址</span
              ><KimaTextarea
                v-model="profile.address"
                label="注册地址"
                :required="profile.invoiceType === 'special'"
                :maxlength="500" /></label
            ><label
              ><span>联系电话</span
              ><KimaTextField
                v-model="profile.phone"
                label="开票联系电话"
                type="tel"
                :required="profile.invoiceType === 'special'"
                maxlength="40" /></label
            ><label class="identity-wide"
              ><span>寄送地址（选填）</span
              ><KimaTextarea
                v-model="profile.shippingAddress"
                label="发票寄送地址"
                :maxlength="1000"
            /></label>
          </div>
          <KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton type="submit" :loading="!!busy" :disabled="!!busy"
              >保存抬头</KimaButton
            ><KimaButton variant="text" @click="mode = ''">取消</KimaButton>
          </div>
        </form>
        <div v-else>
          <h2>抬头一次填写，申请直接选择</h2>
          <p class="muted">
            申请会保留当时的抬头资料。开票金额按实际收款扣除已完成退款计算；处理完成后，可查看真实票号和交付链接。
          </p>
          <AppLink to="/console/invoices">查看自己的账单</AppLink>
        </div>
      </section>
    </div>
  </div>
</template>
