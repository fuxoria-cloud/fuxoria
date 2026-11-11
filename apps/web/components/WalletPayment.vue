<!-- 余额付款：使用真实已有余额结清当前账单，充值后实际到账才可使用。调用：<WalletPayment :invoice="invoice" @paid="refresh" />。 -->
<script setup lang="ts">
import type { Invoice } from "~/types/api"; // 当前账单由父页面读取并验证所有权
const props = defineProps<{ invoice: Invoice }>(); // 不能由用户自报应付金额
const emit = defineEmits<{ paid: [] }>(); // 付款成功后让账单重新读取状态
const api = useApi(); // 同源会话由服务器最终检查
const { data, pending, error, refresh } = await useAsyncData(
  computed(() => `wallet:${props.invoice.currency || "CNY"}`),
  () =>
    api<{ balanceCents: string; availableCents?: string; currency: string }>(
      `/wallet?currency=${encodeURIComponent(props.invoice.currency || "CNY")}`,
    ),
); // 余额只来自真实账本
const open = ref(false);
const busy = ref(false);
const message = ref(""); // 余额扣款前明确确认
const enough = computed(
  () =>
    !!data.value &&
    data.value.currency === (props.invoice.currency || "CNY") &&
    BigInt(data.value.availableCents ?? data.value.balanceCents) >=
      BigInt(props.invoice.amountCents),
); // 按整数分比较，不使用浮点数
/** 使用当前账单ID作为付款幂等目标，成功后重新读取余额与账单。 */
async function pay() {
  // 用户确认后才发起扣款
  busy.value = true;
  message.value = ""; // 防止重复点击
  try {
    await api(`/invoices/${props.invoice.id}/pay-wallet`, { method: "POST" }); // 服务器锁账单和余额后决定是否能付款
    await refresh();
    open.value = false;
    emit("paid"); // 真实提交后才更新页面
  } catch (error) {
    message.value = apiMessage(error);
  } finally {
    // 不足、状态变化和网络错误都保留原因
    busy.value = false;
  } // 允许确认后再试
}
</script>
<template>
  <div class="wallet-payment mt-8">
    <h3 class="text-base mb-4">使用账户余额</h3>
    <RequestState
      v-if="pending || error"
      :pending="pending"
      :error="error"
      @retry="refresh"
    />
    <template v-else-if="data">
      <p class="muted text-sm">
        实际可用余额
        <span class="numbers">{{
          money(
            data.availableCents ?? data.balanceCents,
            invoice.currency,
            invoice.currencyDecimals,
          )
        }}</span>
      </p>
      <KimaButton
        variant="tonal"
        class="w-full mt-4"
        :disabled="busy || !enough"
        @click="
          open = true;
          message = '';
        "
      >
        {{ enough ? "使用余额付款" : "余额不足，请选择其它付款方式" }}
      </KimaButton>
      <KimaAlert v-if="busy && !open" class="mt-4"
        >余额付款正在核对，请等待本次结果。</KimaAlert
      >
      <KimaAlert v-if="message && !open" variant="danger" class="mt-4">{{
        message
      }}</KimaAlert>
    </template>
  </div>
  <KimaDrawer
    v-model:open="open"
    title="确认使用余额付款？"
    role="alertdialog"
    :close-on-backdrop="false"
    :close-on-escape="!busy"
  >
    <dl class="detail-list">
      <dt>本次扣款</dt>
      <dd class="numbers">
        {{
          money(invoice.amountCents, invoice.currency, invoice.currencyDecimals)
        }}
      </dd>
      <dt>当前余额</dt>
      <dd class="numbers">
        {{
          money(
            data?.availableCents ?? data?.balanceCents ?? "0",
            invoice.currency,
            invoice.currencyDecimals,
          )
        }}
      </dd>
    </dl>
    <p class="muted mt-6">
      确认后将从账户余额支付这张账单。金额和余额仍会由服务端再次核对。
    </p>
    <KimaAlert v-if="message" variant="danger" class="mt-5">{{
      message
    }}</KimaAlert>
    <template #footer>
      <KimaButton
        variant="tonal"
        autofocus
        :disabled="busy"
        @click="open = false"
      >
        再核对一下
      </KimaButton>
      <KimaButton :loading="busy" @click="pay">确认使用余额付款</KimaButton>
    </template>
  </KimaDrawer>
</template>
