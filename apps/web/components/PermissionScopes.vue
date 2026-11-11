<!-- 按业务选择真实接口范围。调用：<PermissionScopes v-model="selected" :items="catalog" />。新增主体随后端元数据自动出现。 -->
<script setup lang="ts">
const selected = defineModel<string[]>({ required: true });
const props = withDefaults(
  defineProps<{
    items: { key: string; subject: string }[];
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const names: Record<string, string> = {
  account: '账户',
  service: '服务',
  order: '订单',
  invoice: '账单',
  wallet: '钱包',
  cart: '购物车',
  ticket: '工单',
  support: '支持',
  download: '下载',
  notification: '消息',
  profile: '资料',
  contact: '联系人',
  client: '客户',
  role: '管理权限',
  'api-key': '开发者密钥',
  content: '内容',
  contract: '合同',
  'service-lifecycle': '服务生命周期',
  catalogue: '商品目录',
};
const groups = computed(() =>
  [...new Set(props.items.map((item) => item.subject))].map((subject) => ({
    subject,
    label: names[subject] ?? subject,
    items: props.items.filter((item) => item.subject === subject),
  })),
);
function change(key: string, enabled: boolean) {
  selected.value = enabled
    ? [...new Set([...selected.value, key])]
    : selected.value.filter((item) => item !== key);
}
</script>
<template>
  <div class="scope-list">
    <p class="muted">
      已选择 {{ selected.length }} 项。展开业务后，仅勾选需要使用的操作。
    </p>
    <details v-for="group in groups" :key="group.subject">
      <summary>
        {{ group.label }}
        <span class="muted"
          >{{
            group.items.filter((item) => selected.includes(item.key)).length
          }}
          / {{ group.items.length }}</span
        >
      </summary>
      <label
        v-for="item in group.items"
        :key="item.key"
        class="identity-check scope-option"
      >
        <input
          type="checkbox"
          :checked="selected.includes(item.key)"
          :disabled="disabled"
          @change="
            change(item.key, ($event.target as HTMLInputElement).checked)
          "
        />
        <code>{{ item.key }}</code>
      </label>
    </details>
  </div>
</template>
