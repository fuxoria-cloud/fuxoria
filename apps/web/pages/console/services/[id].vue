<!-- 服务详情：显示实际资源事实，取消和转移都先登记可追溯的申请。调用：/console/services/<ID>。 -->
<script setup lang="ts">
import type {
  ManagedService,
  ServiceGroup,
  Cancellation,
  ServiceTransfer,
} from "~/features/lifecycle";
import {
  cancellationNames,
  transferNames,
  periodNames,
} from "~/features/lifecycle";
import { canRenewService, serviceActionNames } from "~/features/service";
import type { FactorInput } from "~/features/factor";
import { factorProof } from "~/features/factor";
definePageMeta({ layout: "console", middleware: "account" });
useSeoMeta({ title: "服务详情", robots: "noindex, nofollow" });
const api = useApi(),
  route = useRoute(),
  router = useRouter(),
  account = useAccount();
const id = String(route.params.id);
const {
  data: service,
  pending,
  error,
  refresh,
} = await useAsyncData(`service-detail:${id}`, () =>
  api<ManagedService>(`/services/${id}`),
); // 当前归属由服务端重新核对
const { data: groups, refresh: refreshGroups } = await useAsyncData(
  "service-groups",
  () => api<ServiceGroup[]>("/service-groups"),
);
const { data: cancellations, refresh: refreshCancellations } =
  await useAsyncData("service-cancellations", () =>
    api<Cancellation[]>("/service-cancellations"),
  );
const { data: transfers, refresh: refreshTransfers } = await useAsyncData(
  "service-transfers",
  () => api<ServiceTransfer[]>("/service-transfers"),
);
const history = computed(
    () => cancellations.value?.filter((item) => item.serviceId === id) ?? [],
  ),
  transferHistory = computed(
    () => transfers.value?.filter((item) => item.serviceId === id) ?? [],
  );
const unresolved = computed(
  () =>
    history.value.some((item) =>
      ["pending", "approved", "executing"].includes(item.status),
    ) ||
    transferHistory.value.some(
      (item) =>
        item.status === "pending" &&
        new Date(item.expiresAt).getTime() > Date.now(),
    ),
);
const groupItems = computed(() => [
  { value: "", label: "未分组" },
  ...(groups.value ?? []).map((item) => ({ value: item.id, label: item.name })),
]);
const busy = ref(false),
  failure = ref(""),
  success = ref(""),
  drawer = ref(""),
  renewKey = ref("");
const editor = reactive({ name: "", remark: "", groupId: "" }),
  groupName = ref(""),
  mode = ref("end_of_period"),
  reason = ref(""),
  email = ref(""),
  password = ref(""),
  proof = ref<FactorInput>({ mode: "totp", code: "" }),
  factorOpen = ref(false);
const enabled = ref(false),
  withdrawing = ref<Cancellation | null>(null),
  deletingGroup = ref<ServiceGroup | null>(null);
