<!-- 管理后台总览：保留/admin入口，具体业务管理页与本页同级。调用：管理员访问/admin?tab=products。 -->
<script setup lang="ts">
import type { Article, Refund } from "~/types/api"; // 财务和内容使用各自的业务合同
import type { FactorInput } from "~/features/factor"; // 所有安全操作选择一种身份因素
import {
  ArrowLeft01Icon,
  Add01Icon,
  Refresh01Icon,
  UserGroupIcon,
  ServerStack01Icon,
  Invoice01Icon,
  Task01Icon,
  PuzzleIcon,
  Clock01Icon,
} from "@hugeicons/core-free-icons"; // 后台沿用客户区的图标与组件
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: "console", middleware: ["account", "admin"] }); // 前端分流体验，后端仍验证管理员角色
useSeoMeta({ title: "管理后台", robots: "noindex, nofollow" }); // 运营与审计数据不索引
const api = useApi();
const route = useRoute(); // 当前视图由可分享的查询参数决定
const tabs = [
  { id: "overview", label: "概况" },
  { id: "products", label: "产品" },
  { id: "services", label: "服务" },
  { id: "orders", label: "订单" },
  { id: "receipts", label: "收款流水" },
  { id: "refunds", label: "退款" },
  { id: "billing-reviews", label: "款项核对" },
  { id: "content", label: "公告与帮助" },
  { id: "users", label: "客户" },
  { id: "jobs", label: "开通任务" },
  { id: "audit", label: "操作审计" },
  { id: "plugins", label: "插件" },
]; // 固定视图直接列明，无隐藏事件分发
const tab = computed(() =>
  tabs.some((item) => item.id === route.query.tab)
    ? String(route.query.tab)
    : "overview",
); // 未知地址回到概况
const pageNumber = ref(1); // 资金清单的页码由服务器控制
watch(
  tab,
  () => {
    pageNumber.value = 1;
  },
  { flush: "sync" },
); // 切换主体从第一页读取，不沿用上一张清单的页码
const paged = computed(() =>
  ["receipts", "refunds", "billing-reviews"].includes(tab.value),
); // 金融清单返回items，不当成概况指标
const endpoint = computed(
  () =>
    `/admin/${tab.value}${paged.value ? `?page=${pageNumber.value}&limit=50` : ""}`,
); // 商品展示复用客户侧的同一数据源
const { data, pending, error, refresh } = await useAsyncData(
  computed(() => `admin-records:${endpoint.value}`),
  () =>
    api<Record<string, unknown>[] | Record<string, unknown>>(endpoint.value),
); // 每个目标拥有独立请求，慢回包不能阻塞或覆盖刚切换的清单
const records = computed<Record<string, unknown>[]>(() =>
  Array.isArray(data.value)
    ? data.value
    : Array.isArray(data.value?.items)
      ? data.value.items
      : [],
); // 各清单接口返回数组
const delivery = reactive<Record<string, string>>({}); // 每个人工任务分别输入真实资源标识或处理说明
const actionError = ref("");
const actionBusy = ref(""); // 任务操作错误留在任务列表旁
const creating = ref(false);
const busy = ref(false);
const message = ref(""); // 创建产品使用页内表单
const editingProduct = ref(""); // 编辑始终复用同一产品表单
const product = reactive({
  name: "",
  description: "",
  priceYuan: "",
  currency: "CNY",
  stock: "",
  provider: "manual",
  active: "true",
}); // 表单只保存输入，不保存财务计算结果
const { data: currencies } = await useAsyncData("public-currencies", () =>
  api<
    {
      code: string;
      name: string;
      symbol: string;
      decimals: number;
      active: boolean;
    }[]
  >("/currencies"),
);
const currencyChoices = computed(
  () =>
    currencies.value
      ?.filter((item) => item.active || item.code === product.currency)
      .map((item) => ({
        value: item.code,
        label: `${item.name}（${item.code}）`,
      })) || [{ value: "CNY", label: "人民币（CNY）" }],
); // 仅新报价采用当前选择，既有合同币种由服务端保存
const revenueTotals = computed(() =>
  data.value &&
  !Array.isArray(data.value) &&
  Array.isArray(data.value.revenueTotals)
    ? (data.value.revenueTotals as {
        currency: string;
        amountCents: string;
        currencyDecimals?: number;
      }[])
    : [],
);
const labels: Record<string, string> = {
  id: "编号",
  name: "名称",
  email: "邮箱",
  role: "角色",
  subject: "问题",
  status: "状态",
  amountCents: "金额",
  priceCents: "月付价格",
  balanceCents: "余额",
  currency: "币种",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  dueAt: "到期时间",
  userId: "客户编号",
  productId: "产品编号",
  serviceId: "服务编号",
  invoiceId: "账单编号",
  attempts: "尝试次数",
  action: "操作",
  actorId: "操作人",
  target: "对象",
  kind: "类型",
  provider: "开通插件",
  gateway: "支付渠道",
  reason: "申请原因",
  enabled: "已启用",
  configured: "已配置",
  stock: "库存",
  title: "名称",
  description: "说明",
  version: "版本",
  capability: "能力",
  previousHash: "上一条摘要",
  hash: "记录摘要",
  lastError: "最近错误",
  error: "错误原因",
  serviceCount: "服务数量",
  userCount: "客户数量",
  orderCount: "订单数量",
  invoiceCount: "账单数量",
  unpaidCount: "待付款账单",
  revenueCents: "业务收入",
  ticketCount: "工单数量",
  jobCount: "任务数量",
  failedJobCount: "失败任务",
  state: "任务状态",
  maxAttempts: "最多尝试",
  runAt: "下次执行",
  productName: "产品名称",
  actor: "操作人",
  pluginCount: "插件数量",
  event: "事件",
  resource: "资源",
  result: "结果",
  availableAt: "下次尝试",
  type: "类型",
  suspendReason: "暂停原因",
  suspendType: "暂停类型",
  invoiceNumber: "账单编号",
  refundedCents: "已退金额",
  reservedCents: "已占额度",
  refundableCents: "可退金额",
  transactionId: "机构流水",
  providerStatus: "机构状态",
  providerReference: "机构编号",
  decisionReason: "处理说明",
  slug: "页面路径",
  published: "已发布",
  active: "上架状态",
  serviceName: "服务名称",
  serviceStatus: "服务状态",
  resolution: "处理说明",
  resolvedAt: "处理时间",
  operation: "正在处理",
  scheduledReason: "计划原因",
  manualRequired: "需人工处理",
}; // 日常运营优先看到业务中文名
const columnKeys = computed(() => {
  // 每个业务清单先呈现用户要核对的字段
  const chosen: Record<string, string[]> = {
    products: ["name", "priceCents", "stock", "provider", "active"],
    services: [
      "name",
      "email",
      "provider",
      "status",
      "operation",
      "dueAt",
      "suspendReason",
    ],
    orders: ["productName", "email", "amountCents", "status", "createdAt"],
    receipts: [
      "invoiceNumber",
      "email",
      "gateway",
      "amountCents",
      "refundedCents",
      "refundableCents",
      "createdAt",
    ],
    refunds: [
      "amountCents",
      "gateway",
      "status",
      "reason",
      "providerStatus",
      "lastError",
      "createdAt",
    ],
    "billing-reviews": [
      "invoiceNumber",
      "email",
      "serviceName",
      "serviceStatus",
      "amountCents",
      "status",
      "resolution",
      "createdAt",
    ],
    content: ["title", "kind", "published", "updatedAt"],
  }; // 金额、机构状态和时间不可被技术字段挤走
  return (
    chosen[tab.value] ||
    [...new Set(records.value.flatMap((record) => Object.keys(record)))]
      .filter(
        (key) =>
          ![
            "passwordHash",
            "password",
            "secret",
            "metadata",
            "config",
            "payload",
          ].includes(key),
      )
      .slice(0, 8)
  ); // 其它只读清单过滤敏感数据
});
const controls = computed(() =>
  [
    "jobs",
    "orders",
    "receipts",
    "refunds",
    "billing-reviews",
    "products",
    "content",
    "services",
  ].includes(tab.value),
); // 没有可执行动作的清单不放空按钮
const columns = computed(() => [
  ...columnKeys.value.map((key) => ({ key, label: labels[key] || key })),
  ...(controls.value ? [{ key: "controls", label: "操作" }] : []),
]); // 行为列与业务列明确分开
const summary = computed(() =>
  tab.value === "overview" && data.value && !Array.isArray(data.value)
    ? Object.entries(data.value).filter(
        ([key, value]) =>
          key !== "currency" &&
          !Array.isArray(value) &&
          (typeof value === "number" || typeof value === "string"),
      )
    : [],
); // 只有概况响应作为指标卡片
const total = computed(() =>
  data.value && !Array.isArray(data.value)
    ? Number(data.value.total || 0)
    : records.value.length,
); // 分页总数来自API
const financeOpen = ref(false);
const financeKind = ref<"approve" | "reject" | "reconcile">("reconcile"); // 资金操作由专用确认抽屉承接
const financeRow = ref<Record<string, unknown> | null>(null); // 不允许用户在确认时更换退款ID和金额
const financeFactorOpen = ref(false); // 收起时禁用证明字段的原生约束验证
const financeProof = ref({ mode: "totp" as "totp" | "recovery", code: "" }); // 资金出站仍可要求第二因素
const financeForm = reactive({ password: "", reason: "", gateway: "" }); // 当前密码只存在本次确认表单
const serviceOpen = ref(false);
const serviceBusy = ref(false);
const serviceError = ref(""); // 资源操作单独确认，不复用退款金额表单
const serviceRow = ref<Record<string, unknown> | null>(null);
const serviceAction = ref<"suspend" | "resume" | "terminate">("suspend"); // 当前目标与动作在打开时固定
const serviceForm = reactive({ reason: "", password: "" });
const serviceProof = ref<FactorInput>({ mode: "totp", code: "" }); // 密码和因素仅留在本次确认
const serviceFactorOpen = ref(false);
const skipOpen = ref(false);
const skipRow = ref<Record<string, unknown> | null>(null); // 人工核实只对应当前这一个到期暂停待办
const skipForm = reactive({ reason: "", password: "" }); // 不在浏览器持久保存管理员口令
const skipProof = ref<FactorInput>({ mode: "totp", code: "" });
const skipFactorOpen = ref(false); // 需要时再展开第二因素
watch(skipOpen, (value) => {
  if (!value) {
    skipForm.password = "";
    skipProof.value.code = "";
  }
}); // 关闭后清除身份输入，原请求仍保留busy状态
const serviceKeys = new Map<string, string>(); // 相同意图的网络重试复用标识
const confirmationNames: Record<string, string> = {
  provision: "确认服务已开通",
  renew: "确认已完成续费",
  suspend: "确认服务已暂停",
  resume: "确认服务已恢复",
  terminate: "确认服务已终止",
}; // 确认文字不能把暂停、删除都说成开通
const actionNames: Record<string, string> = {
  provision: "开通服务",
  renew: "续费",
  suspend: "暂停服务",
  resume: "恢复服务",
  terminate: "终止服务",
}; // 人工确认按真实动作说明影响
watch(serviceOpen, (value) => {
  if (!value) {
    serviceForm.password = "";
    serviceProof.value.code = "";
  }
}); // 退出确认后清掉敏感输入
const actionResult = ref<{ status?: string; message?: string } | null>(null); // 显示实际机构结果，不用前端猜测成功
const { data: gateways } = await useAsyncData("payments", () =>
  api<Array<{ id: string; name: string }>>("/payments"),
); // 对账只允许选择已有通道
const gatewayOptions = computed(() => [
  { value: "", label: "自动匹配原支付渠道" },
  ...(gateways.value || []).map((item) => ({
    value: item.id,
    label: item.name,
  })),
]); // 多渠道交易可以明确指定原通道
watch(financeOpen, (value) => {
  if (!value) {
    financeForm.password = "";
    financeProof.value.code = "";
  }
}); // 关闭后立即清掉敏感输入
const articleOpen = ref(false);
const articleBusy = ref(false);
const articleError = ref("");
const editingArticle = ref(""); // 编辑只属于当前文章
const article = reactive({
  title: "",
  slug: "",
  content: "",
  kind: "help",
  published: "true",
}); // 可见表单字段与内容API一一对应
const deletingArticle = ref<Record<string, unknown> | null>(null);
const deleteOpen = ref(false); // 删除使用单独确认，不复用资金审批

