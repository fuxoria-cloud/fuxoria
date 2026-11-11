<!-- 合同与开票运营：维护合同模板、核对已签合同、按真实交付记录处理发票。调用：管理员访问/admin/documents。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from "~/features/factor";
import { money } from "~/features/money";
import "~/assets/css/identity.css";
definePageMeta({ layout: "console", middleware: ["account", "admin"] });
useSeoMeta({ title: "合同与开票管理", robots: "noindex, nofollow" });
interface Template {
  id: string;
  title: string;
  content: string;
  productIds: string[];
  active: boolean;
}
interface Contract {
  id: string;
  number: string;
  email: string;
  snapshot: {
    title: string;
    content: string;
    party: {
      name: string;
      company: string;
      email: string;
      address: string;
      phone: string;
    };
  };
  snapshotHash: string;
  status: string;
  signedAt?: string;
  signer?: string;
  voidReason?: string;
}
interface TaxRequest {
  id: string;
  number: string;
  email: string;
  profile: {
    title: string;
    type: string;
    taxNumber: string;
    invoiceType: string;
    bank: string;
    bankAccount: string;
    address: string;
    phone: string;
    email: string;
    shippingAddress: string;
  };
  amountCents: string;
  currency?: string;
  currencyDecimals?: number;
  redDocument?: {
    invoiceNumber: string;
    documentUrl?: string;
    reason: string;
    createdAt: string;
  };
  status: string;
  note: string;
  invoiceNumber?: string;
  documentUrl?: string;
  trackingNumber?: string;
  decisionReason?: string;
}
const api = useApi(),
  base = useRuntimeConfig().public.apiBase,
  route = useRoute(),
  router = useRouter();
const tab = computed(() =>
  ["templates", "contracts", "tax"].includes(String(route.query.tab))
    ? String(route.query.tab)
    : "tax",
);
const {
  data: templates,
  error: templateError,
  refresh: refreshTemplates,
} = await useAsyncData("document-admin-templates", () =>
  api<Template[]>("/admin/contract-templates"),
);
const {
  data: contracts,
  error: contractError,
  refresh: refreshContracts,
} = await useAsyncData("document-admin-contracts", () =>
  api<Contract[]>("/admin/contracts"),
);
const {
  data: requests,
  error: requestError,
  refresh: refreshRequests,
} = await useAsyncData("document-admin-tax", () =>
  api<TaxRequest[]>("/admin/tax-requests"),
);
const { data: products } = await useAsyncData("document-admin-products", () =>
  api<{ id: string; name: string }[]>("/admin/products"),
);
const error = computed(() =>
  tab.value === "templates"
    ? templateError.value
    : tab.value === "contracts"
      ? contractError.value
      : requestError.value,
);
const mode = ref<"template" | "contract" | "tax" | "">(""),
  editing = ref(""),
  busy = ref(false),
  message = ref(""),
  success = ref("");
const template = reactive({
  title: "",
  content: "",
  productIds: [] as string[],
  active: true,
});
const contract = ref<Contract | null>(null),
  tax = ref<TaxRequest | null>(null),
  reason = ref(""),
  action = ref("approve"),
  invoiceNumber = ref(""),
  documentUrl = ref(""),
  trackingNumber = ref("");
const password = ref(""),
  proof = ref<FactorInput>({ mode: "totp", code: "" });
