<!-- 公共页面外壳：KIMA导航与手机抽屉，首页和业务页面共用品牌。调用：公开页面默认布局。 -->
<script setup lang="ts">
import { ArrowUpRight01Icon, Menu01Icon, ShoppingCart01Icon } from '@hugeicons/core-free-icons'; // 导航图标使用同一套Hugeicons
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
const menu = ref(false); // 手机菜单由KIMA抽屉管理焦点与拖拽
const route = useRoute(); // AJAX导航成功后关闭旧菜单，不能继续遮住新页面
watch(() => route.fullPath, () => { menu.value = false; }); // 浏览器前进后退和程序导航也会收起菜单
</script>
<template>
  <div class="public-shell">
    <a href="#main-content" class="skip-link">跳到正文</a>
    <header class="public-header page-width">
      <Brand />
      <nav aria-label="主导航">
        <AppLink to="/products" :underline="false" class="nav-link">云产品</AppLink>
        <AppLink to="/help" :underline="false" class="nav-link">使用帮助</AppLink>
        <AppLink to="/news" :underline="false" class="nav-link">最新动态</AppLink>
      </nav>
      <div class="public-actions">
        <KimaIconButton
          class="public-desktop-cart"
          :icon="ShoppingCart01Icon"
          label="购物车"
          @click="router.push('/console/cart')"
        />
        <ThemeSwitch />
        <KimaButton variant="tonal" @click="router.push('/console')">
          控制台
          <template #trailing><KimaIcon :icon="ArrowUpRight01Icon" :size="20" /></template>
        </KimaButton>
        <KimaIconButton
          class="public-mobile-menu"
          :icon="Menu01Icon"
          label="打开导航"
          @click="menu = true"
        />
      </div>
    </header>
    <main id="main-content"><slot /></main>
    <footer class="public-footer page-width">
      <Brand />
      <p>把精力留给创造。</p>
      <div>
        <AppLink to="/products" :underline="false">浏览产品</AppLink>
        <AppLink to="/help" :underline="false">使用帮助</AppLink>
        <AppLink to="/console/tickets" :underline="false">联系支持</AppLink>
        <span>© {{ new Date().getFullYear() }} 狐岚云</span>
      </div>
    </footer>
    <KimaDrawer
      v-model:open="menu"
      title="去往你的云"
      placement="bottom"
      :snap-points="[0.5, 0.85]"
    >
      <nav class="drawer-navigation" aria-label="手机主导航">
        <AppLink @navigate="menu = false" to="/console/cart" :underline="false">购物车</AppLink>
        <AppLink @navigate="menu = false" to="/products" :underline="false">云产品</AppLink>
        <AppLink @navigate="menu = false" to="/help" :underline="false">使用帮助</AppLink>
        <AppLink @navigate="menu = false" to="/news" :underline="false">最新动态</AppLink>
        <AppLink @navigate="menu = false" to="/console" :underline="false">我的工作台</AppLink>
      </nav>
    </KimaDrawer>
  </div>
</template>
