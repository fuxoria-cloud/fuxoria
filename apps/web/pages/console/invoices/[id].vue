<!-- 账单详情：先核对真实金额，再发起支付。调用：访问 /console/invoices/<账单ID>。 -->
<script setup lang="ts">
import {
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  Shield01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons"; // 支付动作都带文字说明
import type { Invoice, Payment } from "~/types/api"; // 金额与支付方式使用后端结果
definePageMeta({ layout: "console", middleware: "account" }); // 当前会话只可读取自己的账单
useSeoMeta({ title: "账单详情", robots: "noindex, nofollow" }); // 财务信息不参与索引
const api = useApi();
const route = useRoute(); // 账单编号从路由取一次
const {
  data: invoice,
  pending,
  error,
  refresh,
} = await useAsyncData(`invoice-${route.params.id}`, () =>
  api<Invoice>(`/invoices/${route.params.id}`),
); // 服务器检查账单归属
const {
  data: payments,
  error: paymentError,
  refresh: refreshPayments,
} = await useAsyncData(
  computed(() => `payments:${invoice.value?.currency || "CNY"}`),
  () =>
    api<Payment[]>(
      `/payments?currency=${encodeURIComponent(invoice.value?.currency || "CNY")}`,
    ),
); // 只提供已配置支付方式
const gateway = ref("");
const busy = ref(false);
const message = ref(""); // 一次只创建一个收银台
const checkout = ref<{
  url?: string;
  qrCode?: string;
  reference?: string;
} | null>(null); // 保存网关返回的付款入口
const choices = computed(
  () =>
    payments.value?.filter(
      (item) =>
        item.enabled !== false &&
        item.configured !== false &&
        (item.currencies || ["CNY"]).includes(invoice.value?.currency || "CNY"),
    ) || [],
); // 不把未配置插件当成可用收款方式
const checkoutUrl = computed(() => {
  // 外部支付地址是新的信任边界
  if (!checkout.value?.url) return ""; // 扫码网关可能没有跳转地址
  try {
    const address = new URL(checkout.value.url);
    return ["https:", "http:"].includes(address.protocol) ? address.href : "";
  } catch {
    // 禁止脚本协议
    return "";
  } // 无效网关地址留在当前页并展示原因
});
watch(
  choices,
  (list) => {
    if (!gateway.value && list.length) gateway.value = list[0]!.id;
  },
  { immediate: true },
); // 默认选第一个真实可用网关
/** 发起支付；实际入账只由服务端验证回调后完成。 */
async function pay() {
  // 支付按钮的唯一入口
  busy.value = true;
  message.value = ""; // 防止用户连续发起支付
  try {
    // 支付错误紧贴当前动作显示
    checkout.value = await api<{
      url?: string;
      qrCode?: string;
      reference?: string;
    }>(`/invoices/${route.params.id}/checkout`, {
      method: "POST",
      body: { gateway: gateway.value },
    }); // 价格和账单状态由服务端再次确认
    if (!checkoutUrl.value && !checkout.value?.qrCode)
      message.value = "支付网关暂未提供可用的付款入口，请联系支持。"; // 创建请求不代表支付成功
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 保留账单，方便用户重新尝试
    busy.value = false;
  } // 支付入口建立后恢复操作
}
const paymentOptions = computed(() =>
  choices.value.map((item) => ({ value: item.id, label: item.name })),
); // 真实可用网关成为单选项
const itemColumns = [
  { key: "productName", label: "产品" },
  { key: "quantity", label: "数量" },
  { key: "unitPriceCents", label: "单价" },
  { key: "amountCents", label: "小计" },
]; // 每个价格都使用服务器保存的成交明细
</script>
<template>
  <div>
    <AppLink to="/console/invoices" :underline="false" class="auth-back mb-6">
      <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
      返回账单
    </AppLink>
    <header class="page-heading">
      <div>
        <h1>账单详情</h1>
        <p>付款前，花一点时间确认这笔账单。</p>
      </div>
      <KimaButton variant="tonal" :disabled="pending" @click="refresh()">
        <template #leading><KimaIcon :icon="Refresh01Icon" /></template>
        刷新状态
      </KimaButton>
    </header>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <KimaAlert
      v-if="invoice?.billingReview?.status === 'open' && !pending && !error"
      variant="warning"
      class="mb-6"
      heading="款项已收，需要退款核对"
    >
      资源已终止或正在终止，这笔收款不会恢复或延长资源。请通过下方退款记录申请退款，或联系支持核对处理。
    </KimaAlert>
    <KimaAlert
      v-else-if="
        invoice?.billingReview?.status === 'resolved' && !pending && !error
      "
      class="mb-6"
      heading="款项核对已处理"
    >
      {{
        invoice.billingReview.resolution ||
        "服务商已完成此款项的核对，请查看下方退款记录了解实际退款进度。"
      }}
    </KimaAlert>
    <KimaAlert
      v-if="invoice?.combinedParentId && !pending && !error"
      class="mb-6"
      heading="这张账单已合并"
    >
      原商品和金额保留在这里。<AppLink
        :to="`/console/invoices/${invoice.combinedParentId}`"
        >打开合并父账单，付款或核对退款</AppLink
      >
    </KimaAlert>
    <div v-if="invoice && !pending && !error" class="detail-grid">
      <section class="panel">
        <header class="panel-header">
          <h2>{{ invoice.number || invoice.id.slice(0, 8) }}</h2>
          <StatusBadge :status="invoice.status" />
        </header>
        <div class="content-padding">
          <dl class="detail-list">
            <dt>账单编号</dt>
            <dd class="numbers">{{ invoice.number || invoice.id }}</dd>
            <dt>创建时间</dt>
            <dd>{{ date(invoice.createdAt) }}</dd>
            <dt>付款截止</dt>
            <dd>{{ date(invoice.dueAt) }}</dd>
            <template v-if="invoice.description">
              <dt>说明</dt>
              <dd>{{ invoice.description }}</dd>
            </template>
          </dl>
          <section v-if="invoice.combinedItems?.length" class="mt-6">
            <h3>合并的原账单</h3>
            <div
              v-for="child in invoice.combinedItems"
              :key="child.id"
              class="flex flex-wrap gap-4 justify-between py-3"
            >
              <AppLink :to="`/console/invoices/${child.id}`"
                >账单 {{ child.number }}</AppLink
              ><span class="numbers">{{
                money(
                  child.amountCents,
                  invoice.currency,
                  invoice.currencyDecimals,
                )
              }}</span
              ><StatusBadge :status="child.status" />
            </div>
          </section>
          <div v-if="invoice.items?.length" class="invoice-items mt-6">
            <h3 class="mb-3">购买明细</h3>
            <KimaTable
              class="desktop-records"
              :columns="itemColumns"
              :rows="invoice.items"
              row-key="id"
            >
              <template #cell-productName="{ row }">
                <span class="table-primary">{{ row.productName }}</span>
                <span class="table-secondary">
                  {{
                    row.periodLabel ||
                    (row.period === "month" ? "月付" : row.period)
                  }}
                </span>
                <span
                  v-for="(value, label) in row.configurationLabels || {}"
                  :key="label"
                  class="table-secondary"
                  >{{ label }}：{{ value }}</span
                >
              </template>
              <template #cell-unitPriceCents="{ value }">
                <span class="numbers whitespace-nowrap">{{
                  money(value, invoice.currency, invoice.currencyDecimals)
                }}</span>
              </template>
              <template #cell-amountCents="{ value }">
                <span class="numbers whitespace-nowrap">{{
                  money(value, invoice.currency, invoice.currencyDecimals)
                }}</span>
              </template>
            </KimaTable>
            <div class="mobile-records invoice-mobile-items">
              <KimaCard
                v-for="item in invoice.items"
                :key="item.id"
                class="mobile-record-card"
                :data-order-item-id="item.id"
              >
                <div class="mobile-record-title">
                  <h3>{{ item.productName }}</h3>
                </div>
                <p class="muted numbers mt-3">
                  {{ item.quantity }} ×
                  {{
                    money(
                      item.unitPriceCents,
                      invoice.currency,
                      invoice.currencyDecimals,
                    )
                  }}
                  ·
                  {{
                    item.periodLabel ||
                    (item.period === "month" ? "月付" : item.period)
                  }}
                </p>
                <p
                  v-for="(value, label) in item.configurationLabels || {}"
                  :key="label"
                  class="muted text-sm mt-2"
                >
                  {{ label }}：{{ value }}
                </p>
                <div class="mobile-record-total">
                  <span class="muted">小计</span>
                  <strong class="numbers">{{
                    money(
                      item.amountCents,
                      invoice.currency,
                      invoice.currencyDecimals,
                    )
                  }}</strong>
                </div>
              </KimaCard>
            </div>
          </div>
          <div class="invoice-total">
            <span class="muted">账单金额</span>
            <strong>{{
              money(
                invoice.amountCents,
                invoice.currency,
                invoice.currencyDecimals,
              )
            }}</strong>
          </div>
        </div>
      </section>
      <section class="panel">
        <header class="panel-header">
          <h2>
            {{
              invoice.billingReview?.status === "open"
                ? "款项待核对"
                : invoice.status === "paid"
                  ? "付款已完成"
                  : invoice.payable === false
                    ? "暂时无法付款"
                    : "选择付款方式"
            }}
          </h2>
          <KimaIcon :icon="Shield01Icon" class="text-brand" />
        </header>
        <div class="content-padding">
          <template
            v-if="invoice.status === 'unpaid' && invoice.payable !== false"
          >
            <RequestState
              v-if="paymentError"
              :error="paymentError"
              @retry="refreshPayments"
            />
            <KimaRadioGroup
              v-else-if="choices.length"
              v-model="gateway"
              label="付款方式"
              :options="paymentOptions"
              name="gateway"
            />
            <p v-else class="muted">暂时没有可用的支付方式，请联系支持。</p>
            <KimaAlert v-if="message" variant="danger" class="mt-5">{{
              message
            }}</KimaAlert>
            <KimaButton
              v-if="choices.length && !checkout"
              class="w-full mt-6"
              :disabled="!gateway"
              :loading="busy"
              @click="pay"
            >
              确认金额，去付款
            </KimaButton>
            <div v-if="checkout" class="text-center mt-6">
              <KimaQrCode
                v-if="checkout.qrCode"
                :value="checkout.qrCode"
                :size="240"
                label="使用对应支付应用扫描此付款二维码"
              />
              <KimaLink
                v-if="checkoutUrl"
                :href="checkoutUrl"
                target="_blank"
                :underline="false"
                class="payment-link mt-4"
              >
                打开付款页面
                <KimaIcon :icon="ArrowUpRight01Icon" />
              </KimaLink>
              <p class="form-hint mt-4">完成付款后，点击“刷新状态”确认入账。</p>
              <KimaButton
                variant="text"
                class="w-full mt-3"
                :loading="busy"
                @click="pay"
              >
                重新获取付款入口
              </KimaButton>
            </div>
            <WalletPayment
              v-if="invoice.kind !== 'recharge'"
              :invoice="invoice"
              @paid="refresh"
            />
            <CreditPayment :invoice="invoice" @paid="refresh" />
          </template>
          <p v-else-if="invoice.status === 'unpaid'" class="muted">
            {{
              invoice.paymentMessage || "当前账单暂时无法付款，请联系支持核对。"
            }}
          </p>
          <p v-else-if="invoice.billingReview?.status === 'open'" class="muted">
            款项已经入账，资源交付已停止。这笔款项需要退款核对，页面不会将它显示为服务已经续费。
          </p>
          <p
            v-else-if="invoice.status === 'paid' && invoice.paidWithCredit"
            class="muted"
          >
            这笔业务账单已使用信用额度结清，请在“信用额度”查看还款账期。
          </p>
          <p
            v-else-if="invoice.status === 'paid' && invoice.kind === 'recharge'"
            class="muted"
          >
            充值已到账，可在“账户余额”核对余额和流水。
          </p>
          <p
            v-else-if="
              invoice.status === 'paid' && invoice.kind === 'credit_repayment'
            "
            class="muted"
          >
            还款已到账，对应应收款已结清，可在“信用额度”查看更新后的可用额度。
          </p>
          <p v-else-if="invoice.status === 'paid'" class="muted">
            这笔账单已完成付款。服务的开通进度可以在“我的服务”中查看。
          </p>
          <p v-else class="muted">当前账单已取消，无需付款。</p>
          <AppLink
            to="/console/tickets?new=1"
            :underline="false"
            class="panel-link mt-6"
          >
            对账单有疑问？联系支持
            <KimaIcon :icon="ArrowUpRight01Icon" :size="20" />
          </AppLink>
        </div>
      </section>
    </div>
    <Refunds
      v-if="
        invoice?.status === 'paid' &&
        invoice.refundable !== false &&
        !pending &&
        !error
      "
      :invoice="invoice"
    />
  </div>
</template>