/** @param value API 返回字段。@param key 字段名。@returns 可读的文本。 */
function display(
  value: unknown,
  key: string,
  currency = "CNY",
  decimals?: number,
): string {
  // 展示外部数据时处理未知字段
  if (value === null || value === undefined) return "—"; // 缺失值不显示假数字
  if (key.endsWith("Cents")) return money(String(value), currency, decimals); // 金额以分格式化为元
  if (key.endsWith("At") && typeof value === "string") return date(value); // 日期保持统一展示
  if (key === "action") return actionNames[String(value)] || String(value); // 已知资源操作按业务动作说明
  if (key === "kind")
    return (
      (
        { help: "使用帮助", news: "最新动态", page: "独立页面" } as Record<
          string,
          string
        >
      )[String(value)] || String(value)
    ); // 公开内容类型与前台名称对应
  if (key === "suspendType")
    return (
      ({ overdue: "到期暂停", manual: "人工暂停" } as Record<string, string>)[
        String(value)
      ] || String(value)
    ); // 不把到期和人工暂停混为一类
  if (typeof value === "boolean") return value ? "是" : "否"; // 开关不展示原始技术值
  if (typeof value === "object") return JSON.stringify(value); // 插件元数据仍可核对
  return String(value); // 其它字段按纯文本渲染
}

