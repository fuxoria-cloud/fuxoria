<!-- 手机服务卡：完整呈现一份资源与直接动作。调用：<ServiceCard :service="service" allow-renew @renew="renew" />。 -->
<script setup lang="ts">
import type { Service } from "~/types/api"; // 与桌面使用同一服务对象，不复制一份金额或状态
import {
  canRenewService,
  serviceActionNames,
  servicePeriod,
} from "~/features/service"; // 桌面与手机共用续费条件
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
withDefaults(
  defineProps<{
    service: Service;
    allowRenew?: boolean;
    renewing?: boolean;
    disabled?: boolean;
  }>(),
  { allowRenew: false, renewing: false, disabled: false },
); // 总览卡引导管理，服务页才直接发起续费
const emit = defineEmits<{ renew: [service: Service] }>(); // 续费仍交给当前页面原有幂等请求
</script>
<template>
  <KimaCard class="mobile-record-card" :data-service-id="service.id">
    <header class="mobile-record-heading">
      <div class="mobile-record-title">
        <h3>{{ service.name || service.productName || "云服务" }}</h3>
        <p class="table-secondary numbers">{{ service.id.slice(0, 8) }}</p>
      </div>
      <StatusBadge
        :status="service.status"
        :order-status="service.orderStatus"
        context="service"
      />
    </header>
    <div v-if="service.operation" class="mobile-record-operation">
      <span>{{ serviceActionNames[service.operation.action] }}</span>
      <StatusBadge :status="service.operation.state" />
    </div>
    <p
      v-else-if="
        service.terminationRequestedAt &&
        !['terminated', 'cancelled'].includes(service.status)
      "
      class="form-hint"
    >
      终止任务处理中，当前状态以实际资源结果为准。
    </p>
    <dl class="mobile-record-details">
      <div>
        <dt>到期时间</dt>
        <dd class="numbers">{{ date(service.dueAt) }}</dd>
      </div>
      <div v-if="service.priceCents != null">
        <dt>{{ servicePeriod(service) }}价格</dt>
        <dd class="numbers">
          {{
            money(
              service.priceCents,
              service.currency,
              service.currencyDecimals,
            )
          }}
        </dd>
      </div>
      <div v-if="service.externalId" class="mobile-record-wide">
        <dt>资源标识</dt>
        <dd class="numbers mobile-record-identifier">
          {{ service.externalId }}
        </dd>
      </div>
    </dl>
    <div class="mobile-record-actions">
      <AppLink
        :to="`/console/resources/${service.id}`"
        class="inline-flex min-h-12 items-center justify-center"
        >控制与状态</AppLink
      >
      <KimaButton
        v-if="service.invoiceId"
        variant="tonal"
        :disabled="disabled"
        @click="router.push(`/console/invoices/${service.invoiceId}`)"
      >
        查看账单
      </KimaButton>
      <KimaButton
        v-if="allowRenew && canRenewService(service)"
        :disabled="disabled"
        :loading="renewing"
        @click="emit('renew', service)"
      >
        续费
      </KimaButton>
      <KimaButton
        variant="tonal"
        @click="router.push(`/console/services/${service.id}`)"
      >
        管理服务
      </KimaButton>
    </div>
  </KimaCard>
</template>
