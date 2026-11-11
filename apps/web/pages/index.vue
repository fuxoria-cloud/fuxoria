<!-- 狐岚云首页：KIMA真实组件与原创云狐承接公开购买入口。调用：访问 /；价格来自公开API。 -->
<script setup lang="ts">
import { KimaButton, KimaCard, KimaIcon, KimaSkeleton } from "@kernel4632/kima"; // 原生KIMA交互与表面
import {
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  CloudServerIcon,
  Invoice01Icon,
  CustomerService01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"; // 和组件库共用图标
import "~/assets/css/home.css"; // 首页仅维护自身版式
import type { Product } from "~/types/api"; // 商品契约只有一个来源
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
useSeoMeta({
  title: "让灵感，有云可栖",
  description:
    "在狐岚云挑选云产品，管理开通与续费，核对账单并联系支持。电脑和手机，都有顺手的云上工作台。",
  ogTitle: "狐岚云 · 让灵感，有云可栖",
  ogDescription: "选好你的云，其余慢慢创造。",
  ogType: "website",
}); // 不宣称未经验证的性能或在线数据
const siteUrl = useRuntimeConfig().public.siteUrl; // 域名由部署者提供
if (siteUrl) useHead({ link: [{ rel: "canonical", href: `${siteUrl}/` }] }); // 不生成占位域名
const api = useApi(); // 与产品目录共用真实API
const {
  data: products,
  pending,
  error,
  refresh,
} = await useAsyncData("home-products", () => api<Product[]>("/products"), {
  server: false,
}); // 静态页不携带过时库存
const choices = computed(() => products.value?.slice(0, 3) ?? []); // 首页展示少量方案，完整比较进入产品页
const routes = [
  {
    name: "我的服务",
    description: "查看开通进度、到期日期与续费",
    to: "/console/services",
    icon: CloudServerIcon,
  },
  {
    name: "账单与付款",
    description: "每次付款前，再核对一次",
    to: "/console/invoices",
    icon: Invoice01Icon,
  },
  {
    name: "联系支持",
    description: "把问题留在工单里，继续跟进",
    to: "/console/tickets",
    icon: CustomerService01Icon,
  },
]; // 固定入口直接写明业务用途
</script>
<template>
  <div class="home-page page-width">
    <section class="home-hero" aria-labelledby="home-title">
      <div class="home-intro">
        <p class="home-kicker">
          <KimaIcon :icon="SparklesIcon" :size="20" aria-hidden="true" />
          狐岚云 · 你的云上新日常
        </p>
        <h1 id="home-title">
          让灵感，
          <br />
          <span>有云可栖。</span>
        </h1>
        <p class="home-lead">
          小小的个人站点，或正在长大的应用。
          <br class="home-desktop-break" />
          从这里选好你的云，把时间留给喜欢的事。
        </p>
        <div class="home-actions">
          <KimaButton @click="router.push('/products')">
            挑选云产品
            <template #trailing
              ><KimaIcon :icon="ArrowRight01Icon" :size="22"
            /></template>
          </KimaButton>
          <KimaButton variant="tonal" @click="router.push('/console')">
            打开工作台
            <template #trailing
              ><KimaIcon :icon="ArrowUpRight01Icon" :size="20"
            /></template>
          </KimaButton>
        </div>
        <p class="home-note">开通、续费、账单和支持，都在同一个地方。</p>
      </div>
      <div class="home-art">
        <div class="home-art-surface" aria-hidden="true" />
        <span class="home-orbit-mark home-orbit-top" aria-hidden="true">✦</span>
        <img
          class="home-mascot"
          src="/brand/fuxoria-mascot.png"
          width="640"
          height="800"
          alt="狐岚云云狐：穿着蓝色飞行夹克，抱着平板向你招手的白狐领航员"
          fetchpriority="high"
          decoding="async"
        />
        <span class="home-orbit-mark home-orbit-bottom" aria-hidden="true"
          >✧</span
        >
        <div class="home-art-caption">
          <span>云上有个小伙伴。</span>
          <small>陪你照顾每一份创造</small>
        </div>
      </div>
    </section>
    <section class="home-shortcuts" aria-label="常用工作台入口">
      <KimaCard
        v-for="item in routes"
        :key="item.to"
        class="home-shortcut"
        clickable
        :aria-label="item.name"
        @click="router.push(item.to)"
      >
        <div class="home-shortcut-content">
          <span class="home-shortcut-icon">
            <KimaIcon :icon="item.icon" :size="28" aria-hidden="true" />
          </span>
          <div>
            <h2>{{ item.name }}</h2>
            <p>{{ item.description }}</p>
          </div>
          <KimaIcon
            class="home-shortcut-arrow"
            :icon="ArrowUpRight01Icon"
            :size="22"
            aria-hidden="true"
          />
        </div>
      </KimaCard>
    </section>
    <section
      id="cloud-plans"
      class="home-plans"
      aria-labelledby="home-plans-title"
    >
      <header class="home-section-heading">
        <div>
          <p class="home-kicker">从一个合适的起点开始</p>
          <h2 id="home-plans-title">挑一朵，属于你的云。</h2>
        </div>
        <KimaButton variant="text" @click="router.push('/products')">
          查看全部方案
          <template #trailing
            ><KimaIcon :icon="ArrowRight01Icon" :size="22"
          /></template>
        </KimaButton>
      </header>
      <KimaSkeleton v-if="pending" :rows="3" label="正在读取当前产品" />
      <div v-else-if="error" class="home-catalog-message" role="alert">
        <p>暂时没能读取产品，请稍后再试。</p>
        <KimaButton variant="tonal" @click="refresh()">重新读取</KimaButton>
      </div>
      <div v-else-if="choices.length" class="home-product-grid">
        <KimaCard
          v-for="(product, index) in choices"
          :key="product.id"
          class="home-product"
        >
          <div class="home-product-top">
            <KimaIcon :icon="CloudServerIcon" :size="32" aria-hidden="true" />
            <span>0{{ index + 1 }}</span>
          </div>
          <h3>{{ product.name }}</h3>
          <p>{{ product.description }}</p>
          <div class="home-product-bottom">
            <div class="home-product-price">
              <strong>{{
                money(
                  product.priceCents,
                  product.currency,
                  product.currencyDecimals,
                )
              }}</strong>
              <span>/ 月</span>
            </div>
            <KimaButton
              variant="tonal"
              :disabled="product.stock === 0"
              @click="router.push('/products')"
            >
              {{ product.stock === 0 ? "暂时售罄" : "查看这款" }}
              <template #trailing
                ><KimaIcon :icon="ArrowUpRight01Icon" :size="20"
              /></template>
            </KimaButton>
          </div>
        </KimaCard>
      </div>
      <div v-else class="home-catalog-message">
        <p>产品上架后，会出现在这里。</p>
        <KimaButton variant="tonal" @click="router.push('/console/tickets')"
          >联系服务商</KimaButton
        >
      </div>
    </section>
  </div>
</template>
