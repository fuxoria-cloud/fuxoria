<!-- 产品目录：价格、库存来自实时 API，静态生成时不写入演示商品。调用：访问 /products。 -->
<script setup lang="ts">
import {
  ServerStack01Icon,
  Tick01Icon,
  ArrowRight01Icon,
  PackageDeliveredIcon,
} from "@hugeicons/core-free-icons"; // 图标只是辅助信息
import type { Product, BillingPeriod } from "~/types/api"; // 与服务端产品契约保持一致
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
useSeoMeta({
  title: "产品与价格",
  description: "查看狐岚云当前可购买的云产品、价格和库存，选择适合你的服务。",
}); // 公开目录可被索引
const api = useApi(); // 下单只调用服务器，不在浏览器计算价格
const {
  data: products,
  pending,
  error,
  refresh,
} = await useAsyncData("products", () => api<Product[]>("/products"), {
  server: false,
}); // 价格在打开页面时更新
const buying = ref(""); // 同一时刻只发起一个下单请求
const message = ref(""); // 购买错误显示在商品列表附近
const keys = new Map<string, string>(); // 网络重试沿用同一个幂等键，避免重复下单
const selected = ref<Product | null>(null),
  selecting = ref(false),
  selectionAction = ref<"buy" | "cart">("buy");
const group = ref("");
const { data: catalogue } = await useAsyncData(
  "catalogue",
  () =>
    api<{
      groups: { id: string; name: string }[];
      periods: { period: BillingPeriod; label: string }[];
    }>("/catalogue"),
  { server: false },
);
const shown = computed(() =>
  products.value?.filter(
    (product) => !group.value || product.groupId === group.value,
  ),
);
function configure(product: Product, action: "buy" | "cart") {
  selected.value = product;
  selectionAction.value = action;
  selecting.value = true;
}
function startingPrice(product: Product) {
  const values = (product.periods || [])
    .filter((item) => item.active)
    .map((item) => item.priceCents);
  if (!product.periods?.some((item) => item.period === "month"))
    values.push(product.priceCents);
  return values.reduce(
    (lowest, value) => (BigInt(value) < BigInt(lowest) ? value : lowest),
    values[0] || product.priceCents,
  );
}
/** @param product 要购买的真实产品。 */
async function buy(product: Product) {
  if (product.options?.length || product.periods?.length) {
    configure(product, "buy");
    return;
  }
  // 点击才确认登录并创建订单
  buying.value = product.id;
  message.value = ""; // 立即显示正在处理，防止连点
  try {
    // 用户操作入口接住网络与业务错误
    const key = keys.get(product.id) || crypto.randomUUID(); // 同一个未完成购买复用标识
    keys.set(product.id, key); // 网络超时时重试不会多开一张账单
    const order = await api<{ invoiceId: string; status: string }>("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: { productId: product.id, period: "month" },
    }); // 金额由服务端读取当前产品计算
    keys.delete(product.id); // 成功后下一次购买是新订单
    await router.push(
      order.status === "paid"
        ? "/console/services"
        : `/console/invoices/${order.invoiceId}`,
    ); // 进入核对与支付页面
  } catch (failure) {
    // 用户可以登录或修改输入后重试
    if ((failure as { statusCode?: number }).statusCode === 401) {
      await router.push("/login?next=/products");
      return;
    } // 未登录不丢失产品目录入口
    message.value = apiMessage(failure); // 展示库存、价格或网络的具体原因
  } finally {
    buying.value = "";
  } // 入口结束后恢复按钮
}

/** @param product 当前可购买的真实产品。 */
async function add(product: Product) {
  if (product.options?.length || product.periods?.length) {
    configure(product, "cart");
    return;
  }
  // 购物车不预占库存，结算时再统一核对
  buying.value = product.id;
  message.value = "";
  try {
    await api("/cart", {
      method: "POST",
      body: { productId: product.id, quantity: 1, period: "month" },
    }); // 金额和修订号由服务端维护
    await router.push("/console/cart"); // 加入成功后让用户核对数量与其它项目
  } catch (failure) {
    if ((failure as { statusCode?: number }).statusCode === 401) {
      await router.push("/login?next=/products");
      return;
    } // 登录后仍回到产品选择
    message.value = apiMessage(failure);
  } finally {
    buying.value = "";
  }
}
</script>
<template>
  <div class="page-width">
    <header class="catalog-heading">
      <div class="catalog-cart-link">
        <KimaButton variant="tonal" @click="router.push('/console/cart')"
          >查看购物车</KimaButton
        >
      </div>
      <span class="eyebrow">
        <span class="eyebrow-dot" />
        为下一份创造，选好起点
      </span>
      <h1>找到适合你的云。</h1>
      <p class="section-description">
        先选资源，再核对账单。价格和库存会在这里更新。
      </p>
    </header>
    <section class="catalog-body" aria-label="可购买产品">
      <div v-if="catalogue?.groups.length" class="mb-6 max-w-sm">
        <KimaSelect
          v-model="group"
          label="产品分组"
          :items="[
            { value: '', label: '全部产品' },
            ...catalogue.groups.map((item) => ({
              value: item.id,
              label: item.name,
            })),
          ]"
        />
      </div>
      <KimaAlert v-if="message" variant="danger" class="mb-6">{{
        message
      }}</KimaAlert>
      <RequestState
        :pending="pending"
        :error="error"
        :empty="products?.length === 0"
        title="产品正在准备中"
        description="当前还没有上架产品，可以稍后再来看看。"
        action="返回首页"
        to="/"
        @retry="refresh"
      />
      <div v-if="!pending && !error && products?.length" class="product-grid">
        <KimaCard
          v-for="product in shown"
          :key="product.id"
          class="product-card"
        >
          <div class="product-card-content">
            <div class="feature-icon">
              <KimaIcon :icon="ServerStack01Icon" :size="32" />
            </div>
            <h2>{{ product.name }}</h2>
            <p>{{ product.description }}</p>
            <div class="mt-auto">
              <div class="product-price">
                <strong>{{
                  money(
                    startingPrice(product),
                    product.currency,
                    product.currencyDecimals,
                  )
                }}</strong>
                <span>{{
                  product.periods?.length ? "起 / 周期可选" : "/ 月"
                }}</span>
              </div>
              <p class="product-stock">
                <KimaIcon :icon="PackageDeliveredIcon" :size="20" />
                {{
                  product.stock === 0
                    ? "暂时售罄"
                    : product.stock == null
                      ? "可购买"
                      : `剩余 ${product.stock} 份`
                }}
              </p>
              <KimaButton
                :disabled="!!buying || product.stock === 0"
                :loading="buying === product.id"
                @click="buy(product)"
              >
                {{ product.stock === 0 ? "暂时售罄" : "选择这款" }}
                <template #trailing
                  ><KimaIcon :icon="ArrowRight01Icon" :size="24"
                /></template>
              </KimaButton>
              <KimaButton
                variant="tonal"
                :disabled="!!buying || product.stock === 0"
                @click="add(product)"
              >
                加入购物车
              </KimaButton>
            </div>
          </div>
        </KimaCard>
      </div>
    </section>
    <ProductSelection
      v-model:open="selecting"
      :product="selected"
      :action="selectionAction"
      :periods="catalogue?.periods || []"
    />
  </div>
</template>
