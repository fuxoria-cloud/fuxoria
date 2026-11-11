<!-- 购物车：同一修订只结算一次，未确认的提交保留原幂等键。调用：登录后访问/console/cart。 -->
<script setup lang="ts">
import {
  Add01Icon,
  Remove01Icon,
  Delete02Icon,
  ArrowLeft01Icon,
} from "@hugeicons/core-free-icons"; // 数量与移除都有48px控件
import type { Cart, CartItem, CartOrder } from "~/types/api"; // 报价与可结算状态只认服务器
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: "console", middleware: "account" }); // 每个购物车属于当前会话账号
useSeoMeta({ title: "购物车", robots: "noindex, nofollow" }); // 购买意图不参与搜索索引
const api = useApi();
const account = useAccount(); // 服务端独立验证所有权与金额
const { data, pending, error, refresh } = await useAsyncData("cart", () =>
  api<Cart>("/cart"),
); // 每次变更后重新读取修订号
const busy = ref("");
const message = ref(""); // 同一时刻只变更或结算一次
const code = ref("");
const intent = ref<{ key: string; revision: string; order?: CartOrder } | null>(
  null,
); // 未确认时只重试这一份提交
const storageKey = computed(() =>
  account.user.value ? `yunzou:cart-checkout:${account.user.value.id}` : null,
); // 外观存储按账号隔离，不保存密码和会话
let storage: Storage | undefined; // 只在浏览器存在的短期意图存储
function restoreIntent() {
  // 恢复上一份未确认订单，只取原key与revision
  if (!storage || !storageKey.value) return; // 身份或浏览器存储未就绪时不读其它账号记录
  try {
    const saved = storage.getItem(storageKey.value); // 不把保存的显示金额当作真实交易事实
    if (!saved) return;
    const parsed = JSON.parse(saved) as { key?: unknown; revision?: unknown }; // 本地存储属于输入边界
    if (
      typeof parsed.key === "string" &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(parsed.key) &&
      typeof parsed.revision === "string" &&
      parsed.revision.length <= 500
    )
      intent.value = { key: parsed.key, revision: parsed.revision }; // 只允许重放固定请求，不恢复未核实的订单元数据
  } catch {
    message.value = "浏览器暂时无法恢复提交记录，请留在本页核对订单。";
  }
}
onMounted(() => {
  // 浏览器存储只在客户端使用
  try {
    storage = window.sessionStorage;
    restoreIntent();
  } catch {
    // 刷新前后的重试使用同一个标识
    message.value =
      "浏览器暂时无法保留提交记录，请在本页完成订单确认后再离开。";
  }
});

function remember() {
  // 请求发出前先保存可重试的原始意图
  try {
    if (!storageKey.value) return;
    if (intent.value)
      storage?.setItem(
        storageKey.value,
        JSON.stringify({
          key: intent.value.key,
          revision: intent.value.revision,
        }),
      );
    else storage?.removeItem(storageKey.value);
  } catch {
    // 网络中断或刷新后仍复用同键
    message.value = "浏览器无法保留提交记录，请留在本页继续确认订单。";
  } // 仍可在当前页面用内存中的同一键重试
}

/** @param item 当前产品。@param quantity 1至20的完整数量。 */
async function change(item: CartItem, quantity: number) {
  // 每次变更都以真实API结果刷新修订号
  busy.value = item.lineId || item.productId;
  message.value = ""; // 提交期间不并发改数量和结算
  try {
    await api("/cart", {
      method: "PUT",
      body: {
        productId: item.productId,
        quantity,
        period: item.period,
        ...(item.lineId
          ? { lineId: item.lineId, configuration: item.configuration || {} }
          : {}),
      },
    });
    await refresh();
  } catch (error) {
    // 浏览器不重算成交金额
    message.value = apiMessage(error);
  } finally {
    // 库存或版本冲突可修正后再试
    busy.value = "";
  }
}

/** @param item 要移除的产品。 */
async function remove(item: CartItem) {
  // 只移除当前账号这一项购买意图
  busy.value = item.lineId || item.productId;
  message.value = ""; // 不与结算并发发送
  try {
    await api(
      item.lineId ? `/cart/items/${item.lineId}` : `/cart/${item.productId}`,
      { method: "DELETE" },
    );
    await refresh();
  } catch (error) {
    // 服务端生成新修订
    message.value = apiMessage(error);
  } finally {
    busy.value = "";
  }
}

