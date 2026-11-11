<!-- 工作台总览：汇总真实服务、账单与工单，不生成模拟指标。调用：访问 /console。 -->
<script setup lang="ts">
import {
  Add01Icon,
  ServerStack01Icon,
  Invoice01Icon,
  MessageMultiple01Icon,
  Wallet01Icon,
  ArrowRight01Icon,
  HelpCircleIcon,
} from "@hugeicons/core-free-icons"; // 常用任务在同一位置表达
import type { Overview } from "~/types/api"; // 总览字段来自后端统一统计
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: "console", middleware: "account" }); // 登录后才能读取个人统计
useSeoMeta({ title: "工作台", robots: "noindex, nofollow" }); // 私有数据不参与索引
const api = useApi();
const account = useAccount(); // 身份与业务数据独立读取
const { data, pending, error, refresh } = await useAsyncData("overview", () =>
  api<Overview>("/overview"),
); // 后端保证统计口径一致
const columns = [
  { key: "number", label: "账单" },
  { key: "amountCents", label: "金额" },
  { key: "status", label: "状态" },
  { key: "action", label: "操作" },
]; // 同一行看清金额与支付状态
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>{{ account.user.value?.name || "你好" }}，今天也从容一点。</h1>
        <p>服务、账单和待办，都在这里。</p>
      </div>
      <KimaButton @click="router.push('/products')">
        <template #leading><KimaIcon :icon="Add01Icon" /></template>
        选购产品
      </KimaButton>
    </header>
    <RequestState :pending="pending" :error="error" @retry="refresh" />
    <template v-if="data && !pending && !error">
      <section class="stat-grid" aria-label="账户概况">
        <KimaCard class="stat-card">
          <div class="stat-top">
            我的服务
            <KimaIcon :icon="ServerStack01Icon" />
          </div>
          <p class="stat-value">{{ data.serviceCount }}</p>
          <p class="stat-sub">查看每一份云上空间</p>
        </KimaCard>
        <KimaCard class="stat-card">
          <div class="stat-top">
            待付账单
            <KimaIcon :icon="Invoice01Icon" />
          </div>
          <p class="stat-value">{{ data.unpaidCount }}</p>
          <p class="stat-sub">核对后再安心付款</p>
        </KimaCard>
        <KimaCard class="stat-card">
          <div class="stat-top">
            支持工单
            <KimaIcon :icon="MessageMultiple01Icon" />
          </div>
          <p class="stat-value">{{ data.ticketCount }}</p>
          <p class="stat-sub">每次沟通，都有记录</p>
        </KimaCard>
        <KimaCard class="stat-card">
          <div class="stat-top">
            账户余额（CNY）
            <KimaIcon :icon="Wallet01Icon" />
          </div>
          <p class="stat-value">
            {{ money(data.balanceCents, data.currency || "CNY") }}
          </p>
          <p class="stat-sub">以账户账本为准</p>
        </KimaCard>
      </section>
      <section v-if="data.totals?.length" class="panel content-padding mb-6">
        <h2>各币种账户</h2>
        <div class="grid grid-cols-1 gap-4 mt-4 sm:grid-cols-2">
          <article v-for="entry in data.totals" :key="entry.currency">
            <h3>
              {{ entry.currency }} · 可用
              {{
                money(
                  entry.availableCents,
                  entry.currency,
                  entry.currencyDecimals,
                )
              }}
            </h3>
            <p class="form-hint">
              总余额
              {{
                money(
                  entry.walletCents,
                  entry.currency,
                  entry.currencyDecimals,
                )
              }}<template v-if="entry.heldCents !== '0'"
                >，退款预留
                {{
                  money(entry.heldCents, entry.currency, entry.currencyDecimals)
                }}</template
              ><template
                v-if="entry.receivableCents && entry.receivableCents !== '0'"
                >，信用未还
                {{
                  money(
                    entry.receivableCents,
                    entry.currency,
                    entry.currencyDecimals,
                  )
                }}</template
              >
            </p>
          </article>
        </div>
      </section>
      <div class="dashboard-grid">
        <section class="panel">
          <header class="panel-header">
            <h2>最近账单</h2>
            <AppLink
              to="/console/invoices"
              :underline="false"
              class="panel-link"
            >
              全部账单
              <KimaIcon :icon="ArrowRight01Icon" :size="20" />
            </AppLink>
          </header>
          <RequestState
            :empty="!data.recentInvoices.length"
            title="账单会在这里出现"
            description="选好产品后，先核对账单，再选择付款方式。"
          />
          <KimaTable
            class="desktop-records"
            v-if="data.recentInvoices.length"
            :columns="columns"
            :rows="data.recentInvoices"
            row-key="id"
          >
            <template #cell-number="{ row }">
              <span class="table-primary">{{
                row.number || row.id.slice(0, 8)
              }}</span>
              <span class="table-secondary">{{ date(row.createdAt) }}</span>
            </template>
            <template #cell-amountCents="{ value, row }">
              <span class="numbers">{{
                money(value, row.currency, row.currencyDecimals)
              }}</span>
            </template>
            <template #cell-status="{ value }"
              ><StatusBadge :status="value"
            /></template>
            <template #cell-action="{ row }">
              <KimaButton
                variant="text"
                @click="router.push(`/console/invoices/${row.id}`)"
              >
                查看
              </KimaButton>
            </template>
          </KimaTable>
          <div v-if="data.recentInvoices.length" class="mobile-records">
            <InvoiceCard
              v-for="invoice in data.recentInvoices"
              :key="invoice.id"
              :invoice="invoice"
            />
          </div>
        </section>
        <section class="panel">
          <header class="panel-header">
            <h2>最近服务</h2>
            <AppLink
              to="/console/services"
              :underline="false"
              class="panel-link"
            >
              全部服务
              <KimaIcon :icon="ArrowRight01Icon" :size="20" />
            </AppLink>
          </header>
          <RequestState
            :empty="!data.recentServices.length"
            title="还没有服务"
            description="为你的下一个想法挑选一份资源。"
          />
          <div
            v-if="data.recentServices.length"
            class="service-list desktop-records"
          >
            <article
              v-for="service in data.recentServices"
              :key="service.id"
              class="service-row"
            >
              <span class="service-picture"
                ><KimaIcon :icon="ServerStack01Icon"
              /></span>
              <div>
                <h3>{{ service.name || service.productName || "云服务" }}</h3>
                <p>到期 {{ date(service.dueAt) }}</p>
              </div>
              <StatusBadge
                :status="service.status"
                :order-status="service.orderStatus"
                context="service"
              />
            </article>
          </div>
          <div v-if="data.recentServices.length" class="mobile-records">
            <ServiceCard
              v-for="service in data.recentServices"
              :key="service.id"
              :service="service"
            />
          </div>
        </section>
      </div>
      <KimaCard class="help-strip">
        <div class="support-content">
          <KimaIcon :icon="HelpCircleIcon" :size="32" />
          <div>
            <h3>遇到小麻烦？我们一起看看。</h3>
            <p>把问题写进工单，后续回复会保存在同一处。</p>
          </div>
          <KimaButton
            variant="tonal"
            @click="router.push('/console/tickets?new=1')"
          >
            联系支持
            <template #trailing><KimaIcon :icon="ArrowRight01Icon" /></template>
          </KimaButton>
        </div>
      </KimaCard>
    </template>
  </div>
</template>
