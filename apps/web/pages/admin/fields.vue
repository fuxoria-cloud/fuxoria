<!-- 自定义资料配置：显示范围和客户编辑权由服务端核对，停用字段保留历史。调用：/admin/fields。 -->
<script setup lang="ts">
import { KimaCheckbox } from '@kernel4632/kima';
import type { CustomField, FieldData, FieldValues } from '~/features/fields';
import { editableFields } from '~/features/fields';
import type { Department } from '~/features/support';
import type { User } from '~/types/api';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '自定义资料', robots: 'noindex, nofollow' });
const api = useApi(), open = ref(false), editing = ref(''), busy = ref(false), failure = ref(''), success = ref(''), customerId = ref(''), clientData = ref<FieldData | null>(null), values = ref<FieldValues>({});
const { data, pending, error, refresh } = await useAsyncData('admin-fields', () => api<CustomField[]>('/admin/fields'));
const { data: departments } = await useAsyncData('field-departments', () => api<Department[]>('/support/departments'));
const { data: customers } = await useAsyncData('field-customers', () => api<User[]>('/admin/users'));
const form = reactive({ scope: 'profile', key: '', name: '', description: '', kind: 'text', format: 'plain', options: '', required: false, access: 'customer', customerEditable: true, minimum: '0', maximum: '2000', departmentId: '', position: '0', active: true });
const kinds = [{ value: 'text', label: '单行文字' }, { value: 'textarea', label: '多行文字' }, { value: 'select', label: '下拉选择' }, { value: 'number', label: '数值' }, { value: 'boolean', label: '确认勾选' }, { value: 'date', label: '日期' }];
const formats = [{ value: 'plain', label: '普通文字' }, { value: 'email', label: '邮箱地址' }, { value: 'url', label: '网站地址（HTTP/HTTPS）' }, { value: 'phone', label: '国际手机号' }, { value: 'ipv4', label: 'IPv4地址' }, { value: 'domain', label: '域名' }];
const departmentItems = computed(() => [{ value: '', label: '所有部门' }, ...(departments.value ?? []).map(item => ({ value: item.id, label: item.name }))]);
const customerItems = computed(() => [{ value: '', label: '选择客户' }, ...(customers.value ?? []).filter(item => item.role === 'customer').map(item => ({ value: item.id, label: item.name + ' · ' + (item.email || item.phone || item.id.slice(0, 8)) }))]);
watch(() => form.kind, kind => {
    if (!['text', 'textarea'].includes(kind))
        form.format = 'plain';
});
function edit(item?: CustomField) { editing.value = item?.id ?? ''; Object.assign(form, { scope: item?.scope ?? 'profile', key: item?.key ?? '', name: item?.name ?? '', description: item?.description ?? '', kind: item?.kind ?? 'text', format: item?.format ?? 'plain', options: item?.options.map(option => option.value + '|' + option.label).join('\n') ?? '', required: item?.required ?? false, access: item?.access ?? 'customer', customerEditable: item?.customerEditable ?? true, minimum: String(item?.minimum ?? 0), maximum: String(item?.maximum ?? 2000), departmentId: item?.departmentId ?? '', position: String(item?.position ?? 0), active: item?.active ?? true }); failure.value = ''; success.value = ''; open.value = true; }
async function save() {
    busy.value = true;
    failure.value = '';
    try {
        const options = form.kind === 'select' ? form.options.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const index = line.indexOf('|'); return index < 0 ? { value: line, label: line } : { value: line.slice(0, index).trim(), label: line.slice(index + 1).trim() }; }) : [];
        await api('/admin/fields' + (editing.value ? '/' + editing.value : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...form, options, minimum: Number(form.minimum), maximum: Number(form.maximum), position: Number(form.position), departmentId: form.scope === 'ticket' && form.departmentId ? form.departmentId : null, customerEditable: form.access === 'customer' && form.customerEditable } });
        open.value = false;
        success.value = '字段定义已保存，已有工单保留原始填写说明。';
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
watch(customerId, async (id) => {
    clientData.value = null;
    values.value = {};
    if (!id)
        return;
    busy.value = true;
    failure.value = '';
    try {
        clientData.value = await api<FieldData>(`/admin/clients/${id}/fields`);
        values.value = { ...clientData.value.values };
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
});
async function saveCustomer() {
    if (!clientData.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        await api(`/admin/clients/${customerId.value}/fields`, { method: 'PUT', body: { values: editableFields({ ...clientData.value, values: values.value }), revision: clientData.value.revision } });
        clientData.value = await api<FieldData>(`/admin/clients/${customerId.value}/fields`);
        values.value = { ...clientData.value.values };
        success.value = '客户补充资料已保存。';
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
    <header class="page-heading">
      <div>
        <h1>自定义资料</h1>
        <p>按实际服务需要收集信息，也为内部字段设好查看与填写范围。</p>
      </div>
      <KimaButton @click="edit()">新增字段</KimaButton>
    </header>
    <KimaAlert v-if="failure && !open" variant="danger" class="mb-5">{{ failure }}</KimaAlert>
    <KimaAlert v-if="success" class="mb-5">{{ success }}</KimaAlert>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="data?.length===0"
      title="还没有自定义字段"
      description="可以为客户资料或工单添加需要填写的信息。"
      @retry="refresh"
    />
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article v-for="field in data" :key="field.id" class="panel p-6">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="font-semibold text-lg">{{ field.name }}</h2>
          <KimaChip>{{ field.active?'已启用':'已停用' }}</KimaChip>
        </div>
        <p class="muted text-sm mt-3">
          {{ field.scope==='profile'?'客户资料':'工单资料' }}
          ·
          {{ field.access==='admin'?'管理员可见':field.access==='staff'?'支持团队可见':'客户可见' }}
          {{ field.required?' · 必填':'' }}
        </p>
        <p class="mt-3 whitespace-pre-wrap break-words">{{ field.description }}</p>
        <p class="muted mt-3 text-sm">字段标识：{{ field.key }}</p>
        <KimaButton variant="tonal" class="mt-5" @click="edit(field)">编辑定义</KimaButton>
      </article>
    </div>
    <section class="panel p-5 sm:p-7 mt-8 grid grid-cols-1 gap-5">
      <h2 class="text-xl font-semibold">维护客户补充资料</h2>
      <label class="field-label min-w-0">
        <span class="form-label">客户账户</span>
        <KimaSelect v-model="customerId" label="客户账户" :items="customerItems" :disabled="busy" />
      </label>
      <form v-if="clientData?.definitions.length" class="grid grid-cols-1 gap-5" @submit.prevent="saveCustomer">
        <CustomFields v-model="values" :definitions="clientData.definitions" :disabled="busy" />
        <div>
          <KimaButton type="submit" :loading="busy">保存客户资料</KimaButton>
        </div>
      </form>
      <p v-else-if="clientData" class="muted">还没有启用客户资料字段。</p>
    </section>
    <KimaDrawer v-model:open="open" title="字段定义" placement="right" :close-on-backdrop="!busy" :close-on-escape="!busy">
      <form id="field-definition" class="drawer-form" @submit.prevent="save">
        <label class="field-label min-w-0">
          <span class="form-label">填写位置</span>
          <KimaSelect
            v-model="form.scope"
            label="填写位置"
            :items="[{value:'profile',label:'客户资料'},{value:'ticket',label:'工单'}]"
            :disabled="busy || !!editing"
          />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">字段标识</span>
          <KimaTextField
            v-model="form.key"
            label="字段标识"
            placeholder="例如 affected_domain"
            hint="使用小写字母、数字和下划线，以字母开头，创建后固定。"
            maxlength="40"
            required
            :disabled="busy || !!editing"
          />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">显示名称</span>
          <KimaTextField v-model="form.name" label="显示名称" maxlength="100" required :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">填写说明</span>
          <KimaTextarea v-model="form.description" label="填写说明" :maxlength="1000" :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">输入方式</span>
          <KimaSelect v-model="form.kind" label="输入方式" :items="kinds" :disabled="busy" />
        </label>
        <label class="field-label min-w-0" v-if="['text','textarea'].includes(form.kind)">
          <span class="form-label">格式要求</span>
          <KimaSelect v-model="form.format" label="格式要求" :items="formats" :disabled="busy" />
        </label>
        <label class="field-label min-w-0" v-if="form.kind==='select'">
          <span class="form-label">可选项目</span>
          <KimaTextarea
            v-model="form.options"
            label="可选项目"
            hint="每行一个选项，或使用 标识|显示名称。"
            :maxlength="20000"
            required
            :disabled="busy"
          />
        </label>
        <div v-if="['text','textarea','number'].includes(form.kind)" class="grid grid-cols-2 gap-4">
          <label class="field-label min-w-0">
            <span class="form-label">最小长度或数值</span>
            <KimaTextField v-model="form.minimum" type="number" label="最小长度或数值" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">最大长度或数值</span>
            <KimaTextField v-model="form.maximum" type="number" label="最大长度或数值" :disabled="busy" />
          </label>
        </div>
        <label class="field-label min-w-0">
          <span class="form-label">谁可以查看</span>
          <KimaSelect
            v-model="form.access"
            label="谁可以查看"
            :items="[{value:'customer',label:'客户与支持团队'},{value:'staff',label:'仅支持团队和管理员'},{value:'admin',label:'仅管理员'}]"
            :disabled="busy"
          />
        </label>
        <KimaCheckbox
          v-if="form.access==='customer'"
          v-model="form.customerEditable"
          label="允许客户填写和修改"
          :disabled="busy"
        />
        <KimaCheckbox v-model="form.required" label="要求填写" :disabled="busy" />
        <label class="field-label min-w-0" v-if="form.scope==='ticket'">
          <span class="form-label">适用工单部门</span>
          <KimaSelect v-model="form.departmentId" label="适用工单部门" :items="departmentItems" :disabled="busy" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">显示顺序</span>
          <KimaTextField v-model="form.position" type="number" label="显示顺序" min="0" max="10000" :disabled="busy" />
        </label>
        <KimaCheckbox v-model="form.active" label="启用此字段" :disabled="busy" />
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="open=false">取消</KimaButton>
        <KimaButton type="submit" form="field-definition" :loading="busy">保存字段</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
