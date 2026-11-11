<!-- 狐岚云工作台：KIMA链接、抽屉、胶囊动作与主题切换，常用模块始终可达。调用：layout:'console'。 -->
<script setup lang="ts">
import {
  DashboardSquare01Icon,
  ServerStack01Icon,
  Invoice01Icon,
  MessageMultiple01Icon,
  ArrowUpRight01Icon,
  Logout01Icon,
  Shield01Icon,
  ArrowRight01Icon,
  Menu01Icon,
  HelpCircleIcon,
  UserSettings01Icon,
  Wallet01Icon,
  ShoppingCart01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"; // 图标语义与导航文字配对
const route = useRoute();
const account = useAccount(); // 路由决定选中项，身份仍由API确认
const menu = ref(false);
watch(
  () => route.fullPath,
  () => {
    menu.value = false;
  },
); // 无整页重载切换后收起手机导航
const logoutError = ref(""); // 手机更多导航由真实抽屉承接
const links = [
  { to: "/console", label: "总览", icon: DashboardSquare01Icon },
  { to: "/console/services", label: "我的服务", icon: ServerStack01Icon },
  { to: "/console/invoices", label: "账单", icon: Invoice01Icon },
  { to: "/console/tickets", label: "支持工单", icon: MessageMultiple01Icon },
]; // 固定常用模块保持可预测
const tools = computed(() => [
  ...(["admin", "support"].includes(account.user.value?.role || "")
    ? [{ to: "/console/sales", label: "我的销售绩效", icon: UserGroupIcon }]
    : []),
  { to: "/console/transfers", label: "服务转移", icon: ServerStack01Icon },
  { to: "/console/combined", label: "合并付款", icon: Invoice01Icon },
  { to: "/console/affiliates", label: "推荐与佣金", icon: UserGroupIcon },
  { to: "/console/contracts", label: "服务合同", icon: Invoice01Icon },
  { to: "/console/credit", label: "信用额度", icon: Wallet01Icon },
  { to: "/console/vouchers", label: "发票申请", icon: Invoice01Icon },
  { to: "/console/downloads", label: "文件下载", icon: HelpCircleIcon },
  {
    to: "/console/message-preferences",
    label: "消息偏好",
    icon: MessageMultiple01Icon,
  },
  { to: "/console/activity", label: "操作记录", icon: Shield01Icon },
  {
    to: "/console/notifications",
    label: "站内消息",
    icon: MessageMultiple01Icon,
  },
  ...(!account.user.value?.delegated
    ? [
        { to: "/console/renewals", label: "批量续费", icon: ServerStack01Icon },
        { to: "/console/identity", label: "实名资料", icon: Shield01Icon },
        {
          to: "/console/verification",
          label: "邮箱与手机验证",
          icon: UserSettings01Icon,
        },
        {
          to: "/console/contacts",
          label: "联系人与子账号",
          icon: UserGroupIcon,
        },
        {
          to: "/console/profile-fields",
          label: "补充资料",
          icon: UserSettings01Icon,
        },
        { to: "/console/developer", label: "开发者密钥", icon: Shield01Icon },
      ]
    : []),
]); // 次常用业务集中列出，手机与桌面使用同一份入口
const more = ref(tools.value.some((item) => route.path.startsWith(item.to))); // 当前业务入口在桌面自动展开
watch(
  () => route.path,
  () => {
    if (tools.value.some((item) => route.path.startsWith(item.to)))
      more.value = true;
  },
);

const current = computed(
  () =>
    links.find((item) => item.to === route.path) ||
    links.find(
      (item) => item.to !== "/console" && route.path.startsWith(item.to),
    ) ||
    tools.value.find((item) => route.path.startsWith(item.to)),
); // 详情页沿用所在业务主体
/** 注销失败时保留当前会话，并显示服务端给出的原因。 */
async function logout() {
  try {
    await account.logout();
  } catch (error) {
    logoutError.value = apiMessage(error);
  }
} // 撤销成功后再离开页面
</script>
<template>
  <div class="workspace-shell">
    <a href="#main-content" class="skip-link">跳到正文</a>
    <aside class="sidebar">
      <Brand />
      <div class="workspace-label">我的云上空间</div>
      <nav aria-label="工作台导航">
        <AppLink
          v-for="item in links"
          :key="item.to"
          :to="item.to"
          :underline="false"
          :class="['sidebar-link', { selected: current?.to === item.to }]"
          :current="current?.to === item.to"
        >
          <KimaIcon :icon="item.icon" :size="24" />
          <span>{{ item.label }}</span>
        </AppLink>
        <AppLink
          to="/console/cart"
          :underline="false"
          :class="[
            'sidebar-link',
            { selected: route.path === '/console/cart' },
          ]"
          :current="route.path === '/console/cart'"
        >
          <KimaIcon :icon="ShoppingCart01Icon" :size="24" />
          购物车
        </AppLink>
        <AppLink
          to="/console/wallet"
          :underline="false"
          :class="[
            'sidebar-link',
            { selected: route.path === '/console/wallet' },
          ]"
          :current="route.path === '/console/wallet'"
        >
          <KimaIcon :icon="Wallet01Icon" :size="24" />
          账户余额
        </AppLink>
        <AppLink
          v-if="!account.user.value?.delegated"
          to="/console/settings"
          :underline="false"
          :class="[
            'sidebar-link',
            { selected: route.path === '/console/settings' },
          ]"
          :current="route.path === '/console/settings'"
        >
          <KimaIcon :icon="UserSettings01Icon" :size="24" />
          账户设置
        </AppLink>
        <KimaCollapsible v-model:open="more" label="更多功能">
          <AppLink
            v-for="item in tools"
            :key="item.to"
            :to="item.to"
            :underline="false"
            :class="[
              'sidebar-link',
              { selected: route.path.startsWith(item.to) },
            ]"
          >
            <KimaIcon :icon="item.icon" :size="24" />{{ item.label }}
          </AppLink>
        </KimaCollapsible>
        <AppLink
          v-if="account.user.value?.role === 'admin'"
          to="/admin"
          :underline="false"
          :class="['sidebar-link', { selected: route.path === '/admin' }]"
        >
          <KimaIcon :icon="Shield01Icon" :size="24" />
          管理后台
        </AppLink>
      </nav>
      <div class="sidebar-bottom">
        <KimaCard class="sidebar-note">
          <span class="small-label">每一份灵感，都值得安放</span>
          <p>
            去看看新的
            <br />
            云上可能。
          </p>
          <AppLink to="/products" :underline="false">
            挑选产品
            <KimaIcon :icon="ArrowUpRight01Icon" :size="20" />
          </AppLink>
        </KimaCard>
        <AppLink to="/help" :underline="false" class="sidebar-link">
          <KimaIcon :icon="HelpCircleIcon" :size="24" />
          使用帮助
        </AppLink>
        <AppLink to="/" :underline="false" class="sidebar-link">
          <KimaIcon :icon="ArrowUpRight01Icon" :size="24" />
          返回首页
        </AppLink>
      </div>
    </aside>
    <div class="workspace-main">
      <header class="workspace-header">
        <div class="mobile-brand"><Brand /></div>
        <div class="breadcrumb hidden md:flex">
          工作台
          <KimaIcon :icon="ArrowRight01Icon" :size="20" />
          <span>
            {{
              route.path === "/admin"
                ? "管理后台"
                : route.path === "/console/settings"
                  ? "账户设置"
                  : route.path === "/console/wallet"
                    ? "账户余额"
                    : route.path === "/console/cart"
                      ? "购物车"
                      : current?.label || "详情"
            }}
          </span>
        </div>
        <div class="account-tools">
          <span class="account-name">{{
            account.user.value?.name || "狐岚云账户"
          }}</span>
          <span class="avatar" aria-hidden="true">
            {{ account.user.value?.name?.slice(0, 1) || "云" }}
          </span>
          <ThemeSwitch />
          <KimaIconButton
            class="desktop-logout"
            :icon="Logout01Icon"
            label="退出登录"
            @click="logout"
          />
          <KimaIconButton
            class="mobile-menu-button"
            :icon="Menu01Icon"
            label="更多导航"
            @click="menu = true"
          />
        </div>
      </header>
      <KimaAlert v-if="logoutError" variant="danger" class="mx-6">{{
        logoutError
      }}</KimaAlert>
      <main id="main-content" class="workspace-content"><slot /></main>
      <footer class="workspace-footer">
        <span>狐岚云 · 让灵感，有云可栖。</span>
        <AppLink to="/help" :underline="false">需要帮助？</AppLink>
      </footer>
    </div>
    <nav class="mobile-navigation" aria-label="手机工作台导航">
      <AppLink
        v-for="item in links"
        :key="item.to"
        :to="item.to"
        :underline="false"
        :current="current?.to === item.to"
        :class="{ selected: current?.to === item.to }"
      >
        <KimaIcon :icon="item.icon" :size="24" />
        <span>{{ item.label }}</span>
      </AppLink>
    </nav>
    <KimaDrawer
      v-model:open="menu"
      title="我的空间"
      placement="bottom"
      :snap-points="[0.5, 0.85]"
    >
      <nav class="drawer-navigation" aria-label="更多功能">
        <AppLink @navigate="menu = false" to="/console/cart" :underline="false">
          <KimaIcon :icon="ShoppingCart01Icon" />
          购物车
        </AppLink>
        <AppLink
          @navigate="menu = false"
          to="/console/wallet"
          :underline="false"
        >
          <KimaIcon :icon="Wallet01Icon" />
          账户余额
        </AppLink>
        <AppLink
          v-if="!account.user.value?.delegated"
          @navigate="menu = false"
          to="/console/settings"
          :underline="false"
        >
          <KimaIcon :icon="UserSettings01Icon" />
          账户设置
        </AppLink>
        <AppLink
          v-for="item in tools"
          :key="item.to"
          @navigate="menu = false"
          :to="item.to"
          :underline="false"
          ><KimaIcon :icon="item.icon" />{{ item.label }}</AppLink
        >
        <AppLink
          @navigate="menu = false"
          v-if="account.user.value?.role === 'admin'"
          to="/admin"
          :underline="false"
        >
          <KimaIcon :icon="Shield01Icon" />
          管理后台
        </AppLink>
        <AppLink @navigate="menu = false" to="/products" :underline="false"
          >挑选云产品</AppLink
        >
        <AppLink @navigate="menu = false" to="/help" :underline="false"
          >使用帮助</AppLink
        >
        <AppLink @navigate="menu = false" to="/" :underline="false"
          >返回首页</AppLink
        >
        <KimaButton variant="tonal" @click="logout">
          <KimaIcon :icon="Logout01Icon" />
          退出登录
        </KimaButton>
      </nav>
    </KimaDrawer>
  </div>
</template>
