<!-- 业务状态：直接使用KIMA芯片，文字始终说明状态含义。调用：<StatusBadge status="unpaid" />。 -->
<script setup lang="ts">
const props = defineProps<{ status: string; context?: 'service'; orderStatus?: string }>(); // 服务待处理时还要区分是否已经付费
const names: Record<string, string> = {
  waiting: '等待供应商回调',
  billing_review: '等待款项核对',
  resolved: '核对已处理',
  skipped: '已跳过 / 未执行',
  requested: '待审核',
  approved: '已批准',
  processing: '机构处理中',
  manual_review: '等待核对',
  rejected: '已拒绝',
  unsupported: '渠道不支持',
  unknown: '结果未确认',
  not_requested: '尚未发送',
  unverified: '尚未核实',
  not_paid: '机构未收款',
  active: '运行中',
  pending: '处理中',
  provisioning: '开通中',
  unpaid: '待付款',
  paid: '已付款',
  cancelled: '已取消',
  suspended: '已暂停',
  terminated: '已终止',
  open: '等待回复',
  answered: '已回复',
  closed: '已关闭',
  running: '执行中',
  queued: '等待执行',
  succeeded: '已完成',
  failed: '失败',
  enabled: '已启用',
  disabled: '未启用',
}; // 未知状态保留原文便于定位
const tone = computed(() =>
  ['active', 'paid', 'succeeded', 'enabled'].includes(props.status)
    ? 'good'
    : ['failed', 'terminated', 'cancelled', 'rejected'].includes(props.status)
      ? 'bad'
      : 'neutral',
); // 颜色只辅助文字
const label = computed(() => {
  if (props.context !== 'service') return names[props.status] || props.status; // 账单与任务沿用各自真实状态
  if (props.status === 'cancelled') return '已终止'; // 服务取消表示资源终止，不能与账单取消混用
  if (props.status !== 'pending') return names[props.status] || props.status; // 运行、暂停和开通中无需推断
  if (props.orderStatus === 'unpaid') return '待付款'; // 未入账资源不让客户误以为已经开通排队
  if (props.orderStatus === 'paid') return '待开通'; // 已入账而未交付明确等待开通
  return props.orderStatus === 'cancelled' ? '订单已取消' : '待确认'; // 缺少付款事实时不宣称正在处理
});
</script>
<template>
  <KimaChip :class="`status-${tone}`">
    <span class="status-badge">
      <span class="status-dot" aria-hidden="true" />
      {{ label }}
    </span>
  </KimaChip>
</template>
