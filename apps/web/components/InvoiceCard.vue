<!-- 手机账单卡：把金额和入口留在同一视口。调用：<InvoiceCard :invoice="invoice" />。 -->
<script setup lang="ts">
import type { Invoice } from "~/types/api"; // 列表与总览共享真实账单对象
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
defineProps<{ invoice: Invoice }>(); // 卡片不自行计算应付价格或付款状态
</script>
<template>
  <KimaCard class="mobile-record-card" :data-invoice-id="invoice.id">
    <header class="mobile-record-heading">
      <div class="mobile-record-title">
        <p class="muted text-sm">账单编号</p>
        <h3 class="numbers">{{ invoice.number || invoice.id.slice(0, 8) }}</h3>
      </div>
      <StatusBadge :status="invoice.status" />
    </header>
    <p v-if="invoice.description" class="mobile-record-description">
      {{ invoice.description }}
    </p>
    <dl class="mobile-record-details">
      <div>
        <dt>创建日期</dt>
        <dd>{{ date(invoice.createdAt) }}</dd>
      </div>
      <div v-if="invoice.dueAt">
        <dt>付款截止</dt>
        <dd>{{ date(invoice.dueAt) }}</dd>
      </div>
    </dl>
    <KimaAlert
      v-if="invoice.billingReview?.status === 'open'"
      variant="warning"
      class="mt-4"
    >
      款项已收，需要退款核对。
    </KimaAlert>
    <p v-else-if="invoice.paymentMessage" class="form-hint">
      {{ invoice.paymentMessage }}
    </p>
    <div class="mobile-record-total">
      <span class="muted">账单金额</span>
      <strong class="numbers">{{
        money(invoice.amountCents, invoice.currency, invoice.currencyDecimals)
      }}</strong>
    </div>
    <KimaButton
      class="w-full mt-5"
      variant="tonal"
      @click="router.push(`/console/invoices/${invoice.id}`)"
    >
      查看账单
    </KimaButton>
  </KimaCard>
</template>
