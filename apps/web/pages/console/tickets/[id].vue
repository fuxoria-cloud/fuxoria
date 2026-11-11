<!-- 工单详情：问题、回复按时间呈现。调用：访问 /console/tickets/<工单ID>。 -->
<script setup lang="ts">
import { ArrowLeft01Icon, SentIcon } from '@hugeicons/core-free-icons'; // 回复按钮保留文字说明
import type { FieldValues } from '~/features/fields';
import { editableFields } from '~/features/fields';
import type { SupportTicket as Ticket, SupportFile, ReplyTemplate } from '~/features/support'; // 外部回复只按纯文本呈现，避免注入 HTML
const router = useRouter(); // 界面导航直接交给路由器，前次中间件等待不能吞掉本次操作
definePageMeta({ layout: 'console', middleware: 'account' }); // 工单读取和回复均需登录
useSeoMeta({ title: '工单详情', robots: 'noindex, nofollow' }); // 私人沟通不索引
const api = useApi();
const route = useRoute(); // 路由指定当前沟通
const { data: ticket, pending, error, refresh, } = await useAsyncData(`ticket-${route.params.id}`, () => api<Ticket>(`/tickets/${route.params.id}`)); // 由服务端验证工单归属
const account = useAccount(), staff = computed(() => ['admin', 'support'].includes(account.user.value?.role ?? ''));
const files = ref<SupportFile[]>([]), internal = ref('false'), fileInput = ref<HTMLInputElement | null>(null), templates = ref<ReplyTemplate[]>([]), templateId = ref(''), rating = ref('5'), ratingComment = ref('');
if (staff.value)
    templates.value = await api<ReplyTemplate[]>('/admin/support/replies'); // 快捷回复由支持人员明确选择
