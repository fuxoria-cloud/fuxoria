/*
浏览器使用的 API 字段：对应 /api/v1 返回值。调用：import type { Product } from '~/types/api'。
金额以分为单位保留十进制字符串，展示时再格式化，浏览器不计算交易金额。
*/
export interface User {
  id: string;
  email: string | null;
  phone?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  name: string;
  role: string;
  actorId?: string;
  ownerId?: string;
  delegated?: boolean;
} // 当前登录者
export type BillingPeriod =
  | "hour"
  | "day"
  | "ontrial"
  | "month"
  | "quarter"
  | "halfyear"
  | "year"
  | "biennium"
  | "triennium"
  | "onetime";
export type ProductConfiguration = Record<string, string | number | boolean>;
export interface ProductOption {
  key: string;
  name: string;
  kind: "select" | "quantity" | "boolean";
  required: boolean;
  minimum: number;
  maximum: number;
  prices: Partial<Record<BillingPeriod, string>>;
  setupCents: string;
  choices: {
    value: string;
    label: string;
    prices: Partial<Record<BillingPeriod, string>>;
    setupCents: string;
  }[];
  hidden?: boolean;
  allowedValues?: (string | number | boolean)[];
}
export interface Product {
  currencyDecimals?: number;
  currency: string;

  id: string;
  name: string;
  description: string;
  priceCents: string;

  trialDays?: number;
  stock?: number;
  provider?: string;
  active?: boolean;
  groupId?: string | null;
  periods?: {
    period: BillingPeriod;
    priceCents: string;
    setupCents: string;
    active: boolean;
  }[];
  options?: ProductOption[];
} // 可购买产品
export interface Invoice {
  currencyDecimals?: number;
  currency?: string;
  kind?: string;
  creditEligible?: boolean;
  paidWithCredit?: boolean;
  refundable?: boolean;
  combinedParentId?: string | null;
  combinedCount?: number;
  combinedItems?: {
    id: string;
    number: string;
    amountCents: string;
    status: string;
  }[];
  id: string;
  number?: string;
  status: string;
  amountCents: string;
  createdAt: string;
  dueAt?: string;
  productName?: string;
  description?: string;
  items?: OrderItem[];
  itemCount?: number;
  payable?: boolean;
  paymentMessage?: string | null;
  billingReview?: {
    id: string;
    reason: string;
    status: "open" | "resolved";
    resolution: string | null;
    createdAt: string;
    resolvedAt: string | null;
  } | null;
} // 一张账单
export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  quantity: number;
  period: BillingPeriod;
  periodLabel?: string;
  lineId?: string;
  configuration?: ProductConfiguration;
  configurationLabels?: Record<string, string>;
  originalUnitPriceCents?: string;
  discountCents?: string;
  setupCents?: string;
  billingMonths?: number;
  billingSeconds?: number;
  autoRenewWindowSeconds?: number;
  unitPriceCents: string;
  amountCents: string;
  serviceIds: string[];
} // 原订单明细保留成交时的名称和价格
export interface Service {
  currencyDecimals?: number;
  id: string;
  name?: string;
  productName?: string;
  status: string;
  orderStatus?: "unpaid" | "paid" | "cancelled";
  invoiceId?: string | null;
  priceCents?: string;
  currency?: string;
  dueAt?: string;
  nextDueAt?: string;
  expiresAt?: string;
  createdAt: string;
  address?: string;
  externalId?: string;
  terminationRequestedAt?: string | null;
  billingPeriod?: BillingPeriod;
  billingMonths?: number;
  billingSeconds?: number;
  autoRenewWindowSeconds?: number;
  configurationLabels?: Record<string, string>;
  groupId?: string | null;
  remark?: string;
  autoRenew?: boolean;
  operation?: {
    id: string;
    action:
      | "provision"
      | "renew"
      | "upgrade"
      | "suspend"
      | "resume"
      | "terminate"
      | "upgrade";
    state: "queued" | "running" | "waiting" | "manual_review";
    createdAt: string;
  } | null;
} // 已购买服务
export interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt?: string;
  replies?: Reply[];
} // 支持工单
export interface Reply {
  id: string;
  message: string;
  createdAt: string;
  authorName?: string;
  name?: string;
  role?: string;
} // 一条工单回复
export interface Payment {
  currencies?: string[];
  id: string;
  name: string;
  enabled?: boolean;
  configured?: boolean;
} // 可使用支付方式
export interface Overview {
  serviceCount: number;
  unpaidCount: number;
  ticketCount: number;
  balanceCents: string;
  currency?: string;
  totals?: {
    currency: string;
    walletCents: string;
    heldCents: string;
    availableCents: string;
    receivableCents?: string;
    currencyDecimals?: number;
  }[];
  recentInvoices: Invoice[];
  recentServices: Service[];
} // 首页真实汇总
export interface Article {
  id: string;
  slug: string;
  title: string;
  content: string;
  kind: "help" | "news" | "page";
  published: boolean;
  updatedAt: string;
} // 公开文章与管理编辑使用同一字段
export interface Refund {
  id: string;
  invoiceId: string;
  amountCents: string;
  currency: string;
  reason: string;
  status: string;
  providerStatus: string;
  providerReference?: string;
  decisionReason?: string;
  lastError?: string;
  createdAt: string;
} // 退款申请与机构结果分开表达
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
} // 管理列表使用服务端明确分页

export interface CartItem {
  currencyDecimals?: number;
  currency?: string;
  productId: string;
  productName: string;
  quantity: number;
  period: BillingPeriod;
  periodLabel?: string;
  lineId?: string;
  configuration?: ProductConfiguration;
  configurationLabels?: Record<string, string>;
  originalUnitPriceCents?: string;
  discountCents?: string;
  unitPriceCents: string | null;
  amountCents: string | null;
  problem?: string;
  stock: number | null;
  available: boolean;
} // 每项金额以服务端当前报价为准
export interface Cart {
  currencyDecimals?: number;
  revision: string | null;
  items: CartItem[];
  amountCents: string | null;
  currency: string;
  canCheckout: boolean;
  discountCents?: string;
  promotionCode?: string | null;
  promotionProblem?: string | null;
} // 修订号绑定本次用户看到的内容
export interface CartOrder {
  currencyDecimals?: number;
  id: string;
  invoiceId: string;
  serviceId?: string;
  serviceIds?: string[];
  items?: OrderItem[];
  amountCents: string;
  currency: string;
  status: string;
  orderConfirmed?: boolean;
  cartChanged?: boolean;
  cartCleared?: boolean;
  message?: string;
} // 订单创建与Redis购物车同步的结果分别表达
