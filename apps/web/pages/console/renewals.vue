<!-- 批量续费：主账号选择服务，确认后逐项创建真实账单并读取持久结果。调用：/console/renewals。 -->
<script setup lang="ts">
import { KimaCheckbox } from "@kernel4632/kima"; // 选择控件与其它商品页面保持一致
import type { Service } from "~/types/api";
import { canRenewService, servicePeriod } from "~/features/service"; // 到期/在途状态只解释一次
definePageMeta({ layout: "console", middleware: "account" });
useSeoMeta({ title: "批量续费", robots: "noindex, nofollow" });
type Result = {
  serviceId: string;
  ok: boolean;
  invoiceId?: string;
  amountCents?: string;
  currency?: string;
  currencyDecimals?: number;
  status?: string;
  message?: string;
};
type Batch = {
  id: string;
  status: string;
  items: { serviceId: string; period: string }[];
  results: Result[];
  createdAt: string;
};
const api = useApi(),
  account = useAccount(),
  selected = ref<string[]>([]),
  confirming = ref(false),
  busy = ref(false),
  message = ref(""),
  view = ref("");
let key = ""; // 超时重试保留本次提交标识
const {
  data: services,
  pending,
  error,
  refresh,
} = await useAsyncData("services", () => api<Service[]>("/services"));
const {
  data: batches,
  error: batchError,
  refresh: refreshBatches,
} = await useAsyncData("renewal-batches", () =>
  api<Batch[]>("/renewal-batches"),
);
const available = computed(() => services.value?.filter(canRenewService) || []),
  chosen = computed(() =>
    available.value.filter((service) => selected.value.includes(service.id)),
  ),
  current = computed(
    () =>
      batches.value?.find((batch) => batch.id === view.value) ||
      batches.value?.[0],
  ); // 不把已终止或正在变更的服务加入选择