watch(templateId, id => {
    const chosen = templates.value.find(item => item.id === id);
    if (chosen)
        message.value = chosen.message;
});
const templateItems = computed(() => [{ value: '', label: '选择一条快捷回复' }, ...templates.value.map(item => ({ value: item.id, label: item.title }))]);
const confirmOpen = ref(false); // 原生对话框承担键盘与焦点管理
const message = ref('');
const busy = ref(false);
const failure = ref(''); // 回复提交不影响已读取的历史
/** 将新回复追加到当前工单，成功后重新读取真实历史。 */
async function reply() {
    // 回复表单是用户输入边界
    busy.value = true;
    failure.value = ''; // 提交期间避免重复发送
    try {
        // 错误只在本次动作入口处理
        await api(`/tickets/${route.params.id}/replies`, {
            method: 'POST',
            body: { message: message.value.trim(), internal: internal.value === 'true', attachmentIds: files.value.map(file => file.id) },
        }); // 只发送文本，状态由后端更新
        message.value = '';
        files.value = [];
        templateId.value = '';
        await refresh(); // 成功写入后再清空表单
    }
    catch (error) {
        failure.value = apiMessage(error);
    }
    finally {
        // 失败时保留已输入的回复
        busy.value = false;
    } // 支持修正后重试
}
/** 关闭前明确确认；已保存的对话仍然可以查阅。 */
async function closeTicket() {
    // 关闭动作由用户确认后才执行
    busy.value = true;
    failure.value = ''; // 不并发发送关闭和回复
    try {
        // 错误不会误显示为已关闭
        await api(`/tickets/${route.params.id}/close`, { method: 'POST' }); // 服务端核对工单归属
        confirmOpen.value = false;
        await refresh(); // 成功后显示最新状态
    }
    catch (error) {
        failure.value = apiMessage(error);
    }
    finally {
        // 在对话框旁保留具体原因
        busy.value = false;
    } // 失败时仍可继续确认或取消
}
/** 原文件直接上传，文件名和内容由服务端复核，不插入HTML。 */
async function upload(event: Event) {
    const chosen = (event.target as HTMLInputElement).files?.[0];
    if (!chosen)
        return;
    failure.value = '';
    if (chosen.size > 5 * 1024 * 1024) {
        failure.value = '单个附件不能超过5MiB。';
        return;
    }
    if (files.value.length >= 5) {
        failure.value = '每次回复最多附带5个文件。';
        return;
    }
    busy.value = true;
    try {
        files.value.push(await api<SupportFile>(`/tickets/${route.params.id}/files?` + new URLSearchParams({ name: chosen.name, internal: internal.value }), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chosen }));
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
        if (fileInput.value)
            fileInput.value.value = '';
    }
}
async function reopen() {
    busy.value = true;
    failure.value = '';
    try {
        await api(`/tickets/${route.params.id}/reopen`, { method: 'POST' });
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function evaluate() {
    busy.value = true;
    failure.value = '';
    try {
        await api(`/tickets/${route.params.id}/evaluate`, { method: 'POST', body: { rating: Number(rating.value), comment: ratingComment.value.trim() } });
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
const base = useRuntimeConfig().public.apiBase; // 浏览器按附件响应下载，不进行页面跳转
const fieldValues = ref<FieldValues>({}), fieldDirty = ref(false);
watch(ticket, result => { if (result?.customFields && !fieldDirty.value)
    fieldValues.value = { ...result.customFields.values }; }, { immediate: true });
async function saveFields() { if (!ticket.value?.customFields)
    return; busy.value = true; failure.value = ''; try {
    await api(`/tickets/${route.params.id}/fields`, { method: 'PUT', body: { values: editableFields({ ...ticket.value.customFields, values: fieldValues.value }), revision: ticket.value.customFields.revision } });
    fieldDirty.value = false;
    await refresh();
}
catch (reason) {
    failure.value = apiMessage(reason);
}
finally {
    busy.value = false;
} }
</script>
<template>
  <div>
    <AppLink to="/console/tickets" :underline="false" class="auth-back mb-6">
      <KimaIcon :icon="ArrowLeft01Icon" :size="20" />
      返回支持工单
    </AppLink>
    <RequestState :pending="pending && !ticket" :error="error" @retry="refresh" />
    <template v-if="ticket && !error">
      <header class="page-heading">
        <div>
          <h1>{{ ticket.subject }}</h1>
          <p>{{ date(ticket.createdAt) }} 发起 · #{{ ticket.id.slice(0, 8) }}</p>
          <p v-if="ticket.departmentName || ticket.assigneeName" class="mt-2">
            {{ ticket.departmentName }}
            <span v-if="ticket.assigneeName"> · {{ ticket.assigneeName }} 正在跟进</span>
          </p>
          <AppLink v-if="ticket.serviceId" :to="`/console/services/${ticket.serviceId}`">
            关联服务：
            {{ ticket.serviceName || ticket.serviceId.slice(0,8) }}
          </AppLink>
        </div>
        <div class="flex items-center gap-4 flex-wrap">
          <StatusBadge :status="ticket.status" />
          <KimaButton v-if="ticket.status !== 'closed'" variant="tonal" @click="confirmOpen = true">
            结束工单
          </KimaButton>
        </div>
      </header>
      <KimaAlert v-if="ticket.mergedInto" class="mb-6">
        这张工单已合并，后续进展请到
        <AppLink :to="`/console/tickets/${ticket.mergedInto}`">接收工单</AppLink>
        查看。
      </KimaAlert>
      <form
        v-if="ticket.customFields?.definitions.length"
        class="panel p-5 sm:p-7 mb-6 grid grid-cols-1 gap-5"
        @submit.prevent="saveFields"
      >
        <h2 class="font-semibold text-lg">补充资料</h2>
        <CustomFields
          v-model="fieldValues"
          :definitions="ticket.customFields.definitions"
          :disabled="busy || !!ticket.mergedInto || (ticket.status==='closed' && !staff)"
          @update:model-value="fieldDirty=true"
        />
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
        <div v-if="!ticket.mergedInto && (ticket.status!=='closed' || staff)">
          <KimaButton type="submit" :loading="busy">保存补充资料</KimaButton>
        </div>
      </form>
      <section class="panel" aria-label="工单对话">
        <article v-for="reply in ticket.replies || []" :key="reply.id" class="ticket-message">
          <div class="ticket-message-meta">
            <span>
              <KimaChip v-if="reply.internal" size="sm" class="mr-2">内部备注</KimaChip>
              {{
                reply.authorName || reply.name || (reply.role === 'admin' ? '支持人员' : '我的回复')
              }}
            </span>
            <time :datetime="reply.createdAt">{{ date(reply.createdAt) }}</time>
          </div>
          <p>{{ reply.message }}</p>
          <div v-if="ticket.attachments?.some(file=>file.replyId===reply.id)" class="mt-4 flex flex-wrap gap-3">
            <a
              v-for="file in ticket.attachments.filter(file=>file.replyId===reply.id)"
              :key="file.id"
              :href="`${base}/files/${file.id}`"
              download
              class="inline-flex items-center min-h-11 break-all underline"
            >
              {{ file.name }}
              ·
              {{ Math.ceil(file.sizeBytes/1024) }}
              KB
            </a>
          </div>
        </article>
      </section>
      <section v-if="!ticket.mergedInto && (ticket.status !== 'closed' || staff)" class="panel mt-8">
        <header class="panel-header">
          <h2>继续聊聊</h2>
        </header>
        <form class="content-padding" @submit.prevent="reply">
          <div v-if="staff" class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <label class="field-label min-w-0">
              <span class="form-label">快捷回复</span>
              <KimaSelect v-model="templateId" label="快捷回复" :items="templateItems" :disabled="busy" />
            </label>
            <label class="field-label min-w-0">
              <span class="form-label">回复范围</span>
              <KimaSelect
                v-model="internal"
                label="回复范围"
                :items="[{value:'false',label:'发给客户'},{value:'true',label:'仅支持团队的内部备注'}]"
                :disabled="busy || files.length>0"
              />
            </label>
          </div>
          <label class="field-label">
            <span class="form-label">补充回复</span>
            <KimaTextarea
              v-model="message"
              label="补充回复"
              placeholder="补充一些信息，或告诉我们新的进展。"
              :minlength="1"
              :maxlength="10000"
              required
              :disabled="busy"
            />
          </label>
          <input
            ref="fileInput"
            type="file"
            class="sr-only"
            accept=".png,.jpg,.jpeg,.pdf,.zip,.txt,.log,.csv"
            aria-label="添加工单附件"
            :disabled="busy"
            @change="upload"
          />
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <KimaButton variant="tonal" :disabled="busy || files.length>=5" type="button" @click="fileInput?.click()">添加附件</KimaButton>
            <span class="form-hint">每个文件最多5MiB，可上传图片、PDF、ZIP或文本。</span>
            <span v-for="file in files" :key="file.id" class="text-sm break-all">
              {{ file.name }}
              <KimaButton variant="text" type="button" :disabled="busy" @click="files=files.filter(item=>item.id!==file.id)">移除</KimaButton>
            </span>
          </div>
          <KimaAlert v-if="failure" variant="danger" class="mt-5">{{ failure }}</KimaAlert>
          <div class="form-actions">
            <KimaButton :loading="busy" type="submit">
              <template #leading>
                <KimaIcon :icon="SentIcon" />
              </template>
              发送回复
            </KimaButton>
            <p class="form-hint">密码与密钥请留在你自己手中。</p>
          </div>
        </form>
      </section>
      <KimaAlert v-else-if="!ticket.mergedInto" class="mt-8" heading="这个问题已结束">
        这个问题已结束。遇到新情况时，可以再提交一张工单。
        <template #action>
          <KimaButton variant="tonal" :disabled="busy" @click="reopen">重新打开</KimaButton>
          <KimaButton variant="tonal" @click="router.push('/console/tickets?new=1')">
            新建工单
          </KimaButton>
        </template>
      </KimaAlert>
      <section v-if="ticket.status==='closed' && !staff && !ticket.mergedInto" class="panel mt-6 p-6">
        <h2 class="text-lg font-semibold mb-4">这次帮助怎么样？</h2>
        <p v-if="ticket.rating">你给了 {{ ticket.rating }} 分。{{ ticket.ratingComment }}</p>
        <form v-else class="grid grid-cols-1 gap-4" @submit.prevent="evaluate">
          <label class="field-label min-w-0">
            <span class="form-label">服务评分</span>
            <KimaSelect
              v-model="rating"
              label="服务评分"
              :items="[{value:'5',label:'5分 · 很满意'},{value:'4',label:'4分 · 满意'},{value:'3',label:'3分 · 一般'},{value:'2',label:'2分 · 不太满意'},{value:'1',label:'1分 · 不满意'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">想说的话（选填）</span>
            <KimaTextarea v-model="ratingComment" label="想说的话（选填）" :maxlength="2000" :disabled="busy" />
          </label>
          <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
          <KimaButton type="submit" :loading="busy">提交评价</KimaButton>
        </form>
      </section>
      <KimaDrawer
        v-model:open="confirmOpen"
        title="这个问题解决了吗？"
        description="结束后将无法继续回复，沟通记录会保留。新的问题可以另开工单。"
        role="alertdialog"
        :close-on-backdrop="false"
        :close-on-escape="!busy"
      >
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
        <template #footer>
          <KimaButton variant="tonal" autofocus :disabled="busy" @click="confirmOpen = false">
            继续沟通
          </KimaButton>
          <KimaButton :loading="busy" @click="closeTicket">确认结束</KimaButton>
        </template>
      </KimaDrawer>
    </template>
  </div>
</template>
