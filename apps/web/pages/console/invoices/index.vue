<!-- 账单列表：金额保留到分，详情页负责支付。调用：访问 /console/invoices。 -->
<script setup lang="ts">
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"; // 详情操作使用清楚的文字
import type { Invoice } from "~/types/api"; // 所有金额由 API 返回
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: "console", middleware: "account" }); // 私有账单按用户隔离
useSeoMeta({ title: "账单", robots: "noindex, nofollow" }); // 不把财务信息交给搜索引擎
const api = useApi(); // 复用统一的会话请求
const { data, pending, error, refresh } = await useAsyncData("invoices", () =>
  api<Invoice[]>("/invoices"),
); // 账单读错时不回退示例金额
const filter = ref("all"); // 页面筛选不改变后端账单
const shown = computed(
  () =>
    data.value?.filter(
      (item) => filter.value === "all" || item.status === filter.value,
    ) || [],
); // 同一份数据推导筛选视图
const columns = [
  { key: "number", label: "账单编号" },
  { key: "amountCents", label: "金额" },
  { key: "status", label: "状态" },
  { key: "createdAt", label: "创建日期" },
  { key: "action", label: "操作" },
]; // 列表先让用户找到对应账单
const filters = [
  { value: "all", label: "全部账单" },
  { value: "unpaid", label: "待付款" },
  { value: "paid", label: "已付款" },
  { value: "cancelled", label: "已取消" },
]; // 筛选组件负责键盘操作
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>每一笔，都清楚。</h1>
        <p>查看账单，核对金额，再从容安排付款。</p>
      </div>
    </header>
    <section class="panel">
      <header class="panel-header">
        <h2>我的账单</h2>
        <KimaSelect
          v-model="filter"
          label="筛选账单状态"
          :items="filters"
          class="invoice-filter"
        />
      </header>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="!shown.length && !pending && !error"
        title="这里还没有账单"
        description="新的购买、续费账单会保存在这里。"
        @retry="refresh"
      />
      <KimaTable
        class="desktop-records"
        v-if="shown.length && !pending && !error"
        :columns="columns"
        :rows="shown"
        row-key="id"
        hoverable
      >
        <template #cell-number="{ row }">
          <span class="table-primary">{{
            row.number || row.id.slice(0, 8)
          }}</span>
          <span v-if="row.description" class="table-secondary">{{
            row.description
          }}</span>
          <span
            v-if="row.billingReview?.status === 'open'"
            class="table-secondary"
          >
            款项已收，需要退款核对
          </span>
          <span v-else-if="row.paymentMessage" class="table-secondary">
            {{ row.paymentMessage }}
          </span>
        </template>
        <template #cell-amountCents="{ value, row }">
          <span class="numbers">{{
            money(value, row.currency, row.currencyDecimals)
          }}</span>
        </template>
        <template #cell-status="{ value }"
          ><StatusBadge :status="value"
        /></template>
        <template #cell-createdAt="{ value }">
          <span class="numbers whitespace-nowrap">{{ date(value) }}</span>
        </template>
        <template #cell-action="{ row }">
          <KimaButton
            variant="tonal"
            @click="router.push(`/console/invoices/${row.id}`)"
          >
            {{
              row.status === "unpaid" && row.payable !== false
                ? "去付款"
                : "查看"
            }}
            <template #trailing
              ><KimaIcon :icon="ArrowRight01Icon" :size="20"
            /></template>
          </KimaButton>
        </template>
      </KimaTable>
      <div v-if="shown.length && !pending && !error" class="mobile-records">
        <InvoiceCard
          v-for="invoice in shown"
          :key="invoice.id"
          :invoice="invoice"
        />
      </div>
    </section>
  </div>
</template>
