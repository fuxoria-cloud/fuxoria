<!-- 账户补充资料：只展示和修改当前权限允许的字段。调用：/console/profile-fields。 -->
<script setup lang="ts">
import type { FieldData, FieldValues } from '~/features/fields';
import { editableFields } from '~/features/fields';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '补充资料', robots: 'noindex, nofollow' });
const api = useApi(), values = ref<FieldValues>({}), busy = ref(false), failure = ref(''), success = ref('');
const { data, pending, error, refresh } = await useAsyncData('profile-fields', () => api<FieldData>('/fields/profile'));
watch(data, result => {
    if (result)
        values.value = { ...result.values };
}, { immediate: true });
async function save() {
    if (!data.value)
        return;
    busy.value = true;
    failure.value = '';
    success.value = '';
    try {
        await api('/fields/profile', { method: 'PUT', body: { values: editableFields({ ...data.value, values: values.value }), revision: data.value.revision } });
        await refresh();
        success.value = '补充资料已保存。';
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
</script>
<template>
  <div>
    <AppLink to="/console/settings" :underline="false" class="auth-back mb-6">返回账户与安全</AppLink>
    <header class="page-heading">
      <div>
        <h1>补充资料</h1>
        <p>按服务需要补充信息，带星号的项目需要填写。</p>
      </div>
      <AppLink to="/console/message-preferences" :underline="false" class="inline-flex min-h-11 items-center">消息接收偏好</AppLink>
    </header>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="data?.definitions.length===0"
      title="暂时没有需要补充的资料"
      description="有新的资料需要填写时，会在这里显示。"
      @retry="refresh"
    />
    <form
      v-if="data?.definitions.length && !error"
      class="panel p-5 sm:p-7 grid grid-cols-1 gap-6"
      @submit.prevent="save"
    >
      <CustomFields v-model="values" :definitions="data.definitions" :disabled="busy" />
      <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      <KimaAlert v-if="success">{{ success }}</KimaAlert>
      <div>
        <KimaButton type="submit" :loading="busy">保存补充资料</KimaButton>
      </div>
    </form>
  </div>
</template>
