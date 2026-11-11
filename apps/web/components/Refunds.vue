<!-- 已付账单退款：按元申请、按分传输，真实额度与历史都由API确认。调用：<Refunds :invoice="invoice" />。 -->
<script setup lang="ts">
import type { Invoice, Refund } from "~/types/api"; // 只处理当前已付账单的退款
const props = defineProps<{ invoice: Invoice }>(); // 账单金额来自服务端而不是用户输入
const api = useApi(); // 申请与历史使用同一会话
const { data, pending, error, refresh } = await useAsyncData(
  `refunds-${props.invoice.id}`,
  () => api<Refund[]>(`/invoices/${props.invoice.id}/refunds`),
); // 每张账单有独立缓存键
const open = ref(false);
const busy = ref(false);
const message = ref(""); // 填写过程保留在抽屉内
const value = ref("");
const reason = ref(""); // 用户以元填写，不要求理解分单位
const attempts = new Map<string, string>(); // 相同申请的网络重试复用标识
const refundable = computed(() =>
  (
    BigInt(props.invoice.amountCents) -
    (data.value || [])
      .filter((item) => !["rejected", "failed"].includes(item.status))
      .reduce((total, item) => total + BigInt(item.amountCents), 0n)
  ).toString(),
); // 待审批与未知结果继续占用额度
const columns = [
  { key: "amountCents", label: "退款金额" },
  { key: "status", label: "进展" },
  { key: "reason", label: "申请原因" },
  { key: "createdAt", label: "申请日期" },
]; // 历史只展示实际保存事实
function begin() {
  value.value = amount(
    refundable.value,
    props.invoice.currency,
    props.invoice.currencyDecimals,
  );
  reason.value = "";
  message.value = "";
  open.value = true;
} // 默认填当前剩余额度，提交前仍可修改
/** 创建退款申请；申请保存不等于机构已经退款。 */
async function submit() {
  // 金额与原因在表单入口整理一次
  busy.value = true;
  message.value = ""; // 防止同一次申请重复点击
  try {
    // 外部和本地输入错误都留在当前抽屉
    const body = {
      amountCents: toCents(
        value.value,
        false,
        props.invoice.currency,
        props.invoice.currencyDecimals,
      ),
      reason: reason.value.trim(),
    }; // 全程使用字符串和BigInt转换
    const fingerprint = JSON.stringify(body); // 换金额或原因时生成新的申请标识
    const key = attempts.get(fingerprint) || crypto.randomUUID(); // 超时重试不会预留第二份退款额度
    attempts.set(fingerprint, key); // 请求发出前先记住这次意图
    await api(`/invoices/${props.invoice.id}/refunds`, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key },
    }); // 可退额度和权限由API最终核对
    attempts.delete(fingerprint);
    open.value = false;
    await refresh(); // 成功保存后读取真实历史
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 不把未确认结果显示为退款成功
    busy.value = false;
  } // 失败时可以修正并重试
}
</script>
<template>
  <section class="panel mt-8">
    <header class="panel-header">
      <div>
        <h2>退款记录</h2>
        <p v-if="!pending && !error" class="form-hint">
          可申请
          {{
            money(refundable, invoice.currency, invoice.currencyDecimals)
          }}，待处理的申请会占用可退额度。
        </p>
      </div>
      <KimaButton
        variant="tonal"
        :disabled="busy || pending || !!error || BigInt(refundable) <= 0n"
        @click="begin"
      >
        申请退款
      </KimaButton>
    </header>
    <KimaAlert v-if="busy && !open" class="mx-6 mb-5"
      >退款申请正在提交，请等待本次结果。</KimaAlert
    >
    <KimaAlert v-if="message && !open" variant="danger" class="mx-6 mb-5">{{
      message
    }}</KimaAlert>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <KimaTable
      v-if="data?.length && !pending && !error"
      :columns="columns"
      :rows="data"
      row-key="id"
    >
      <template #cell-amountCents="{ value }">
        <span class="numbers">{{
          money(value, invoice.currency, invoice.currencyDecimals)
        }}</span>
      </template>
      <template #cell-status="{ row }">
        <StatusBadge :status="row.status" />
        <p v-if="row.decisionReason || row.lastError" class="form-hint">
          {{ row.decisionReason || row.lastError }}
        </p>
      </template>
      <template #cell-createdAt="{ value }">{{ date(value) }}</template>
    </KimaTable>
    <p v-if="!pending && !error && !data?.length" class="content-padding muted">
      这张账单还没有退款申请。
    </p>
  </section>
  <KimaDrawer
    v-model:open="open"
    title="申请退款"
    description="申请将交由服务商审核。退款完成时间以原支付渠道确认的结果为准。"
    placement="right"
    :close-on-backdrop="!busy"
    :close-on-escape="!busy"
  >
    <form id="refund-form" class="drawer-form" @submit.prevent="submit">
      <label class="field-label">
        <span class="form-label">退款金额</span>
        <KimaTextField
          v-model="value"
          label="退款金额"
          inputmode="decimal"
          :pattern="
            currencyDecimals(invoice.currency || 'CNY') === 0
              ? '[0-9]+'
              : `[0-9]+([.][0-9]{1,${currencyDecimals(invoice.currency || 'CNY')}})?`
          "
          placeholder="29.00"
          :hint="`当前可申请 ${money(refundable, invoice.currency, invoice.currencyDecimals)}`"
          required
          :disabled="busy"
        />
      </label>
      <label class="field-label">
        <span class="form-label">申请原因</span>
        <KimaTextarea
          v-model="reason"
          label="申请原因"
          :maxlength="500"
          :minlength="1"
          placeholder="请说明退款原因，方便服务商核对。"
          required
          :disabled="busy"
        />
      </label>
      <KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
    </form>
    <template #footer>
      <KimaButton variant="tonal" :disabled="busy" @click="open = false"
        >取消</KimaButton
      >
      <KimaButton type="submit" form="refund-form" :loading="busy"
        >提交申请</KimaButton
      >
    </template>
  </KimaDrawer>
</template>
