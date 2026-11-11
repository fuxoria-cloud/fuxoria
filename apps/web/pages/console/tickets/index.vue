<!-- 支持工单：发起问题并查看后续回复。调用：访问 /console/tickets?new=1 可直接打开填写区。 -->
<script setup lang="ts">
import { Add01Icon, ArrowRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'; // 创建入口放在手机也容易触达的位置
import type { CustomField, FieldValues } from '~/features/fields';
import type { Service } from '~/types/api';
import type { SupportTicket as Ticket, Department } from '~/features/support'; // 工单状态来自服务端
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: 'console', middleware: 'account' }); // 工单只属于当前账户
useSeoMeta({ title: '支持工单', robots: 'noindex, nofollow' }); // 沟通内容不公开索引
const api = useApi();
const route = useRoute(); // 路由参数可直接发起新工单
const { data, pending, error, refresh } = await useAsyncData('tickets', () => api<Ticket[]>('/tickets')); // 失败时让用户重试原请求
const creating = ref(route.query.new === '1'); // 使用页内表单，避免遮挡手机键盘
watch(() => route.query.new, (value) => {
    if (value === '1')
        creating.value = true;
}); // 同页空状态入口也能展开表单
const departments = ref<Department[]>([]), services = ref<Service[]>([]), departmentId = ref(''), serviceId = ref(''); // 选项来自实际部门和本人服务
watch(creating, async (open) => {
    if (!open)
        return;
    try {
        [departments.value, services.value] = await Promise.all([api<Department[]>('/support/departments'), api<Service[]>('/services')]);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
}, { immediate: true }); // 打开时再读取，列表访问无需额外资源
const fieldDefinitions = ref<CustomField[]>([]), customFields = ref<FieldValues>({});
let fieldReading = 0;
watch([creating, departmentId], async ([open, id]) => { const sequence = ++fieldReading; if (!open)
    return; try {
    const result = await api<{
        definitions: CustomField[];
    }>('/fields/ticket' + (id ? '?departmentId=' + id : ''));
    if (sequence !== fieldReading)
        return;
    fieldDefinitions.value = result.definitions;
    customFields.value = Object.fromEntries(Object.entries(customFields.value).filter(([key]) => result.definitions.some(field => field.key === key)));
}
catch (reason) {
    if (sequence === fieldReading)
        failure.value = apiMessage(reason);
} }, { immediate: true });
const departmentItems = computed(() => [{ value: '', label: '请支持团队协助安排' }, ...departments.value.map(item => ({ value: item.id, label: item.name }))]);
const serviceItems = computed(() => [{ value: '', label: '没有关联服务' }, ...services.value.map(item => ({ value: item.id, label: (item.productName || item.name || '服务') + ' · ' + item.id.slice(0, 8) }))]);
const subject = ref('');
const message = ref('');
const priority = ref('normal'); // 只收集说明问题必要的信息
const busy = ref(false);
const failure = ref(''); // 提交错误不清空已写内容
/** 创建工单并进入该次沟通的详情页。 */
async function submit() {
    // 表单入口发送用户填写的内容
    busy.value = true;
    failure.value = ''; // 发送时避免重复提交
    try {
        // 一次提交的错误在本表单处理
        const ticket = await api<Ticket>('/tickets', {
            method: 'POST',
            body: {
                subject: subject.value.trim(),
                message: message.value.trim(),
                priority: priority.value,
                customFields: customFields.value,
                ...(departmentId.value ? { departmentId: departmentId.value } : {}),
                ...(serviceId.value ? { serviceId: serviceId.value } : {}),
            },
        }); // 不上传密码与支付密钥
        await router.push(`/console/tickets/${ticket.id}`); // 新工单与回复在同一页继续
    }
    catch (error) {
        failure.value = apiMessage(error);
    }
    finally {
        // 用户能继续修改而不用重新输入
        busy.value = false;
    } // 请求完成后恢复按钮
}
const columns = [
    { key: 'subject', label: '问题' },
    { key: 'status', label: '状态' },
    { key: 'createdAt', label: '创建时间' },
    { key: 'action', label: '操作' },
]; // 工单列表按沟通顺序呈现
const priorities = [
    { value: 'low', label: '不着急 · 咨询与建议' },
    { value: 'normal', label: '普通 · 需要帮助' },
    { value: 'high', label: '紧急 · 服务受到影响' },
]; // 单一字段由KIMA选择组件承接
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>遇到问题，一起看看。</h1>
        <p>描述你遇到的情况，我们把后续进展留在同一处。</p>
      </div>
      <KimaButton :disabled="busy" @click="creating = true">
        <template #leading>
          <KimaIcon :icon="Add01Icon" />
        </template>
        新建工单
      </KimaButton>
    </header>
    <KimaAlert v-if="busy && !creating" class="mb-6">工单正在提交，请等待本次结果。</KimaAlert>
    <KimaAlert v-if="failure && !creating" variant="danger" class="mb-6">{{ failure }}</KimaAlert>
    <section class="panel">
      <header class="panel-header">
        <h2>
          我的工单
          <span v-if="data" class="muted ml-3 text-sm">{{ data.length }} 条</span>
        </h2>
        <KimaButton variant="text" :disabled="pending" @click="refresh()">刷新</KimaButton>
      </header>
      <RequestState
        :pending="pending && !data"
        :error="error"
        :empty="data?.length === 0"
        title="还没有工单"
        description="遇到疑问时，在这里发起一次沟通。"
        action="新建工单"
        to="/console/tickets?new=1"
        @retry="refresh"
      />
      <div v-if="data?.length && !error" class="grid grid-cols-1 gap-4 p-4 sm:hidden">
        <article v-for="item in data" :key="item.id" class="rounded-2xl bg-[var(--kima-color-layer-2)] p-5">
          <AppLink :to="`/console/tickets/${item.id}`" :underline="false" class="font-semibold text-lg break-words">{{ item.subject }}</AppLink>
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <StatusBadge :status="item.status" />
            <span class="muted text-sm">{{ date(item.createdAt) }}</span>
          </div>
          <p v-if="item.departmentName" class="muted mt-3">{{ item.departmentName }} · {{ item.assigneeName || '等待跟进' }}</p>
          <KimaButton variant="tonal" class="mt-4 w-full" @click="router.push(`/console/tickets/${item.id}`)">查看工单</KimaButton>
        </article>
      </div>
      <KimaTable
        class="hidden sm:block"
        v-if="data?.length && !error"
        :columns="columns"
        :rows="data"
        row-key="id"
        hoverable
      >
        <template #cell-subject="{ row }">
          <span class="table-primary">{{ row.subject }}</span>
          <span class="table-secondary">{{ row.id.slice(0, 8) }}</span>
        </template>
        <template #cell-status="{ value }">
          <StatusBadge :status="value" />
        </template>
        <template #cell-createdAt="{ value }">
          <span class="numbers whitespace-nowrap">{{ date(value) }}</span>
        </template>
        <template #cell-action="{ row }">
          <KimaButton variant="tonal" @click="router.push(`/console/tickets/${row.id}`)">
            查看
            <template #trailing>
              <KimaIcon :icon="ArrowRight01Icon" :size="20" />
            </template>
          </KimaButton>
        </template>
      </KimaTable>
    </section>
    <KimaDrawer
      v-model:open="creating"
      title="把问题说给我们听"
      placement="right"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form id="new-ticket-form" class="drawer-form" @submit.prevent="submit">
        <label class="field-label">
          <span class="form-label">问题标题</span>
          <KimaTextField
            v-model="subject"
            label="问题标题"
            placeholder="例如：刚购买的服务还没有开通"
            minlength="2"
            maxlength="160"
            required
            :disabled="busy"
          />
        </label>
        <label class="field-label">
          <span class="form-label">具体情况</span>
          <KimaTextarea
            v-model="message"
            label="具体情况"
            placeholder="发生了什么、什么时候开始、你已经试过什么？"
            :minlength="2"
            :maxlength="10000"
            hint="请勿填写密码、支付密钥或完整银行卡号。"
            required
            :disabled="busy"
          />
        </label>
        <div class="field-label">
          <span class="form-label">紧急程度</span>
          <KimaSelect v-model="priority" label="紧急程度" :items="priorities" :disabled="busy" />
        </div>
        <div class="field-label">
          <span class="form-label">希望由哪个团队处理</span>
          <KimaSelect v-model="departmentId" label="支持部门" :items="departmentItems" :disabled="busy" />
        </div>
        <div v-if="services.length" class="field-label">
          <span class="form-label">关联服务</span>
          <KimaSelect v-model="serviceId" label="关联服务" :items="serviceItems" :disabled="busy" />
        </div>
        <CustomFields v-model="customFields" :definitions="fieldDefinitions" :disabled="busy" />
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="creating = false">稍后再写</KimaButton>
        <KimaButton type="submit" form="new-ticket-form" :loading="busy">提交工单</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