/** 创建月付产品；用户按元填写，拆分字符串转成整数分。 */
async function create() {
  // 管理表单是输入边界
  busy.value = true;
  message.value = ""; // 提交期间保留内容并锁住按钮
  try {
    // API 错误紧贴表单显示
    await api(
      editingProduct.value
        ? `/admin/products/${editingProduct.value}`
        : "/admin/products",
      {
        method: editingProduct.value ? "PUT" : "POST",
        body: {
          name: product.name.trim(),
          description: product.description.trim(),
          priceCents: toCents(product.priceYuan, true, product.currency),
          currency: product.currency,
          stock: product.stock === "" ? null : Number(product.stock),
          provider: product.provider.trim(),
          active: product.active === "true",
        },
      },
    ); // 金额保持十进制整数字符串
    creating.value = false;
    editingProduct.value = "";
    await refresh(); // 保存成功再读取产品列表
    Object.assign(product, {
      name: "",
      description: "",
      priceYuan: "",
      currency: "CNY",
      stock: "",
      provider: "manual",
      active: "true",
    }); // 新建下一款产品不沿用旧字段
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    // 失败不会丢失输入
    busy.value = false;
  } // 用户可以修正后重试
}
/** @param id 任务ID。@param action 重试或确认人工交付。 */
async function job(
  id: string,
  action: "retry" | "complete",
  resourceAction = "provision",
) {
  // 管理员明确选择要做的业务动作
  actionBusy.value = id;
  actionError.value = ""; // 防止重复执行同一任务
  try {
    // 操作入口处理业务和网络错误
    let confirmation: { externalId?: string; note?: string } | undefined; // 重试不提交人工确认正文
    if (action === "complete" && resourceAction === "provision")
      confirmation = { externalId: delivery[id]?.trim() }; // 首次开通提供真实资源ID
    if (action === "complete" && resourceAction !== "provision")
      confirmation = { note: delivery[id]?.trim() }; // 其它动作记录实际处理结果
    await api(`/admin/jobs/${id}/${action}`, {
      method: "POST",
      body: confirmation,
    }); // 人工交付必须提供已交付资源的标识
    await refresh(); // 成功后读取守护进程真实任务状态
  } catch (error) {
    actionError.value = apiMessage(error);
  } finally {
    // 不在本地擅自把任务设为成功
    actionBusy.value = "";
  } // 用户可修正后再提交
}

/** @param row 服务端明确允许取消的manual到期暂停待办。 */
function beginSkip(row: Record<string, unknown>) {
  if (actionBusy.value) return; // 旧提交完成前禁止切换待办目标
  skipRow.value = row;
  Object.assign(skipForm, { reason: "", password: "" }); // 每次核实重新输入说明与身份凭据
  skipProof.value.code = "";
  skipFactorOpen.value = false;
  actionError.value = "";
  skipOpen.value = true; // 首次点击只进入人工事实确认
}

/** 记录管理员已向实际处理者核实未执行暂停，取消待办而不修改服务运行事实。 */
async function submitSkip() {
  actionBusy.value = String(skipRow.value!.id);
  actionError.value = ""; // 一次只能核实这一条待办
  try {
    await api(`/admin/jobs/${skipRow.value!.id}/skip`, {
      method: "POST",
      body: {
        reason: skipForm.reason.trim(),
        password: skipForm.password,
        ...(skipFactorOpen.value ? factorProof(skipProof.value) : {}),
      },
    }); // 可取消状态、口令、MFA和服务锁都由后端验证
    actionResult.value = {
      status: "skipped",
      message:
        "已记录“未执行暂停”的人工核实并关闭此待办。服务运行状态没有被这次确认改变，请在服务清单核对真实状态。",
    };
    skipOpen.value = false;
    await refresh(); // 读取真实任务状态，不在本地伪造供应商操作结果
  } catch (error) {
    actionError.value = apiMessage(error);
    if (/双因素|验证码|恢复码/.test(actionError.value))
      skipFactorOpen.value = true;
  } finally {
    actionBusy.value = ""; // 关闭抽屉不释放提交锁，直到收到原请求结果
  }
}

/** @param row 需要编辑的产品；不传则新建。 */
function beginProduct(row?: Record<string, unknown>) {
  // 一份表单承接产品完整编辑
  if (busy.value) return; // 旧保存请求完成前不切换编辑目标
  editingProduct.value = row ? String(row.id) : ""; // 不靠URL猜测要修改的目标
  Object.assign(
    product,
    row
      ? {
          name: String(row.name),
          description: String(row.description || ""),
          priceYuan: amount(
            String(row.priceCents),
            String(row.currency || "CNY"),
            typeof row.currencyDecimals === "number"
              ? row.currencyDecimals
              : undefined,
          ),
          currency: String(row.currency || "CNY"),
          stock: row.stock == null ? "" : String(row.stock),
          provider: String(row.provider),
          active: row.active ? "true" : "false",
        }
      : {
          name: "",
          description: "",
          priceYuan: "",
          currency: "CNY",
          stock: "",
          provider: "manual",
          active: "true",
        },
  ); // 元金额编辑不丢分
  message.value = "";
  creating.value = true; // 清除上一次表单错误
}

/** @param kind 本次管理员动作。@param row 已读取的真实记录。 */
function beginFinance(
  kind: "approve" | "reject" | "reconcile",
  row: Record<string, unknown>,
) {
  // 审批目标和金额在确认前固定
  if (actionBusy.value) return; // 抽屉关闭不取消请求，等待原结果后才允许另一次确认
  financeKind.value = kind;
  financeRow.value = row; // 当前确认只指向这一条记录
  Object.assign(financeForm, { password: "", reason: "", gateway: "" });
  financeProof.value.code = "";
  financeFactorOpen.value = false; // 不沿用上一次密码和拒绝说明
  actionError.value = "";
  financeOpen.value = true; // 抽屉聚焦当前操作
}

