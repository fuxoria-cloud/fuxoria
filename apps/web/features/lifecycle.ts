/* 服务管理的浏览器合同。调用：import type { ManagedService } from '~/features/lifecycle'。 */
import type { Service, BillingPeriod } from "~/types/api";
export interface ManagedService extends Service {
  billingPeriod: BillingPeriod;
  billingMonths: number;
  configurationLabels: Record<string, string>;
  groupId: string | null;
  remark: string;
  autoRenew: boolean;
  autoRenewWindowSeconds?: number;
  email?: string | null;
  provider?: string;
  suspendType?: string;
  suspendReason?: string;
}
export interface ServiceGroup {
  id: string;
  name: string;
  sort: number;
}
export interface Cancellation {
  id: string;
  serviceId: string;
  serviceName: string;
  mode: "immediate" | "end_of_period";
  reason: string;
  status: string;
  decisionReason: string | null;
  executeAt: string | null;
  jobId: string | null;
  createdAt: string;
  email?: string | null;
  phone?: string;
}
export interface ServiceTransfer {
  id: string;
  serviceId: string;
  serviceName: string;
  senderId: string;
  recipientId: string;
  senderEmail: string | null;
  senderPhone?: string;
  recipientEmail: string | null;
  recipientPhone?: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}
export const cancellationNames: Record<string, string> = {
  pending: "等待审核",
  approved: "已批准，等待到期",
  executing: "正在终止",
  executed: "已经终止",
  rejected: "未批准",
  withdrawn: "已撤回",
  failed: "执行异常",
};
export const transferNames: Record<string, string> = {
  pending: "等待接收",
  accepted: "已接收",
  rejected: "已拒绝",
  cancelled: "已撤销",
  expired: "已过期",
};
export const periodNames: Record<string, string> = {
  hour: "时付",
  day: "日付",
  ontrial: "试用",
  month: "月付",
  quarter: "季付",
  halfyear: "半年付",
  year: "年付",
  biennium: "两年付",
  triennium: "三年付",
  onetime: "一次性",
};
export interface ServiceUpgrade {
  currencyDecimals?: number;
  currency: string;

  id: string;
  serviceId: string;
  productId: string;
  productName: string;
  configuration: Record<string, string | number | boolean>;
  configurationLabels: Record<string, string>;
  oldRenewCents: string;
  renewAmountCents: string;
  amountCents: string;

  period: string;
  sourcePeriod: string;
  cycleChange: boolean;
  remainingMs: string;
  periodMs: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  appliedAt: string | null;
  orderId: string | null;
  invoiceId: string | null;
  jobId: string | null;
  jobState: string | null;
  jobError: string | null;
  email?: string | null;
  phone?: string;
}
export const upgradeNames: Record<string, string> = {
  quoted: "报价待确认",
  unpaid: "等待支付",
  queued: "正在变更",
  succeeded: "变更已完成",
  review: "款项待核对",
  cancelled: "已取消",
};