const open = computed({
  get: () => !!drawer.value,
  set: (value: boolean) => {
    if (!value && !busy.value) drawer.value = "";
  },
});
const title = computed(
  () =>
    ({
      edit: "管理名称与分组",
      cancel: "申请取消服务",
      transfer: "转移给另一账户",
      autorenew: enabled.value ? "开启自动续费" : "关闭自动续费",
    })[drawer.value] ?? "服务操作",
);
function begin(action: string) {
  if (!service.value) return;
  failure.value = "";
  success.value = "";
  password.value = "";
  proof.value = { mode: "totp", code: "" };
  factorOpen.value = false;
  reason.value = "";
  email.value = "";
  drawer.value = action;
  Object.assign(editor, {
    name: service.value.name ?? service.value.productName ?? "",
    remark: service.value.remark ?? "",
    groupId: service.value.groupId ?? "",
  });
  enabled.value = !service.value.autoRenew;
  mode.value = service.value.dueAt ? "end_of_period" : "immediate";
}
async function reload() {
  await Promise.all([
    refresh(),
    refreshGroups(),
    refreshCancellations(),
    refreshTransfers(),
  ]);
}
/** 只有服务端确认后才改变视图；密码和第二因素不会放入页面缓存。 */
async function submit() {
  busy.value = true;
  failure.value = "";
  try {
    if (drawer.value === "edit")
      await api(`/services/${id}`, {
        method: "PATCH",
        body: { ...editor, groupId: editor.groupId || null },
      });
    if (drawer.value === "cancel")
      await api(`/services/${id}/cancellations`, {
        method: "POST",
        body: { mode: mode.value, reason: reason.value.trim() },
      });
    if (drawer.value === "transfer")
      await api(`/services/${id}/transfer`, {
        method: "POST",
        body: {
          ...(email.value.includes("@")
            ? { email: email.value.trim() }
            : { phone: email.value.trim() }),
          password: password.value,
          ...(factorOpen.value ? factorProof(proof.value) : {}),
        },
      });
    if (drawer.value === "autorenew")
      await api(`/services/${id}/auto-renew`, {
        method: "POST",
        body: {
          enabled: enabled.value,
          password: password.value,
          ...(factorOpen.value ? factorProof(proof.value) : {}),
        },
      });
    success.value =
      drawer.value === "cancel"
        ? "取消申请已提交，支持团队审核后会在这里更新。"
        : drawer.value === "transfer"
          ? "转移邀请已发出，等待对方确认。"
          : "已保存。";
    drawer.value = "";
    password.value = "";
    proof.value.code = "";
    await reload();
  } catch (reason_) {
    failure.value = apiMessage(reason_);
    if (/双因素|验证码|恢复码/.test(failure.value)) factorOpen.value = true;
  } finally {
    busy.value = false;
  }
}
async function addGroup() {
  if (!groupName.value.trim()) return;
  busy.value = true;
  failure.value = "";
  try {
    const saved = await api<ServiceGroup>("/service-groups", {
      method: "POST",
      body: { name: groupName.value.trim() },
    });
    await refreshGroups();
    editor.groupId = saved.id;
    groupName.value = "";
  } catch (reason_) {
    failure.value = apiMessage(reason_);
  } finally {
    busy.value = false;
  }
}
async function removeGroup() {
  if (!deletingGroup.value) return;
  busy.value = true;
  failure.value = "";
  try {
    const removed = deletingGroup.value.id;
    await api("/service-groups/" + removed, { method: "DELETE" });
    if (editor.groupId === removed) editor.groupId = "";
    deletingGroup.value = null;
    await reload();
  } catch (reason_) {
    failure.value = apiMessage(reason_);
  } finally {
    busy.value = false;
  }
}
async function withdraw() {
  if (!withdrawing.value) return;
  busy.value = true;
  failure.value = "";
  try {
    await api(`/service-cancellations/${withdrawing.value.id}/withdraw`, {
      method: "POST",
    });
    withdrawing.value = null;
    await reload();
    success.value = "申请已撤回。";
  } catch (reason_) {
    failure.value = apiMessage(reason_);
  } finally {
    busy.value = false;
  }
}
async function renew() {
  if (!service.value) return;
  busy.value = true;
  failure.value = "";
  try {
    if (!renewKey.value) renewKey.value = crypto.randomUUID();
    const result = await api<{
      invoiceId: string;
    }>(`/services/${id}/renew`, {
      method: "POST",
      headers: { "Idempotency-Key": renewKey.value },
      body: { period: service.value.billingPeriod ?? "month" },
    });
    renewKey.value = "";
    await router.push(`/console/invoices/${result.invoiceId}`);
  } catch (reason_) {
    failure.value = apiMessage(reason_);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div>
    <AppLink to="/console/services" :underline="false" class="auth-back mb-6"
      >返回我的服务</AppLink
    >
    <RequestState
      :pending="pending && !service"
      :error="error"
      @retry="refresh"
    />
    <template v-if="service && !error">
      <AppLink
        :to="`/console/resources/${id}`"
        class="inline-flex min-h-12 items-center mb-4"
        >控制与状态</AppLink
      >
      <header class="page-heading">
        <div>
          <p class="muted text-sm mb-2">{{ service.productName }}</p>
          <h1>{{ service.name || "服务详情" }}</h1>
          <p class="break-all">
            #{{ service.id.slice(0, 8) }} · {{ date(service.createdAt) }} 创建
          </p>
        </div>
        <StatusBadge :status="service.status" />
      </header>
      <KimaAlert
        v-if="failure && !drawer && !withdrawing && !deletingGroup"
        variant="danger"
        class="mb-5"
        >{{ failure }}</KimaAlert
      >
      <KimaAlert v-if="success" class="mb-5">{{ success }}</KimaAlert>
      <KimaAlert v-if="service.operation" class="mb-5" heading="操作正在处理中">
        {{ serviceActionNames[service.operation.action] }}
        已提交，实际状态会在供应商确认后更新。
        <AppLink
          v-if="account.user.value?.role === 'admin'"
          :to="'/admin?tab=jobs'"
          >查看任务</AppLink
        >
      </KimaAlert>
      <KimaAlert v-else-if="service.terminationRequestedAt" class="mb-5"
        >服务已有取消安排，请查看下方申请记录。</KimaAlert
      >
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="grid grid-cols-1 gap-6 min-w-0">
          <section class="panel p-6 sm:p-8">
            <h2 class="font-semibold text-xl">服务信息</h2>
            <dl class="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <dt class="muted text-sm">计费周期</dt>
                <dd class="mt-1">
                  {{ periodNames[service.billingPeriod] || "按当前合同" }}
                </dd>
              </div>
              <div>
                <dt class="muted text-sm">到期时间</dt>
                <dd class="mt-1">
                  {{
                    service.billingMonths === 0
                      ? "一次性服务"
                      : date(service.dueAt)
                  }}
                </dd>
              </div>
              <div>
                <dt class="muted text-sm">合同价格</dt>
                <dd class="mt-1">
                  {{
                    money(
                      service.priceCents || "0",
                      service.currency,
                      service.currencyDecimals,
                    )
                  }}
                </dd>
              </div>
              <div>
                <dt class="muted text-sm">资源标识</dt>
                <dd class="mt-1 break-all">
                  {{ service.externalId || "等待交付" }}
                </dd>
              </div>
              <div>
                <dt class="muted text-sm">服务分组</dt>
                <dd class="mt-1">
                  {{
                    groups?.find((item) => item.id === service!.groupId)
                      ?.name || "未分组"
                  }}
                </dd>
              </div>
              <div>
                <dt class="muted text-sm">自动续费</dt>
                <dd class="mt-1">
                  {{ service.autoRenew ? "已授权钱包续费" : "未开启" }}
                </dd>
              </div>
            </dl>
            <div
              v-if="Object.keys(service.configurationLabels || {}).length"
              class="mt-7"
            >
              <h3 class="font-medium mb-3">所选配置</h3>
              <dl class="grid grid-cols-1 gap-3">
                <div
                  v-for="(value, key) in service.configurationLabels"
                  :key="key"
                  class="flex flex-wrap justify-between gap-2"
                >
                  <dt class="muted">{{ key }}</dt>
                  <dd class="break-words">{{ value }}</dd>
                </div>
              </dl>
            </div>
            <div v-if="service.remark" class="mt-7">
              <h3 class="font-medium mb-3">我的备注</h3>
              <p class="whitespace-pre-wrap break-words">
                {{ service.remark }}
              </p>
            </div>
          </section>
          <section v-if="history.length" class="panel p-6">
            <h2 class="font-semibold text-xl mb-5">取消申请记录</h2>
            <article
              v-for="item in history"
              :key="item.id"
              class="py-5 first:pt-0"
            >
              <div class="flex flex-wrap justify-between gap-3">
                <h3 class="font-medium">
                  {{ item.mode === "immediate" ? "立即取消" : "到期取消" }}
                </h3>
                <KimaChip>{{
                  cancellationNames[item.status] || item.status
                }}</KimaChip>
              </div>
              <p class="mt-3 whitespace-pre-wrap break-words">
                {{ item.reason }}
              </p>
              <p
                v-if="item.decisionReason"
                class="muted mt-3 whitespace-pre-wrap"
              >
                审核说明：{{ item.decisionReason }}
              </p>
              <p v-if="item.executeAt" class="muted mt-2">
                安排时间：{{ date(item.executeAt) }}
              </p>
              <p class="muted mt-2 text-sm">{{ date(item.createdAt) }} 申请</p>
              <KimaButton
                v-if="['pending', 'approved'].includes(item.status)"
                variant="tonal"
                class="mt-4"
                :disabled="busy"
                @click="
                  withdrawing = item;
                  failure = '';
                "
              >
                撤回申请
              </KimaButton>
            </article>
          </section>
          <section v-if="transferHistory.length" class="panel p-6">
            <h2 class="font-semibold text-xl mb-5">服务转移记录</h2>
            <article
              v-for="item in transferHistory"
              :key="item.id"
              class="py-4 first:pt-0"
            >
              <p class="break-all">
                {{ item.senderEmail }} →
                {{
                  item.recipientEmail || item.recipientPhone || item.recipientId
                }}
              </p>
              <p class="muted mt-2">
                {{ transferNames[item.status] || item.status }} ·
                {{ date(item.createdAt) }}
              </p>
            </article>
            <AppLink
              to="/console/transfers"
              class="inline-flex min-h-11 items-center"
              >管理转移邀请</AppLink
            >
          </section>
        </div>
        <aside class="panel p-6 self-start">
          <h2 class="font-semibold text-lg">接下来想做什么？</h2>
          <div class="grid grid-cols-1 gap-3 mt-5">
            <AppLink
              v-if="
                ['active', 'suspended'].includes(service.status) &&
                !service.terminationRequestedAt &&
                !service.operation &&
                !unresolved
              "
              :to="`/console/upgrades?serviceId=${service.id}`"
              :underline="false"
              class="min-h-12 inline-flex items-center justify-center rounded-full bg-[var(--kima-color-primary-container)] text-[var(--kima-color-on-primary-container)]"
            >
              更改方案与配置
            </AppLink>
            <KimaButton :disabled="busy" variant="tonal" @click="begin('edit')"
              >名称、备注与分组</KimaButton
            >
            <KimaButton
              v-if="service.billingMonths !== 0 && canRenewService(service)"
              :loading="busy"
              @click="renew"
              >续费服务</KimaButton
            >
            <KimaButton
              v-if="
                service.autoRenew ||
                (service.billingMonths !== 0 && canRenewService(service))
              "
              variant="tonal"
              :disabled="busy"
              @click="begin('autorenew')"
            >
              {{ service.autoRenew ? "关闭" : "开启" }}自动续费
            </KimaButton>
            <KimaButton
              v-if="
                ['active', 'suspended'].includes(service.status) &&
                !service.terminationRequestedAt &&
                !service.operation &&
                !unresolved
              "
              variant="tonal"
              :disabled="busy"
              @click="begin('transfer')"
            >
              转移给另一账户
            </KimaButton>
            <KimaButton
              v-if="
                ['active', 'suspended'].includes(service.status) &&
                !service.terminationRequestedAt &&
                !unresolved
              "
              variant="text"
              :disabled="busy"
              @click="begin('cancel')"
            >
              申请取消服务
            </KimaButton>
            <KimaButton
              variant="text"
              @click="router.push('/console/tickets?new=1')"
              >联系支持团队</KimaButton
            >
          </div>
          <p class="form-hint mt-5">
            取消申请需要审核。转移需要对方确认，原订单与账单仍归原购买账户。
          </p>
        </aside>
      </div>
    </template>
    <KimaDrawer
      v-model:open="open"
      :title="title"
      :role="['cancel', 'transfer'].includes(drawer) ? 'alertdialog' : 'dialog'"
      placement="right"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form
        id="service-management"
        class="drawer-form"
        @submit.prevent="submit"
      >
        <template v-if="drawer === 'edit'">
          <label class="field-label min-w-0">
            <span class="form-label">服务名称</span>
            <KimaTextField
              v-model="editor.name"
              label="服务名称"
              required
              maxlength="100"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">我的备注</span>
            <KimaTextarea
              v-model="editor.remark"
              label="我的备注"
              :maxlength="1000"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">服务分组</span>
            <KimaSelect
              v-model="editor.groupId"
              label="服务分组"
              :items="groupItems"
              :disabled="busy"
            />
          </label>
          <div class="grid grid-cols-1 gap-3">
            <label class="field-label min-w-0">
              <span class="form-label">新建分组</span>
              <KimaTextField
                v-model="groupName"
                label="新建分组"
                maxlength="80"
                :disabled="busy"
              />
            </label>
            <KimaButton
              variant="tonal"
              type="button"
              :disabled="busy || !groupName.trim()"
              @click="addGroup"
              >添加分组</KimaButton
            >
            <div
              v-for="item in groups"
              :key="item.id"
              class="flex flex-wrap justify-between gap-3 items-center"
            >
              <span>{{ item.name }}</span>
              <KimaButton
                variant="text"
                type="button"
                :disabled="busy"
                @click="
                  deletingGroup = item;
                  failure = '';
                "
                >删除分组</KimaButton
              >
            </div>
          </div>
        </template>
        <template v-if="drawer === 'cancel'">
          <KimaAlert
            >申请提交后由支持团队审核。批准立即取消后，服务会进入终止流程；到期取消会在批准的时间执行。</KimaAlert
          >
          <label class="field-label min-w-0">
            <span class="form-label">希望何时取消</span>
            <KimaSelect
              v-model="mode"
              label="希望何时取消"
              :items="[
                { value: 'immediate', label: '审核后立即取消' },
                ...(service?.dueAt
                  ? [
                      {
                        value: 'end_of_period',
                        label: '当前计费周期到期后取消',
                      },
                    ]
                  : []),
              ]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">取消原因</span>
            <KimaTextarea
              v-model="reason"
              label="取消原因"
              required
              :maxlength="1000"
              :disabled="busy"
            />
          </label>
        </template>
        <template v-if="drawer === 'transfer'">
          <KimaAlert
            >对方接收后会获得这份服务的管理权。原账单和余额保留在你的账户中，自动续费授权会关闭，服务分组与个人备注会清空。</KimaAlert
          >
          <label class="field-label min-w-0">
            <span class="form-label">接收方已验证邮箱或手机号</span>
            <KimaTextField
              v-model="email"
              label="接收方已验证邮箱或手机号"
              type="text"
              required
              maxlength="254"
              autocomplete="username"
              :disabled="busy"
            />
          </label>
        </template>
        <KimaAlert v-if="drawer === 'autorenew'">
          {{
            enabled
              ? `开启后，在到期前${service?.autoRenewWindowSeconds === 900 ? "15分钟" : service?.autoRenewWindowSeconds === 21600 ? "6小时" : "24小时"}内按当前合同周期续费，只使用账户钱包余额。余额不足会留下待付账单并发送站内消息。`
              : "关闭后，将不再根据这份授权发起新的自动续费；已有账单可在账单列表查看。"
          }}
        </KimaAlert>
        <template v-if="['transfer', 'autorenew'].includes(drawer)">
          <label class="field-label min-w-0">
            <span class="form-label">当前登录密码</span>
            <KimaTextField
              v-model="password"
              label="当前登录密码"
              type="password"
              autocomplete="current-password"
              required
              maxlength="128"
              :disabled="busy"
            />
          </label>
          <KimaCollapsible
            v-model:open="factorOpen"
            label="已启用双因素认证？填写安全验证"
          >
            <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
          </KimaCollapsible>
        </template>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="drawer = ''"
          >取消</KimaButton
        >
        <KimaButton type="submit" form="service-management" :loading="busy">
          {{
            drawer === "cancel"
              ? "提交申请"
              : drawer === "transfer"
                ? "发出转移邀请"
                : "确认保存"
          }}
        </KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      :open="!!withdrawing"
      title="撤回这次取消申请？"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!busy"
      @update:open="
        (value: boolean) => {
          if (!value) withdrawing = null;
        }
      "
    >
      <p>撤回后服务继续按当前状态运行。</p>
      <KimaAlert v-if="failure" variant="danger" class="mt-4">{{
        failure
      }}</KimaAlert>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="withdrawing = null"
          >保留申请</KimaButton
        >
        <KimaButton :loading="busy" @click="withdraw">确认撤回</KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      :open="!!deletingGroup"
      title="删除这个服务分组？"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!busy"
      @update:open="
        (value: boolean) => {
          if (!value) deletingGroup = null;
        }
      "
    >
      <p>{{ deletingGroup?.name }} 内的服务会回到未分组，服务仍然保留。</p>
      <KimaAlert v-if="failure" variant="danger" class="mt-4">{{
        failure
      }}</KimaAlert>
      <template #footer>
        <KimaButton
          variant="tonal"
          :disabled="busy"
          @click="deletingGroup = null"
          >保留</KimaButton
        >
        <KimaButton :loading="busy" @click="removeGroup">确认删除</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