/** 发起明确的机构查询或退款审批，完成后重新读取真实清单。 */
async function submitFinance() {
  // 密码确认与原因验证在这个入口完成
  const row = financeRow.value!; // 入口只能在选定记录的抽屉中触发
  actionBusy.value = String(row.id);
  actionError.value = ""; // 不并发批准与拒绝同一申请
  try {
    const path =
      financeKind.value === "reconcile"
        ? `/admin/invoices/${row.invoiceId}/reconcile`
        : `/admin/refunds/${row.id}/${financeKind.value}`; // 不提供手工标记已付款或已退款接口
    const body =
      financeKind.value === "approve"
        ? {
            password: financeForm.password,
            ...(financeFactorOpen.value ? factorProof(financeProof.value) : {}),
          }
        : financeKind.value === "reject"
          ? { reason: financeForm.reason.trim() }
          : financeForm.gateway
            ? { gateway: financeForm.gateway }
            : {}; // 只发送该动作允许的字段
    const result = await api<{
      status?: string;
      providerStatus?: string;
      lastError?: string;
      message?: string;
    }>(path, { method: "POST", body }); // 机构查询与资金事务全部在后端执行
    actionResult.value = {
      status: result.status || result.providerStatus,
      message:
        result.lastError ||
        result.message ||
        "已读取实际处理结果，请核对清单中的最新记录。",
    }; // 未知结果也按真实状态呈现
    financeForm.password = "";
    financeOpen.value = false;
    await refresh(); // 响应后丢弃密码并重新读取
  } catch (error) {
    actionError.value = apiMessage(error);
    if (/双因素|验证码|恢复码/.test(actionError.value))
      financeFactorOpen.value = true;
  } finally {
    // 密码错误保留当前抽屉，允许重新核对
    actionBusy.value = "";
  } // 处理完成才恢复动作
}

/** @param row 已发出且仍待核对的退款。 */
async function refreshRefund(row: Record<string, unknown>) {
  // 查询原退款号，不重新发送退款
  actionBusy.value = String(row.id);
  actionError.value = ""; // 明确显示正在向机构读取
  try {
    const result = await api<Refund>(`/admin/refunds/${row.id}/refresh`, {
      method: "POST",
    }); // 后端验证原机构响应
    actionResult.value = {
      status: result.status,
      message: result.lastError || "已读取原退款申请的最新机构结果。",
    }; // 状态未确认时不会显示成功
    await refresh(); // 以数据库保存的结果刷新列表
  } catch (error) {
    actionError.value = apiMessage(error);
  } finally {
    // 失败不覆盖既有退款事实
    actionBusy.value = "";
  } // 允许稍后再次查询
}

/** @param row 要编辑的文章；不传则创建。 */
function beginArticle(row?: Record<string, unknown>) {
  // 正文、路径与发布状态在同一处编辑
  if (articleBusy.value) return; // 原保存完成前不把同一表单切给另一篇文章
  editingArticle.value = row ? String(row.id) : ""; // 编辑目标不从用户输入读
  Object.assign(
    article,
    row
      ? {
          title: String(row.title),
          slug: String(row.slug),
          content: String(row.content),
          kind: String(row.kind),
          published: row.published ? "true" : "false",
        }
      : { title: "", slug: "", content: "", kind: "help", published: "true" },
  ); // 已发布文章保留真实全文
  articleError.value = "";
  articleOpen.value = true; // 草稿与发布复用同一表单
}

/** 保存文章，差异静态生成由服务端登记发布修订。 */
async function saveArticle() {
  // 标题和正文只在输入边界整理
  articleBusy.value = true;
  articleError.value = ""; // 不让同一表单重复创建文章
  try {
    await api(
      editingArticle.value
        ? `/admin/content/${editingArticle.value}`
        : "/admin/content",
      {
        method: editingArticle.value ? "PUT" : "POST",
        body: {
          title: article.title.trim(),
          slug: article.slug.trim(),
          content: article.content.trim(),
          kind: article.kind,
          published: article.published === "true",
        },
      },
    ); // slug只允许API规定的安全路径
    articleOpen.value = false;
    await refresh(); // 保存成功后读取当前发布状态
  } catch (error) {
    articleError.value = apiMessage(error);
  } finally {
    // 失败保留输入正文
    articleBusy.value = false;
  } // 用户可以修正后重试
}

/** 删除当前确认的文章，旧路径失效由后端处理。 */
async function deleteArticle() {
  // 只在明确确认后执行删除
  articleBusy.value = true;
  articleError.value = ""; // 不并发发送同一删除
  try {
    await api(`/admin/content/${deletingArticle.value!.id}`, {
      method: "DELETE",
    });
    deleteOpen.value = false;
    await refresh();
  } catch (error) {
    // 真实删除后才移出清单
    articleError.value = apiMessage(error);
  } finally {
    // 失败仍保留记录与错误原因
    articleBusy.value = false;
  } // 撤销或重试仍由用户决定
}

/** @param action 对当前资源发起的明确动作。@param row 真实服务记录。 */
function beginService(
  action: "suspend" | "resume" | "terminate",
  row: Record<string, unknown>,
) {
  // 第一次点击只打开确认，不排队
  if (serviceBusy.value) return; // 允许关闭阅读区域，但原提交未完成时不更换确认对象
  serviceAction.value = action;
  serviceRow.value = row; // 后续不能在确认表单中换服务ID
  Object.assign(serviceForm, { reason: "", password: "" });
  serviceProof.value.code = ""; // 不复用旧操作的证明
  serviceError.value = "";
  serviceFactorOpen.value = false;
  serviceOpen.value = true; // 聚焦这一份服务的动作
}

