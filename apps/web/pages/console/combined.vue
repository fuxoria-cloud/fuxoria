<!-- 合并支付：选择可用原账单、核对总额、跳转同一收银台付款，未发起付款的父单可解除合并。调用：/console/combined。 -->
<script setup lang="ts">
import { money } from "~/features/money";
import "~/assets/css/identity.css";
definePageMeta({ layout: "console", middleware: "account" });
useSeoMeta({ title: "合并支付", robots: "noindex, nofollow" });
interface Bill {
  id: string;
  number: string;
  amountCents: string;
  currency: string;
  currencyDecimals?: number;
  productName: string;
  kind: string;
  dueAt?: string;
}
interface Group {
  currency: string;
  currencyDecimals?: number;
  id: string;
  number: string;
  amountCents: string;
  status: string;
  itemCount: number;
  createdAt: string;
  cancellable: boolean;
}
const api = useApi(),
  router = useRouter();
const {
  data: eligible,
  error,
  pending,
  refresh: refreshEligible,
} = await useAsyncData("combined-eligible", () =>
  api<Bill[]>("/combined-invoices/eligible"),
);
const { data: groups, refresh: refreshGroups } = await useAsyncData(
  "combined-groups",
  () => api<Group[]>("/combined-invoices"),
);
const selected = ref<string[]>([]),
  busy = ref(""),
  message = ref(""),
  success = ref(""),
  cancelling = ref("");
const currency = ref("CNY");
const currencyOptions = computed(() =>
  [
    ...new Set((eligible.value ?? []).map((item) => item.currency || "CNY")),
  ].map((code) => ({ value: code, label: code })),
);
const visibleBills = computed(() =>
  (eligible.value ?? []).filter(
    (item) => (item.currency || "CNY") === currency.value,
  ),
);
watch(
  currencyOptions,
  (choices) => {
    if (
      choices.length &&
      !choices.some((item) => item.value === currency.value)
    )
      currency.value = choices[0].value;
  },
  { immediate: true },
);
watch(currency, () => {
  selected.value = [];
}); // 更换币种后清空旧选择
const precision = computed(() => visibleBills.value[0]?.currencyDecimals);
const selectedBills = computed(() =>
  visibleBills.value.filter((item) => selected.value.includes(item.id)),
);
const total = computed(() =>
  selectedBills.value
    .reduce((sum, item) => sum + BigInt(item.amountCents), 0n)
    .toString(),
);
const kinds: Record<string, string> = {
    new: "新购",
    renew: "续费",
    upgrade: "升降级",
  },
  statuses: Record<string, string> = {
    pending: "待付款",
    paid: "已结清",
    cancelled: "已取消",
  };