async function promotion(remove = false) {
  busy.value = "promotion";
  message.value = "";
  try {
    await api("/cart/promotion", {
      method: "PUT",
      body: { code: remove ? null : code.value },
    });
    code.value = "";
    await refresh();
  } catch (error) {
    message.value = apiMessage(error);
  } finally {
    busy.value = "";
  }
}

/** 创建一个包含多项服务的订单；Redis同步失败只重试原订单，不生成新幂等键。 */
async function checkout() {
  busy.value = "checkout";
  message.value = ""; // 未确认时冻结其它购物车编辑
  try {
    if (!account.user.value) {
      await account.load();
      restoreIntent();
    } // 身份读取曾失败时先恢复账号对应的原提交
    if (!intent.value)
      intent.value = {
        key: crypto.randomUUID(),
        revision: data.value!.revision!,
      }; // 固定用户看到的修订与一次性提交键
    remember(); // 先保留，再发出有资金含义的请求
    const order = await api<CartOrder>("/cart/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": intent.value.key },
      body: { revision: intent.value.revision },
    }); // 金额、库存与免费方案由后端计算
    if (order.cartCleared === false) {
      // 订单已创建但购物车同步还未确认
      intent.value.order = order;
      remember(); // 下一次与刷新后都继续使用原key和revision
      message.value =
        order.message ||
        "订单已创建，购物车还在同步。请重试确认这一次提交，不要重新下单。";
      return; // 不清空意图，不允许以新键再次购买
    }
    intent.value = null;
    remember(); // 真实确认后才允许下一次新的结算
    await router.push(
      order.status === "paid"
        ? "/console/services"
        : `/console/invoices/${order.invoiceId}`,
    ); // 免费方案直接查看交付，付费方案先核对账单
  } catch (failure) {
    message.value = apiMessage(failure); // 网络错误保留原提交标识等待重试
    const status = (failure as { statusCode?: number }).statusCode; // 明确4xx表示这次请求被服务端拒绝
    if (
      status &&
      [400, 404, 409, 422].includes(status) &&
      !intent.value?.order?.orderConfirmed
    ) {
      intent.value = null;
      remember();
      await refresh();
    } // 修正库存或修订冲突后才能发起新意图
  } finally {
    busy.value = "";
  }
}
</script>
<template>
  <div>
    <AppLink to="/products" :underline="false" class="auth-back mb-6">
      <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
      继续浏览产品
    </AppLink>
    <header class="page-heading">
      <div>
        <h1>购物车</h1>
        <p>把需要的资源放在一起，再核对一次。</p>
      </div>
    </header>
    <KimaAlert
      v-if="message"
      class="mb-6"
      :variant="intent?.order ? 'info' : 'danger'"
    >
      {{ message }}
    </KimaAlert>
    <KimaAlert v-if="intent" class="mb-6" heading="先核对上一次提交">
      重试只会核对先前提交的订单。下方保留的是当前购物车，内容可能已经变化，不会随这次重试再次购买。
    </KimaAlert>
    <RequestState
      :pending="pending"
      :error="error"
      :empty="!data?.items.length && !intent && !pending && !error"
      title="购物车还是空的"
      description="去挑选一份适合你的云上资源。"
      @retry="refresh"
    />
    <div v-if="data?.items.length || intent" class="cart-layout">
      <section class="cart-items" aria-label="当前购物车">
        <h2 v-if="intent">当前购物车</h2>
        <KimaCard
          v-for="item in data?.items || []"
          :key="item.lineId || item.productId"
          class="cart-item"
        >
          <div class="cart-item-heading">
            <div>
              <h2>{{ item.productName }}</h2>
              <p class="muted text-sm">
                {{
                  item.unitPriceCents === null
                    ? "报价不可用"
                    : `${money(item.unitPriceCents, item.currency || data?.currency, item.currencyDecimals ?? data?.currencyDecimals)} · ${item.periodLabel || "月付"}`
                }}
              </p>
              <p
                v-for="(value, label) in item.configurationLabels || {}"
                :key="label"
                class="muted text-sm"
              >
                {{ label }}：{{ value }}
              </p>
            </div>
            <KimaIconButton
              :icon="Delete02Icon"
              :label="`移除${item.productName}`"
              :disabled="!!busy || !!intent"
              @click="remove(item)"
            />
          </div>
          <KimaAlert v-if="!item.available" variant="warning" class="mt-4">
            {{ item.problem || "此项当前不可购买，请核对库存或移除后继续。" }}
          </KimaAlert>
          <div class="cart-item-bottom">
            <div class="cart-quantity" :aria-label="`${item.productName}数量`">
              <KimaIconButton
                :icon="Remove01Icon"
                label="减少数量"
                :disabled="!!busy || !!intent || item.quantity <= 1"
                @click="change(item, item.quantity - 1)"
              />
              <span class="numbers">{{ item.quantity }}</span>
              <KimaIconButton
                :icon="Add01Icon"
                label="增加数量"
                :disabled="
                  !!busy || !!intent || item.quantity >= 20 || !item.available
                "
                @click="change(item, item.quantity + 1)"
              />
            </div>
            <strong class="numbers">
              {{
                item.amountCents === null
                  ? "待重新核对"
                  : money(
                      item.amountCents,
                      item.currency || data?.currency,
                      item.currencyDecimals ?? data?.currencyDecimals,
                    )
              }}
            </strong>
          </div>
        </KimaCard>
      </section>
      <KimaCard class="cart-summary">
        <h2>{{ intent ? "先前提交核对" : "核对订单" }}</h2>
        <p v-if="intent" class="muted text-sm mt-4">
          {{
            intent.order?.items
              ? `${intent.order.items.reduce((sum, item) => sum + item.quantity, 0)} 项服务`
              : "原订单数量待核对"
          }}
        </p>
        <p v-else class="muted text-sm mt-4">
          {{
            data?.items.reduce((sum, item) => sum + item.quantity, 0) || 0
          }}
          项服务
        </p>
        <div v-if="!intent" class="grid grid-cols-1 gap-3 mt-6">
          <label class="grid grid-cols-1 gap-2"
            ><span class="text-sm">优惠码</span
            ><KimaTextField
              v-model="code"
              label="优惠码"
              placeholder="输入优惠码"
              :disabled="!!busy"
              @keydown.enter.prevent="promotion()"
          /></label>
          <KimaButton
            variant="tonal"
            :disabled="!!busy || !code.trim()"
            @click="promotion()"
            >使用优惠码</KimaButton
          >
          <p v-if="data?.promotionCode" class="text-sm">
            已使用 {{ data.promotionCode }}
            <KimaButton
              variant="text"
              :disabled="!!busy"
              @click="promotion(true)"
              >移除</KimaButton
            >
          </p>
          <KimaAlert v-if="data?.promotionProblem" variant="warning">{{
            data.promotionProblem
          }}</KimaAlert>
          <p
            v-if="data?.discountCents && data.discountCents !== '0'"
            class="text-sm muted"
          >
            本次共优惠
            {{
              money(data.discountCents, data.currency, data.currencyDecimals)
            }}
          </p>
        </div>
        <div class="invoice-total">
          <span>合计</span>
          <strong>
            {{
              intent?.order?.amountCents != null
                ? money(
                    intent.order.amountCents,
                    intent.order.currency,
                    intent.order.currencyDecimals,
                  )
                : intent
                  ? "待核对"
                  : data?.amountCents != null
                    ? money(
                        data.amountCents,
                        data.currency,
                        data.currencyDecimals,
                      )
                    : "待核对"
            }}
          </strong>
        </div>
        <p class="form-hint">
          {{
            intent
              ? "原订单金额只在服务端确认后显示，不使用当前购物车报价代替。"
              : "应付金额和库存将在提交时再次核对。免费方案会直接进入交付流程。"
          }}
        </p>
        <KimaButton
          class="w-full mt-6"
          :loading="busy === 'checkout'"
          :disabled="!!busy || (!intent && !data?.canCheckout)"
          @click="checkout"
        >
          {{ intent ? "重试确认本次订单" : "确认，创建订单" }}
        </KimaButton>
        <KimaButton
          v-if="intent?.order?.invoiceId"
          variant="tonal"
          class="w-full mt-4"
          @click="router.push(`/console/invoices/${intent!.order!.invoiceId}`)"
        >
          查看已创建的账单
        </KimaButton>
      </KimaCard>
    </div>
  </div>
</template>