/** 确认资源动作：只创建持久化任务，供应商确认前不改变本地服务状态。 */
async function submitService() {
  // 用户第二次确认并提供当前密码后才执行
  serviceBusy.value = true;
  serviceError.value = ""; // 不重复发送同一个破坏性动作
  try {
    const row = serviceRow.value!; // 确认抽屉必然已有一个真实服务
    const reason = serviceForm.reason.trim(); // 业务说明先整理再发出
    const intent = JSON.stringify({
      id: row.id,
      action: serviceAction.value,
      reason,
    }); // 幂等意图不包含易变化的密码与验证码
    const key = serviceKeys.get(intent) || crypto.randomUUID(); // 网络重试不会排第二个任务
    serviceKeys.set(intent, key); // 发出前记住当前操作意图
    const result = await api<{ id: string; state: string }>(
      `/admin/services/${row.id}/actions`,
      {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          action: serviceAction.value,
          reason,
          password: serviceForm.password,
          ...(serviceFactorOpen.value ? factorProof(serviceProof.value) : {}),
        },
      },
    ); // 所有权、密码、MFA和资源锁都由后端验证
    serviceKeys.delete(intent);
    serviceForm.password = "";
    serviceOpen.value = false; // 排队确认后清除密码
    actionResult.value = {
      status: result.state,
      message: `操作已登记为任务 ${result.id}。服务状态会在实际供应商结果确认后更新，可在“开通任务”跟进。`,
    }; // 排队不等于资源已经变化
    await refresh(); // 当前列表仍以数据库真实状态为准
  } catch (error) {
    serviceError.value = apiMessage(error);
    if (/双因素|验证码|恢复码/.test(serviceError.value))
      serviceFactorOpen.value = true;
  } finally {
    // 需要证明时展开相应输入
    serviceBusy.value = false;
  } // 用户可修正后重试同一意图
}
</script>
<template>
  <div>
    <AppLink to="/console" :underline="false" class="auth-back mb-6">
      <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
      返回个人工作台
    </AppLink>
    <header class="page-heading">
      <div>
        <h1>管理后台</h1>
        <p>照顾业务，也照顾每一次操作留下的记录。</p>
      </div>
      <KimaButton
        v-if="tab === 'products'"
        :disabled="busy"
        @click="beginProduct()"
      >
        <template #leading><KimaIcon :icon="Add01Icon" /></template>
        创建产品
      </KimaButton>
      <KimaButton
        v-if="tab === 'content'"
        :disabled="articleBusy"
        @click="beginArticle()"
      >
        <template #leading><KimaIcon :icon="Add01Icon" /></template>
        新建内容
      </KimaButton>
    </header>
    <nav class="admin-tabs" aria-label="管理功能">
      <AppLink
        v-for="item in tabs"
        :key="item.id"
        :to="`/admin?tab=${item.id}`"
        :underline="false"
        class="admin-tab"
        :current="tab === item.id"
      >
        {{ item.label }}
      </AppLink>
    </nav>
    <KimaAlert v-if="actionError" variant="danger" class="mb-6">{{
      actionError
    }}</KimaAlert>
    <KimaAlert
      v-if="tab === 'billing-reviews'"
      class="mb-6"
      heading="到账款项需要退款核对"
    >
      这里记录已收到款项、但原续费资源无法继续交付的账单。请按原账单发起并审批退款；全部实际退款成功后记录会自动完成，无需手工清空。
    </KimaAlert>
    <KimaAlert v-if="actionBusy && !financeOpen && !skipOpen" class="mb-6">
      正在核对本次操作结果，请稍等。
    </KimaAlert>
    <KimaAlert v-if="serviceBusy && !serviceOpen" class="mb-6">
      资源操作正在提交，请等待本次结果。
    </KimaAlert>
    <KimaAlert
      v-if="serviceError && !serviceOpen"
      variant="danger"
      class="mb-6"
    >
      {{ serviceError }}
    </KimaAlert>
    <nav class="admin-module-links mb-6" aria-label="业务管理">
      <AppLink to="/admin/catalogue">商品与优惠</AppLink>
      <AppLink to="/admin/currencies">币种与换价</AppLink>
      <AppLink to="/admin/clients">客户与分组</AppLink>
      <AppLink to="/admin/messaging">消息与关怀</AppLink>
      <AppLink to="/admin/reports">经营报表</AppLink>
      <AppLink to="/admin/sales">销售与绩效</AppLink>
      <AppLink to="/admin/fields">自定义字段</AppLink>
      <AppLink to="/admin/roles">员工与权限</AppLink>
      <AppLink to="/admin/support">工单与资料</AppLink>
      <AppLink to="/admin/documents">合同与发票</AppLink>
      <AppLink to="/admin/affiliates">联盟与提现</AppLink>
      <AppLink to="/admin/verification">实名核验</AppLink>
      <AppLink to="/admin/credit">授信管理</AppLink>
      <AppLink to="/admin/lifecycle">取消审批</AppLink>
    </nav>
    <KimaAlert v-if="message && !creating" variant="danger" class="mb-6">{{
      message
    }}</KimaAlert>
    <KimaAlert
      v-if="articleError && !articleOpen && !deleteOpen"
      variant="danger"
      class="mb-6"
    >
      {{ articleError }}
    </KimaAlert>
    <KimaAlert v-if="actionResult" class="mb-6" heading="本次处理结果">
      <StatusBadge v-if="actionResult.status" :status="actionResult.status" />
      <p class="mt-3">{{ actionResult.message }}</p>
    </KimaAlert>
    <section class="panel">
      <header class="panel-header">
        <h2>{{ tabs.find((item) => item.id === tab)?.label }}</h2>
        <KimaButton variant="text" :disabled="pending" @click="refresh()">
          <template #leading><KimaIcon :icon="Refresh01Icon" /></template>
          刷新
        </KimaButton>
      </header>
      <RequestState :pending="pending" :error="error" @retry="refresh" />
      <div
        v-if="!pending && !error && summary.length"
        class="content-padding grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
      >
        <KimaCard v-for="[key, value] in summary" :key="key" class="stat-card">
          <p class="stat-top">{{ labels[key] || key }}</p>
          <p class="stat-value">{{ display(value, key) }}</p>
        </KimaCard>
      </div>
      <section
        v-if="tab === 'overview' && revenueTotals.length"
        class="content-padding"
      >
        <h3>按币种核对业务收入</h3>
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            v-for="entry in revenueTotals"
            :key="entry.currency"
            class="flex flex-wrap gap-4 justify-between"
          >
            <dt>{{ entry.currency }}</dt>
            <dd class="numbers">
              {{
                money(entry.amountCents, entry.currency, entry.currencyDecimals)
              }}
            </dd>
          </div>
        </dl>
        <AppLink
          to="/admin/reports"
          class="inline-flex min-h-12 items-center mt-3"
          >查看经营报表</AppLink
        >
      </section>
      <KimaTable
        v-if="!pending && !error && records.length"
        :columns="columns"
        :rows="records"
        row-key="id"
        hoverable
      >
        <template
          v-for="key in columnKeys"
          :key="key"
          #[`cell-${key}`]="{ value, row }"
        >
          <StatusBadge
            v-if="key === 'state' && tab === 'jobs' && row.result?.skipped"
            status="skipped"
          />
          <StatusBadge
            v-else-if="key === 'status' && tab === 'billing-reviews'"
            :status="value === 'open' ? 'billing_review' : 'resolved'"
          />
          <StatusBadge
            v-else-if="
              ['status', 'state', 'providerStatus', 'serviceStatus'].includes(
                key,
              )
            "
            :status="String(value)"
            :context="
              key === 'serviceStatus' ||
              (tab === 'services' && key === 'status')
                ? 'service'
                : undefined
            "
            :order-status="String(row.orderStatus || '')"
          />
          <div v-else-if="key === 'operation' && value">
            <p>{{ actionNames[String(value.action)] || value.action }}</p>
            <StatusBadge :status="String(value.state)" />
          </div>
          <div v-else-if="key === 'name' && tab === 'services'">
            <span class="table-primary">{{ value }}</span>
            <span class="table-secondary">{{
              String(row.id).slice(0, 8)
            }}</span>
          </div>
          <span
            v-else
            class="block max-w-xs break-words"
            :title="
              display(
                value,
                key,
                String(row.currency || 'CNY'),
                typeof row.currencyDecimals === 'number'
                  ? row.currencyDecimals
                  : undefined,
              )
            "
          >
            {{
              display(
                value,
                key,
                String(row.currency || "CNY"),
                typeof row.currencyDecimals === "number"
                  ? row.currencyDecimals
                  : undefined,
              )
            }}
          </span>
        </template>
        <template #cell-controls="{ row }">
          <div v-if="tab === 'jobs'" class="job-controls">
            <p
              v-if="row.manualRequired && !row.result?.skipped"
              class="form-hint"
            >
              已转交人工，请核对实际处理人和执行情况。
            </p>
            <KimaButton
              v-if="row.state === 'failed'"
              variant="tonal"
              :disabled="!!actionBusy"
              :loading="actionBusy === row.id"
              @click="job(String(row.id), 'retry')"
            >
              重新执行
            </KimaButton>
            <form
              v-if="
                row.provider === 'manual' &&
                !['running', 'succeeded', 'cancelled'].includes(
                  String(row.state),
                ) &&
                !row.result?.skipped
              "
              @submit.prevent="
                job(String(row.id), 'complete', String(row.action))
              "
            >
              <label class="field-label">
                <span class="form-label">
                  {{
                    row.action === "provision"
                      ? "已交付的资源标识"
                      : "实际处理说明"
                  }}
                </span>
                <KimaTextField
                  v-model="delivery[String(row.id)]"
                  :label="
                    row.action === 'provision'
                      ? '已交付的资源标识'
                      : '实际处理说明'
                  "
                  :hint="
                    row.action === 'provision'
                      ? '填写实际交付的供应商资源编号。'
                      : '请先在供应商处完成操作，再记录处理结果。'
                  "
                  required
                  :maxlength="row.action === 'provision' ? 200 : 1000"
                  :disabled="!!actionBusy"
                />
              </label>
              <KimaButton
                class="mt-4 w-full"
                type="submit"
                :disabled="!!actionBusy"
                :loading="actionBusy === row.id"
              >
                {{
                  confirmationNames[String(row.action)] || "确认实际处理结果"
                }}
              </KimaButton>
            </form>
            <KimaButton
              v-if="row.skipAvailable === true"
              variant="tonal"
              :disabled="!!actionBusy"
              @click="beginSkip(row)"
            >
              已核实未执行暂停
            </KimaButton>
          </div>
          <div v-else class="record-actions">
            <template v-if="tab === 'services'">
              <KimaButton
                v-if="
                  row.status === 'active' &&
                  !row.terminationRequestedAt &&
                  !row.operation
                "
                variant="tonal"
                :disabled="serviceBusy"
                @click="beginService('suspend', row)"
              >
                暂停服务
              </KimaButton>
              <KimaButton
                v-if="
                  row.status === 'suspended' &&
                  !row.terminationRequestedAt &&
                  !row.operation
                "
                variant="tonal"
                :disabled="serviceBusy"
                @click="beginService('resume', row)"
              >
                恢复服务
              </KimaButton>
              <KimaButton
                v-if="
                  ['active', 'suspended'].includes(row.status) &&
                  !row.terminationRequestedAt &&
                  !row.operation
                "
                variant="text"
                :disabled="serviceBusy"
                @click="beginService('terminate', row)"
              >
                终止服务
              </KimaButton>
              <span
                v-if="
                  row.terminationRequestedAt &&
                  !['terminated', 'cancelled'].includes(String(row.status))
                "
                class="muted"
              >
                终止任务处理中，请到开通任务跟进。
              </span>
            </template>
            <KimaButton
              v-if="tab === 'billing-reviews'"
              variant="tonal"
              @click="router.push('/admin?tab=refunds')"
            >
              查看退款清单
            </KimaButton>
            <KimaButton
              v-if="tab === 'orders' || tab === 'receipts'"
              variant="tonal"
              :disabled="!!actionBusy"
              @click="beginFinance('reconcile', row)"
            >
              向机构对账
            </KimaButton>
            <template v-if="tab === 'refunds'">
              <KimaButton
                v-if="['requested', 'approved'].includes(row.status)"
                variant="tonal"
                :disabled="!!actionBusy"
                @click="beginFinance('approve', row)"
              >
                批准退款
              </KimaButton>
              <KimaButton
                v-if="['requested', 'approved'].includes(row.status)"
                variant="text"
                :disabled="!!actionBusy"
                @click="beginFinance('reject', row)"
              >
                拒绝申请
              </KimaButton>
              <KimaButton
                v-if="['processing', 'manual_review'].includes(row.status)"
                variant="tonal"
                :loading="actionBusy === row.id"
                :disabled="!!actionBusy"
                @click="refreshRefund(row)"
              >
                查询原退款
              </KimaButton>
            </template>
            <KimaButton
              v-if="tab === 'products'"
              variant="tonal"
              :disabled="busy"
              @click="beginProduct(row)"
            >
              编辑产品
            </KimaButton>
            <template v-if="tab === 'content'">
              <KimaButton
                variant="tonal"
                :disabled="articleBusy"
                @click="beginArticle(row)"
              >
                编辑内容
              </KimaButton>
              <KimaButton
                variant="text"
                :disabled="articleBusy"
                @click="
                  deletingArticle = row;
                  articleError = '';
                  deleteOpen = true;
                "
              >
                删除
              </KimaButton>
            </template>
          </div>
        </template>
      </KimaTable>
      <KimaEmptyState
        v-if="!pending && !error && !records.length && !summary.length"
        :heading="`暂时没有${tabs.find((item) => item.id === tab)?.label}记录`"
      />
      <div v-if="paged && !pending && !error" class="pagination-bar">
        <p class="muted text-sm">共 {{ total }} 条 · 第 {{ pageNumber }} 页</p>
        <div class="flex gap-3">
          <KimaButton
            variant="tonal"
            :disabled="pageNumber <= 1"
            @click="pageNumber--"
          >
            上一页
          </KimaButton>
          <KimaButton
            variant="tonal"
            :disabled="pageNumber * 50 >= total"
            @click="pageNumber++"
          >
            下一页
          </KimaButton>
        </div>
      </div>
    </section>
    <KimaDrawer
      v-model:open="creating"
      :title="editingProduct ? '编辑产品' : '创建产品'"
      placement="right"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form id="new-product-form" class="drawer-form" @submit.prevent="create">
        <label class="field-label">
          <span class="form-label">产品名称</span>
          <KimaTextField
            v-model="product.name"
            label="产品名称"
            maxlength="100"
            required
            :disabled="busy"
          />
        </label>
        <div class="field-label">
          <span class="form-label">报价币种</span
          ><KimaSelect
            v-model="product.currency"
            label="报价币种"
            :items="currencyChoices"
            :disabled="busy"
          />
        </div>
        <label class="field-label">
          <span class="form-label">月付价格（{{ product.currency }}）</span>
          <KimaTextField
            v-model="product.priceYuan"
            :label="`月付价格（${product.currency}）`"
            inputmode="decimal"
            :pattern="
              currencyDecimals(product.currency) === 0
                ? '[0-9]+'
                : `[0-9]+([.][0-9]{1,${currencyDecimals(product.currency)}})?`
            "
            placeholder="29.00"
            :hint="`按${product.currency}填写，${currencyDecimals(product.currency) === 0 ? '只填整数' : `最多${currencyDecimals(product.currency)}位小数`}；0表示免费方案。`"
            required
            :disabled="busy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">库存数量</span>
          <KimaTextField
            v-model="product.stock"
            label="库存数量"
            type="number"
            min="0"
            step="1"
            hint="留空表示不限数量。"
            :disabled="busy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">开通插件</span>
          <KimaTextField
            v-model="product.provider"
            label="开通插件"
            hint="填写已安装插件的名称，例如manual。"
            required
            :disabled="busy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">产品说明</span>
          <KimaTextarea
            v-model="product.description"
            label="产品说明"
            :maxlength="5000"
            required
            :disabled="busy"
          />
        </label>
        <div class="field-label">
          <span class="form-label">上架状态</span>
          <KimaSelect
            v-model="product.active"
            label="上架状态"
            :items="[
              { value: 'true', label: '上架，可购买' },
              { value: 'false', label: '下架，不接受新购买' },
            ]"
            :disabled="busy"
          />
        </div>
        <KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="creating = false"
          >取消</KimaButton
        >
        <KimaButton type="submit" form="new-product-form" :loading="busy"
          >保存产品</KimaButton
        >
      </template>
    </KimaDrawer>
    <KimaDrawer
      v-model:open="financeOpen"
      :title="
        financeKind === 'approve'
          ? '确认批准退款'
          : financeKind === 'reject'
            ? '拒绝退款申请'
            : '向原支付机构对账'
      "
      placement="right"
      :close-on-backdrop="!actionBusy"
      :close-on-escape="!actionBusy"
    >
      <form
        id="finance-form"
        class="drawer-form"
        @submit.prevent="submitFinance"
      >
        <KimaAlert
          v-if="financeRow?.amountCents"
          :heading="
            money(
              String(financeRow.amountCents),
              String(financeRow.currency || 'CNY'),
              typeof financeRow.currencyDecimals === 'number'
                ? financeRow.currencyDecimals
                : undefined,
            )
          "
        >
          {{
            financeKind === "approve"
              ? "批准后将通过原支付渠道发起这笔退款，请核对金额与原因。"
              : financeKind === "reject"
                ? "只有尚未发送到机构的退款申请可以拒绝。"
                : "查询将向机构核对原订单，不提供手工改成已付款的入口。"
          }}
        </KimaAlert>
        <p v-if="financeRow?.reason" class="muted">
          申请原因：{{ financeRow.reason }}
        </p>
        <label v-if="financeKind === 'approve'" class="field-label">
          <span class="form-label">当前管理员密码</span>
          <KimaTextField
            v-model="financeForm.password"
            label="当前管理员密码"
            type="password"
            autocomplete="current-password"
            required
            :disabled="!!actionBusy"
          />
        </label>
        <KimaCollapsible
          v-if="financeKind === 'approve'"
          v-model:open="financeFactorOpen"
          label="已启用双因素认证？填写安全验证"
        >
          <SecondFactor
            v-model="financeProof"
            :disabled="!!actionBusy || !financeFactorOpen"
          />
        </KimaCollapsible>
        <label v-if="financeKind === 'reject'" class="field-label">
          <span class="form-label">拒绝原因</span>
          <KimaTextarea
            v-model="financeForm.reason"
            label="拒绝原因"
            :minlength="1"
            :maxlength="500"
            required
            :disabled="!!actionBusy"
            hint="该说明会提供给客户，请写清楚原因。"
          />
        </label>
        <div v-if="financeKind === 'reconcile'" class="field-label">
          <span class="form-label">原支付渠道</span>
          <KimaSelect
            v-model="financeForm.gateway"
            label="原支付渠道"
            :items="gatewayOptions"
            :disabled="!!actionBusy"
          />
        </div>
        <KimaAlert v-if="actionError" variant="danger">{{
          actionError
        }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton
          variant="tonal"
          :disabled="!!actionBusy"
          @click="financeOpen = false"
        >
          取消
        </KimaButton>
        <KimaButton type="submit" form="finance-form" :loading="!!actionBusy">
          {{
            financeKind === "approve"
              ? "确认批准"
              : financeKind === "reject"
                ? "确认拒绝"
                : "开始核对"
          }}
        </KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      v-model:open="articleOpen"
      :title="editingArticle ? '编辑内容' : '新建内容'"
      placement="right"
      :close-on-backdrop="!articleBusy"
      :close-on-escape="!articleBusy"
    >
      <form id="article-form" class="drawer-form" @submit.prevent="saveArticle">
        <label class="field-label">
          <span class="form-label">标题</span>
          <KimaTextField
            v-model="article.title"
            label="标题"
            maxlength="200"
            required
            :disabled="articleBusy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">页面路径</span>
          <KimaTextField
            v-model="article.slug"
            label="页面路径"
            pattern="[a-z0-9][a-z0-9-]{0,99}"
            placeholder="getting-started"
            hint="使用小写字母、数字和短横线。"
            required
            :disabled="articleBusy"
          />
        </label>
        <div class="field-label">
          <span class="form-label">内容类型</span>
          <KimaSelect
            v-model="article.kind"
            label="内容类型"
            :items="[
              { value: 'help', label: '使用帮助' },
              { value: 'news', label: '最新动态' },
              { value: 'page', label: '独立页面' },
            ]"
            :disabled="articleBusy"
          />
        </div>
        <label class="field-label">
          <span class="form-label">正文</span>
          <KimaTextarea
            v-model="article.content"
            label="正文"
            :rows="10"
            :maxlength="200000"
            required
            :disabled="articleBusy"
          />
        </label>
        <div class="field-label">
          <span class="form-label">发布状态</span>
          <KimaSelect
            v-model="article.published"
            label="发布状态"
            :items="[
              { value: 'true', label: '发布，所有人可阅读' },
              { value: 'false', label: '草稿，仅管理员可见' },
            ]"
            :disabled="articleBusy"
          />
        </div>
        <KimaAlert v-if="articleError" variant="danger">{{
          articleError
        }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton
          variant="tonal"
          :disabled="articleBusy"
          @click="articleOpen = false"
        >
          取消
        </KimaButton>
        <KimaButton type="submit" form="article-form" :loading="articleBusy"
          >保存内容</KimaButton
        >
      </template>
    </KimaDrawer>
    <KimaDrawer
      v-model:open="deleteOpen"
      title="确认删除这篇内容？"
      description="删除后公开页面将失效，操作记录会保留。"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!articleBusy"
    >
      <p>{{ deletingArticle?.title }}</p>
      <KimaAlert v-if="articleError" variant="danger">{{
        articleError
      }}</KimaAlert>
      <template #footer>
        <KimaButton
          variant="tonal"
          autofocus
          :disabled="articleBusy"
          @click="deleteOpen = false"
        >
          保留内容
        </KimaButton>
        <KimaButton :loading="articleBusy" @click="deleteArticle"
          >确认删除</KimaButton
        >
      </template>
    </KimaDrawer>

    <KimaDrawer
      v-model:open="skipOpen"
      title="确认尚未执行暂停？"
      placement="right"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!actionBusy"
    >
      <form id="skip-job-form" class="drawer-form" @submit.prevent="submitSkip">
        <KimaAlert variant="warning" heading="先向实际处理人核实">
          请确认这份到期暂停任务尚未在供应商处执行。确认只会取消当前人工待办，不会把服务改为运行中；已经执行的暂停应保留真实处理结果。
        </KimaAlert>
        <p class="muted">任务：{{ skipRow?.id }}</p>
        <label class="field-label">
          <span class="form-label">核实说明</span>
          <KimaTextarea
            v-model="skipForm.reason"
            label="核实说明"
            placeholder="说明向谁、何时核实，以及取消此待办的依据。"
            :minlength="1"
            :maxlength="500"
            required
            :disabled="!!actionBusy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">当前管理员密码</span>
          <KimaTextField
            v-model="skipForm.password"
            label="当前管理员密码"
            type="password"
            autocomplete="current-password"
            required
            :disabled="!!actionBusy"
          />
        </label>
        <KimaCollapsible
          v-model:open="skipFactorOpen"
          label="已启用双因素认证？填写安全验证"
        >
          <SecondFactor
            v-model="skipProof"
            :disabled="!!actionBusy || !skipFactorOpen"
          />
        </KimaCollapsible>
        <KimaAlert v-if="actionError" variant="danger">{{
          actionError
        }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton
          variant="tonal"
          autofocus
          :disabled="!!actionBusy"
          @click="skipOpen = false"
        >
          保留待办
        </KimaButton>
        <KimaButton type="submit" form="skip-job-form" :loading="!!actionBusy">
          我已核实未执行暂停
        </KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      v-model:open="serviceOpen"
      :title="`确认${actionNames[serviceAction]}？`"
      placement="right"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!serviceBusy"
    >
      <form
        id="service-action-form"
        class="drawer-form"
        @submit.prevent="submitService"
      >
        <KimaAlert
          :variant="serviceAction === 'terminate' ? 'danger' : 'info'"
          :heading="
            String(serviceRow?.name || serviceRow?.productName || '云服务')
          "
        >
          {{
            serviceAction === "terminate"
              ? "终止会要求供应商删除此服务资源，执行后数据可能无法恢复。请核对服务并确认已做好备份。"
              : "操作会排入任务队列，等待实际供应商执行或人工确认，不会立即更改服务状态。"
          }}
        </KimaAlert>
        <p class="muted">客户：{{ serviceRow?.email }}</p>
        <label class="field-label">
          <span class="form-label">操作原因</span>
          <KimaTextarea
            v-model="serviceForm.reason"
            label="操作原因"
            :minlength="1"
            :maxlength="500"
            required
            :disabled="serviceBusy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">当前管理员密码</span>
          <KimaTextField
            v-model="serviceForm.password"
            label="当前管理员密码"
            type="password"
            autocomplete="current-password"
            required
            :disabled="serviceBusy"
          />
        </label>
        <KimaCollapsible
          v-model:open="serviceFactorOpen"
          label="已启用双因素认证？填写安全验证"
        >
          <SecondFactor
            v-model="serviceProof"
            :disabled="serviceBusy || !serviceFactorOpen"
          />
        </KimaCollapsible>
        <KimaAlert v-if="serviceError" variant="danger">{{
          serviceError
        }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton
          variant="tonal"
          autofocus
          :disabled="serviceBusy"
          @click="serviceOpen = false"
        >
          取消操作
        </KimaButton>
        <KimaButton
          type="submit"
          form="service-action-form"
          :loading="serviceBusy"
        >
          确认{{ actionNames[serviceAction] }}
        </KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