const labels: Record<string, string> = {
  pending: "待处理",
  approved: "待开具",
  issued: "已开具",
  rejected: "已驳回",
  cancelled: "已撤回",
  signed: "已签署",
  voided: "已作废",
};
function clear() {
  message.value = "";
  reason.value = "";
  password.value = "";
  proof.value.code = "";
}
function editTemplate(item?: Template) {
  mode.value = "template";
  editing.value = item?.id ?? "";
  Object.assign(template, {
    title: item?.title ?? "",
    content: item?.content ?? "",
    productIds: [...(item?.productIds ?? [])],
    active: item?.active ?? true,
  });
  clear();
}
function viewContract(item: Contract) {
  mode.value = "contract";
  contract.value = item;
  clear();
}
function viewTax(item: TaxRequest) {
  mode.value = "tax";
  tax.value = item;
  action.value =
    item.status === "issued"
      ? "red-letter"
      : item.status === "approved"
        ? "issue"
        : "approve";
  invoiceNumber.value =
    item.status === "issued" ? "" : (item.invoiceNumber ?? "");
  documentUrl.value = item.status === "issued" ? "" : (item.documentUrl ?? "");
  trackingNumber.value = item.trackingNumber ?? "";
  clear();
}
async function submit() {
  busy.value = true;
  message.value = "";
  success.value = "";
  try {
    const confirm = { password: password.value, ...factorProof(proof.value) };
    if (mode.value === "template") {
      await api(
        `/admin/contract-templates${editing.value ? `/${editing.value}` : ""}`,
        { method: editing.value ? "PUT" : "POST", body: template },
      );
      await refreshTemplates();
      success.value = "合同模板已保存，已有合同的文本不受影响。";
    } else if (mode.value === "contract" && contract.value) {
      await api(`/admin/contracts/${contract.value.id}/void`, {
        method: "POST",
        body: { reason: reason.value, ...confirm },
      });
      await refreshContracts();
      success.value = "合同已作废，原文本与签署事实仍保留。";
    } else if (
      mode.value === "tax" &&
      tax.value &&
      action.value === "red-letter"
    ) {
      await api(`/admin/tax-requests/${tax.value.id}/red-letter`, {
        method: "POST",
        body: {
          invoiceNumber: invoiceNumber.value,
          reason: reason.value,
          ...(documentUrl.value ? { documentUrl: documentUrl.value } : {}),
          ...confirm,
        },
      });
      await refreshRequests();
      success.value = "红冲登记已保存，原始票据保留。退款需另行核对办理。";
    } else if (mode.value === "tax" && tax.value) {
      await api(`/admin/tax-requests/${tax.value.id}/process`, {
        method: "POST",
        body: {
          action: action.value,
          reason: reason.value,
          ...(invoiceNumber.value
            ? { invoiceNumber: invoiceNumber.value }
            : {}),
          ...(documentUrl.value ? { documentUrl: documentUrl.value } : {}),
          ...(trackingNumber.value
            ? { trackingNumber: trackingNumber.value }
            : {}),
          ...confirm,
        },
      });
      await refreshRequests();
      success.value = "开票处理结果已保存。";
    }
    mode.value = "";
    clear();
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
watch(tab, () => {
  mode.value = "";
  clear();
});
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">业务留档</p>
        <h1>合同与开票</h1>
        <p class="muted">
          维护合同文本，核对签署事实，按实际票据处理客户申请。
        </p>
      </div>
      <AppLink to="/admin">管理概况</AppLink>
    </div>
    <div class="identity-actions mb-6">
      <KimaButton
        v-for="item in [
          { id: 'tax', label: '开票申请' },
          { id: 'contracts', label: '合同记录' },
          { id: 'templates', label: '合同模板' },
        ]"
        :key="item.id"
        :variant="tab === item.id ? 'filled' : 'tonal'"
        :aria-pressed="tab === item.id"
        @click="router.push({ query: { ...route.query, tab: item.id } })"
        >{{ item.label }}</KimaButton
      >
    </div>
    <KimaAlert
      v-if="error"
      variant="danger"
      :description="apiMessage(error)"
    /><KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    />
    <div class="identity-grid">
      <section class="panel">
        <template v-if="tab === 'templates'"
          ><div class="panel-header">
            <h2>合同模板</h2>
            <KimaButton variant="tonal" @click="editTemplate()"
              >新建模板</KimaButton
            >
          </div>
          <KimaEmptyState
            v-if="templates && !templates.length"
            heading="还没有合同模板"
            description="保存启用的模板后，客户即可申请合同。"
          />
          <article
            v-for="item in templates"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.title }}</h3>
            <p class="muted">
              {{ item.active ? "可申请" : "已停用" }} ·
              {{
                item.productIds.length
                  ? `${item.productIds.length}个适用商品`
                  : "适用于全部商品及账户"
              }}
            </p>
            <KimaButton variant="tonal" @click="editTemplate(item)"
              >编辑模板</KimaButton
            >
          </article></template
        ><template v-else-if="tab === 'contracts'"
          ><div class="panel-header"><h2>合同记录</h2></div>
          <KimaEmptyState
            v-if="contracts && !contracts.length"
            heading="暂无合同记录"
            description="客户申请后会显示在这里。"
          />
          <article
            v-for="item in contracts"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.snapshot.title }}</h3>
            <p>
              #{{ item.number }} ·
              {{ item.status === "pending" ? "待签署" : labels[item.status] }}
            </p>
            <p class="muted">
              {{ item.email }} · {{ item.snapshot.party.name }}
            </p>
            <KimaButton variant="tonal" @click="viewContract(item)"
              >核对合同</KimaButton
            >
          </article></template
        ><template v-else
          ><div class="panel-header"><h2>开票申请</h2></div>
          <KimaEmptyState
            v-if="requests && !requests.length"
            heading="暂无开票申请"
            description="客户提交申请后，可在这里审核和登记交付。"
          />
          <article
            v-for="item in requests"
            :key="item.id"
            class="identity-record"
          >
            <h3>{{ item.profile.title }}</h3>
            <p>
              {{
                money(
                  item.amountCents,
                  item.currency || "CNY",
                  item.currencyDecimals,
                )
              }}
              ·
              {{ labels[item.status] ?? item.status }}
            </p>
            <p class="muted">#{{ item.number }} · {{ item.email }}</p>
            <KimaButton variant="tonal" @click="viewTax(item)">{{
              ["pending", "approved"].includes(item.status)
                ? "处理申请"
                : "查看记录"
            }}</KimaButton>
          </article></template
        >
      </section>
      <section class="panel">
        <form
          v-if="mode === 'template'"
          class="identity-stack"
          @submit.prevent="submit"
        >
          <h2>{{ editing ? "编辑模板" : "新建模板" }}</h2>
          <label
            ><span>标题</span
            ><KimaTextField
              v-model="template.title"
              label="合同模板标题"
              required
              maxlength="200" /></label
          ><label
            ><span>合同正文</span
            ><KimaTextarea
              v-model="template.content"
              label="合同正文"
              required
              :maxlength="50000"
              :rows="12"
          /></label>
          <p class="muted" v-pre>
            正文可使用 {{ name }}、{{ company }}、{{ service }}、{{
              product
            }}，生成合同时会替换为当次签约资料。
          </p>
          <fieldset>
            <legend>适用商品（不选表示全部）</legend>
            <label
              v-for="item in products"
              :key="item.id"
              class="identity-check"
              ><input
                v-model="template.productIds"
                type="checkbox"
                :value="item.id"
              />{{ item.name }}</label
            >
          </fieldset>
          <label class="identity-check"
            ><input
              v-model="template.active"
              type="checkbox"
            />启用此模板</label
          ><KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton type="submit" :loading="busy" :disabled="busy"
              >保存模板</KimaButton
            ><KimaButton variant="text" @click="mode = ''">取消</KimaButton>
          </div>
        </form>
        <div v-else-if="mode === 'contract' && contract" class="identity-stack">
          <h2>{{ contract.snapshot.title }}</h2>
          <p class="muted">
            合同 #{{ contract.number }} ·
            {{
              contract.status === "pending" ? "待签署" : labels[contract.status]
            }}
          </p>
          <p>
            {{ contract.snapshot.party.name }} ·
            {{ contract.snapshot.party.company }}
          </p>
          <p class="muted break-all">
            {{ contract.snapshot.party.address }} ·
            {{ contract.snapshot.party.phone }} ·
            {{ contract.snapshot.party.email }}
          </p>
          <div class="whitespace-pre-wrap break-words leading-7">
            {{ contract.snapshot.content }}
          </div>
          <p v-if="contract.signedAt">
            {{ contract.signer }} 于 {{ date(contract.signedAt) }} 签署
          </p>
          <code class="identity-secret">{{ contract.snapshotHash }}</code>
          <p v-if="contract.voidReason">作废原因：{{ contract.voidReason }}</p>
          <a
            :href="`${base}/contracts/${contract.id}/document`"
            download
            class="min-h-11 inline-flex items-center"
            >下载合同PDF</a
          >
          <form
            v-if="contract.status === 'signed'"
            class="identity-stack"
            @submit.prevent="submit"
          >
            <h3>作废合同</h3>
            <label
              ><span>原因</span
              ><KimaTextarea
                v-model="reason"
                label="合同作废原因"
                required
                :maxlength="1000"
            /></label>
            <div class="identity-proof identity-stack">
              <label
                ><span>管理员当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="管理员当前密码"
                  type="password"
                  required
                  autocomplete="current-password" /></label
              ><SecondFactor v-model="proof" />
            </div>
            <KimaAlert
              v-if="message"
              variant="danger"
              :description="message"
            /><KimaButton type="submit" :loading="busy" :disabled="busy"
              >确认作废并保留记录</KimaButton
            >
          </form>
        </div>
        <div v-else-if="mode === 'tax' && tax" class="identity-stack">
          <h2>{{ tax.profile.title }}</h2>
          <p>
            申请 #{{ tax.number }} ·
            {{
              money(
                tax.amountCents,
                tax.currency || "CNY",
                tax.currencyDecimals,
              )
            }}
            ·
            {{ labels[tax.status] }}
          </p>
          <dl class="identity-stack">
            <div>
              <dt class="muted">发票类型</dt>
              <dd>
                {{
                  tax.profile.invoiceType === "special"
                    ? "专用发票"
                    : "普通发票"
                }}
              </dd>
            </div>
            <div v-if="tax.profile.taxNumber">
              <dt class="muted">税号</dt>
              <dd class="break-all">{{ tax.profile.taxNumber }}</dd>
            </div>
            <div v-if="tax.profile.bank">
              <dt class="muted">开户银行及账号</dt>
              <dd class="break-all">
                {{ tax.profile.bank }} · {{ tax.profile.bankAccount }}
              </dd>
            </div>
            <div v-if="tax.profile.address">
              <dt class="muted">注册地址及电话</dt>
              <dd class="break-words">
                {{ tax.profile.address }} · {{ tax.profile.phone }}
              </dd>
            </div>
            <div>
              <dt class="muted">接收邮箱</dt>
              <dd class="break-all">{{ tax.profile.email }}</dd>
            </div>
            <div v-if="tax.profile.shippingAddress">
              <dt class="muted">寄送地址</dt>
              <dd class="break-words">{{ tax.profile.shippingAddress }}</dd>
            </div>
            <div v-if="tax.note">
              <dt class="muted">客户说明</dt>
              <dd class="whitespace-pre-wrap">{{ tax.note }}</dd>
            </div>
          </dl>
          <p v-if="tax.invoiceNumber">实际票号：{{ tax.invoiceNumber }}</p>
          <KimaAlert v-if="tax.redDocument" heading="已登记全额红冲"
            >红字票号：{{ tax.redDocument.invoiceNumber }}。{{
              tax.redDocument.reason
            }}<KimaLink
              v-if="tax.redDocument.documentUrl"
              :href="tax.redDocument.documentUrl"
              target="_blank"
              >查看红字发票</KimaLink
            ></KimaAlert
          >
          <p v-if="tax.trackingNumber">寄送单号：{{ tax.trackingNumber }}</p>
          <p v-if="tax.decisionReason">处理说明：{{ tax.decisionReason }}</p>
          <a
            :href="`${base}/tax-requests/${tax.id}/document`"
            download
            class="min-h-11 inline-flex items-center"
            >下载申请记录</a
          >
          <p
            v-if="tax.status === 'issued' && !tax.redDocument"
            class="form-hint"
          >
            商户完成全额红冲后，在此登记实际票号与凭据。登记不会自动退回现金。
          </p>
          <form
            v-if="
              ['pending', 'approved'].includes(tax.status) ||
              (tax.status === 'issued' && !tax.redDocument)
            "
            class="identity-stack"
            @submit.prevent="submit"
          >
            <div>
              <span>处理方式</span
              ><KimaSelect
                v-model="action"
                label="开票处理方式"
                :items="
                  tax.status === 'issued'
                    ? [
                        {
                          value: 'red-letter',
                          label: '登记实际已开具的全额红字发票',
                        },
                      ]
                    : [
                        { value: 'approve', label: '审核通过，等待开具' },
                        { value: 'issue', label: '登记实际已开具的发票' },
                        { value: 'reject', label: '驳回并说明原因' },
                      ]
                "
              />
            </div>
            <template v-if="['issue', 'red-letter'].includes(action)"
              ><label
                ><span>{{
                  action === "red-letter" ? "实际红字发票号码" : "实际发票号码"
                }}</span
                ><KimaTextField
                  v-model="invoiceNumber"
                  :label="
                    action === 'red-letter'
                      ? '实际红字发票号码'
                      : '实际发票号码'
                  "
                  required
                  maxlength="100" /></label
              ><label
                ><span>发票交付链接（选填）</span
                ><KimaTextField
                  v-model="documentUrl"
                  label="发票交付链接"
                  type="url"
                  placeholder="https://" /></label
              ><label v-if="action === 'issue'"
                ><span>寄送单号（选填）</span
                ><KimaTextField
                  v-model="trackingNumber"
                  label="发票寄送单号"
                  maxlength="100" /></label></template
            ><label
              ><span
                >处理说明{{
                  ["reject", "red-letter"].includes(action)
                    ? "（必填）"
                    : "（选填）"
                }}</span
              ><KimaTextarea
                v-model="reason"
                label="开票处理说明"
                :required="['reject', 'red-letter'].includes(action)"
                :maxlength="1000"
            /></label>
            <div class="identity-proof identity-stack">
              <label
                ><span>管理员当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="开票确认密码"
                  type="password"
                  required
                  autocomplete="current-password" /></label
              ><SecondFactor v-model="proof" />
            </div>
            <KimaAlert
              v-if="message"
              variant="danger"
              :description="message"
            /><KimaButton type="submit" :loading="busy" :disabled="busy"
              >保存处理结果</KimaButton
            >
          </form>
        </div>
        <div v-else>
          <h2>选择一条记录</h2>
          <p class="muted">
            合同签署与开票申请均保留当时的文本或抬头。作废合同、审核和登记开票均需重新核验管理员身份。
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
