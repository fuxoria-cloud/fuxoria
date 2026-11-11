<!-- 站内导航：Nuxt负责无整页重载的路由，KIMA负责真实链接、焦点和涟漪。调用：<AppLink to="/console">工作台</AppLink>。 -->
<script setup lang="ts">
defineOptions({ inheritAttrs: false }); // 样式与可访问属性直接交给KIMA的真实a元素
const props = withDefaults(
  defineProps<{
    to: string;
    replace?: boolean;
    target?: string;
    rel?: string;
    disabled?: boolean;
    current?: boolean | string;
    underline?: boolean;
  }>(),
  { replace: false, target: '', rel: '', disabled: false, current: false, underline: true },
); // href仍由路由生成，刷新、复制地址和无JavaScript访问都可用
const attrs = useAttrs(); // 保留class、aria-label、download等原生属性
const emit = defineEmits<{ navigate: [event: MouseEvent] }>(); // 手机菜单也能响应选择当前页面，不依赖地址一定变化
const router = useRouter(); // 界面点击直接发起导航，不能被前次尚未完成的中间件吞成返回值

/** @param event KIMA传回的真实点击；只接管普通站内导航。 */
function follow(event: MouseEvent) {
  if (
    event.defaultPrevented || props.disabled || event.button !== 0 ||
    event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
    (props.target && props.target !== '_self') || attrs.download !== undefined ||
    !props.to.startsWith('/') || props.to.startsWith('//')
  ) return; // 新窗口、下载与修饰键仍由浏览器按真实href处理
  event.preventDefault(); // 保留真实href，但这次普通站内点击只由路由器更新当前文档
  const result = props.replace ? router.replace(props.to) : router.push(props.to);
  emit('navigate', event); // 下载、修饰键和新窗口不会触发当前页面的菜单收起
  return result;
}
</script>
<template>
  <NuxtLink :to="to" :replace="replace" :target="target || undefined" custom v-slot="{ href }">
    <KimaLink
      v-bind="attrs"
      :href="href"
      :target="target"
      :rel="rel"
      :disabled="disabled"
      :current="current"
      :underline="underline"
      @navigate="follow"
    ><slot /></KimaLink>
  </NuxtLink>
</template>