watch(
  selected,
  () => {
    key = "";
  },
  { deep: true },
); // 更换服务属于新意图，旧键不能重用
function toggle(id: string, on: boolean) {
  selected.value = on
    ? [...selected.value, id]
    : selected.value.filter((value) => value !== id);
} // 清楚处理勾选与撤销
async function submit() {
  busy.value = true;
  message.value = "";
  try {
    key ||= crypto.randomUUID();
    const saved = await api<{ id: string }>("/renewal-batches", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: {
        items: chosen.value.map((service) => ({
          serviceId: service.id,
          period: service.billingPeriod || "month",
        })),
      },
    });
    view.value = saved.id;
    key = "";
    confirming.value = false;
    selected.value = [];
    await refreshBatches();
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  } // 只是提交命令，不伪装所有服务已续费
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    if (
      batches.value?.some((batch) =>
        ["pending", "running"].includes(batch.status),
      )
    )
      void refreshBatches();
  }, 2000);
}); // 处理期间只刷新批次结果，页面和选择保持不变
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
}); // 离开页面后不再轮询
const names: Record<string, string> = {
  pending: "等待处理",
  running: "逐项处理中",
  completed: "处理结束",
  cancelled: "授权失效，已停止",
};
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>批量续费</h1>
        <p>一次选择多份服务，每项结果都能单独核对。</p>
      </div>
      <KimaButton
        variant="tonal"
        @click="
          refresh();
          refreshBatches();
        "
        >刷新</KimaButton
      >
    </header>
    <KimaAlert v-if="account.user.value?.delegated"
      >批量续费由主账号本人提交。已委托的单服务操作仍可从“我的服务”办理。</KimaAlert
    >
    <section v-else class="panel content-padding">
      <header class="flex flex-wrap justify-between gap-4 items-center">
        <h2>选择要续费的服务</h2>
        <KimaButton
          variant="text"
          @click="
            selected =
              selected.length === available.length
                ? []
                : available.map((service) => service.id)
          "
          >{{
            selected.length === available.length && available.length
              ? "清除选择"
              : "选择全部可续费服务"
          }}</KimaButton
        >
      </header>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="!available.length"
        title="当前没有可续费的服务"
        description="服务开通并且没有在途变更后，会出现在这里。"
        @retry="refresh"
      />
      <article
        v-for="service in available"
        :key="service.id"
        class="batch-service-row flex flex-wrap items-center justify-between gap-4 py-5 border-b border-[var(--kima-color-outline-variant)]"
      >
        <KimaCheckbox
          :label="service.name || service.productName || service.id"
          :model-value="selected.includes(service.id)"
          :disabled="busy"
          @update:model-value="toggle(service.id, $event)"
        />
        <p class="muted">
          {{ servicePeriod(service) }} ·
          {{
            money(
              service.priceCents || "0",
              service.currency || "CNY",
              service.currencyDecimals,
            )
          }}
        </p>
        <AppLink :to="`/console/services/${service.id}`">查看服务</AppLink>
      </article>
      <KimaButton
        class="mt-6"
        :disabled="!chosen.length || busy"
        @click="confirming = true"
        >核对选中的 {{ chosen.length }} 份服务</KimaButton
      >
    </section>
    <KimaAlert v-if="message" variant="danger" class="mt-5">{{
      message
    }}</KimaAlert>
    <section class="panel content-padding mt-6">
      <h2>处理结果</h2>
      <RequestState
        :error="batchError"
        :empty="!batches?.length"
        title="还没有批量续费记录"
        @retry="refreshBatches"
      />
      <template v-if="current"
        ><p class="muted my-4">
          {{ date(current.createdAt) }} ·
          {{ names[current.status] || current.status }}
        </p>
        <p v-if="['pending', 'running'].includes(current.status)" role="status">
          正在检查当前合同并逐项创建账单，处理结果会自动更新。
        </p>
        <article
          v-for="result in current.results"
          :key="result.serviceId"
          class="flex flex-wrap items-center justify-between gap-4 py-4 border-t border-[var(--kima-color-outline-variant)]"
        >
          <div>
            <AppLink :to="`/console/services/${result.serviceId}`">{{
              services?.find((service) => service.id === result.serviceId)
                ?.name || result.serviceId.slice(0, 8)
            }}</AppLink>
            <p v-if="!result.ok" class="form-hint">{{ result.message }}</p>
            <p v-else class="form-hint">
              {{
                result.status === "paid"
                  ? "已按免费合同完成续费"
                  : "账单已创建，付款后延长服务"
              }}
            </p>
          </div>
          <AppLink
            v-if="result.invoiceId"
            :to="`/console/invoices/${result.invoiceId}`"
            >{{ result.status === "paid" ? "查看记录" : "去付款" }} ·
            {{
              money(
                result.amountCents || "0",
                result.currency || "CNY",
                result.currencyDecimals,
              )
            }}</AppLink
          >
        </article>
        <AppLink
          v-if="
            current.results.filter(
              (result) => result.ok && result.status === 'unpaid',
            ).length > 1
          "
          to="/console/combined"
          class="inline-flex min-h-12 items-center mt-4"
          >合并这些待付账单</AppLink
        >
      </template>
      <div v-if="(batches?.length || 0) > 1" class="flex flex-wrap gap-3 mt-6">
        <KimaButton
          v-for="batch in batches"
          :key="batch.id"
          variant="text"
          @click="view = batch.id"
          >{{ date(batch.createdAt) }} · {{ batch.items.length }}份</KimaButton
        >
      </div>
    </section>
    <KimaDrawer
      v-model:open="confirming"
      title="确认这次批量续费"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <p>
        将为选中的
        {{ chosen.length }}
        份服务分别创建续费账单。免费合同会直接续费；付费合同在实际付款后延长。不同币种的金额分别核对。
      </p>
      <ul class="my-5 space-y-3">
        <li v-for="service in chosen" :key="service.id">
          {{ service.name || service.productName }} ·
          {{ servicePeriod(service) }} ·
          {{
            money(
              service.priceCents || "0",
              service.currency || "CNY",
              service.currencyDecimals,
            )
          }}
        </li>
      </ul>
      <KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
      <template #footer
        ><KimaButton
          variant="tonal"
          :disabled="busy"
          @click="confirming = false"
          >返回选择</KimaButton
        ><KimaButton :loading="busy" @click="submit"
          >确认，逐项处理</KimaButton
        ></template
      >
    </KimaDrawer>
  </div>
</template>