let attempt = { body: "", key: "" };
watch(eligible, (value) => {
  selected.value = selected.value.filter((id) =>
    value?.some((item) => item.id === id),
  );
});
async function create() {
  busy.value = "create";
  message.value = "";
  success.value = "";
  try {
    const body = { invoiceIds: [...selected.value].sort() },
      fingerprint = JSON.stringify(body);
    if (attempt.body !== fingerprint)
      attempt = { body: fingerprint, key: crypto.randomUUID() };
    const result = await api<{ invoiceId: string }>("/combined-invoices", {
      method: "POST",
      headers: { "Idempotency-Key": attempt.key },
      body,
    });
    selected.value = [];
    await Promise.all([refreshEligible(), refreshGroups()]);
    await router.push(`/console/invoices/${result.invoiceId}`);
  } catch (failure) {
    message.value = apiMessage(failure);
    await refreshEligible();
  } finally {
    busy.value = "";
  }
}
async function cancel(id: string) {
  busy.value = id;
  message.value = "";
  try {
    await api(`/combined-invoices/${id}/cancel`, { method: "POST" });
    cancelling.value = "";
    await Promise.all([refreshEligible(), refreshGroups()]);
    success.value = "合并已解除，原账单可重新单独付款。";
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
        <p class="eyebrow">一次安排好</p>
        <h1>合并支付</h1>
        <p class="muted">把几张尚未发起付款的业务账单，合成一笔统一付款。</p>
      </div>
      <AppLink to="/console/invoices">全部账单</AppLink>
    </div>
    <KimaAlert
      v-if="error"
      variant="danger"
      :description="apiMessage(error)"
    /><KimaAlert
      v-if="message"
      variant="danger"
      :description="message"
      class="mb-6"
    /><KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    />
    <div class="identity-grid">
      <section class="panel">
        <div class="panel-header">
          <h2>选择原账单</h2>
          <span class="muted">{{ eligible?.length ?? 0 }} 张可选</span>
        </div>
        <KimaSkeleton v-if="pending" /><KimaEmptyState
          v-else-if="!eligible?.length && !error"
          heading="暂无可合并的账单"
          description="已发起付款、已付款、充值和信用还款账单不会重复加入。"
        />
        <form v-else class="identity-stack" @submit.prevent="create">
          <KimaSelect
            v-if="currencyOptions.length > 1"
            v-model="currency"
            label="账单币种"
            :items="currencyOptions"
          />
          <label
            v-for="item in visibleBills"
            :key="item.id"
            class="identity-check identity-record"
            ><input
              v-model="selected"
              type="checkbox"
              :value="item.id"
              :disabled="
                !!busy || (!selected.includes(item.id) && selected.length >= 50)
              "
            /><span class="min-w-0"
              ><strong class="block break-words">{{ item.productName }}</strong
              ><span class="block"
                >账单 #{{ item.number }} ·
                {{
                  money(
                    item.amountCents,
                    item.currency || "CNY",
                    item.currencyDecimals,
                  )
                }}</span
              ><span class="muted block"
                >{{ kinds[item.kind] ?? item.kind
                }}<template v-if="item.dueAt">
                  · {{ date(item.dueAt) }} 到期</template
                ></span
              ></span
            ></label
          >
          <div class="identity-proof identity-stack">
            <p>
              已选 {{ selectedBills.length }} 张 · 合计
              <strong>{{ money(total, currency, precision) }}</strong>
            </p>
            <KimaButton
              type="submit"
              :loading="busy === 'create'"
              :disabled="!!busy || selectedBills.length < 2"
              >合并并前往付款</KimaButton
            >
            <p class="muted">
              原订单、价格和服务都会保留。合并后请从统一父账单付款，系统会在同一笔入账中结清所选账单。
            </p>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>我的合并账单</h2></div>
        <p v-if="!groups?.length" class="muted">还没有合并记录。</p>
        <article v-for="item in groups" :key="item.id" class="identity-record">
          <h3>合并账单 #{{ item.number }}</h3>
          <p>
            {{
              money(
                item.amountCents,
                item.currency || "CNY",
                item.currencyDecimals,
              )
            }}
            · {{ item.itemCount }} 张原账单 ·
            {{ statuses[item.status] }}
          </p>
          <p class="muted">{{ date(item.createdAt) }}</p>
          <div class="identity-actions">
            <AppLink
              :to="`/console/invoices/${item.id}`"
              class="min-h-11 inline-flex items-center"
              >{{
                item.status === "pending" ? "查看并付款" : "查看记录"
              }}</AppLink
            ><KimaButton
              v-if="item.cancellable && cancelling !== item.id"
              variant="text"
              :disabled="!!busy"
              @click="cancelling = item.id"
              >解除合并</KimaButton
            ><template v-else-if="item.cancellable"
              ><KimaButton
                :loading="busy === item.id"
                :disabled="!!busy"
                @click="cancel(item.id)"
                >确认解除</KimaButton
              ><KimaButton
                variant="text"
                :disabled="!!busy"
                @click="cancelling = ''"
                >保留合并</KimaButton
              ></template
            >
          </div>
        </article>
        <p class="muted mt-6">
          发起付款前可解除合并；生成付款链接后，请先核对付款结果。开票和退款统一针对合并父单，部分退款按合并时原账单顺序冲减对应金额。
        </p>
      </section>
    </div>
  </div>
</template>
