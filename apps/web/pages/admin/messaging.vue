<!-- 消息工作台：模板、真实发送进度、未知结果核对和关怀规则。调用：/admin/messaging?tab=templates。 -->
<script setup lang="ts">
import { KimaCheckbox } from '@kernel4632/kima';
import type { MessageTemplate, MessageBatch, MessageJob, CareRule } from '~/features/messaging';
import { messageStates, careTriggers } from '~/features/messaging';
import type { User, Product } from '~/types/api';
import type { FactorInput } from '~/features/factor';
import { factorProof } from '~/features/factor';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '消息与关怀', robots: 'noindex, nofollow' });
const api = useApi(), route = useRoute(), router = useRouter();
const tabs = [{ id: 'templates', label: '消息模板' }, { id: 'batches', label: '发送批次' }, { id: 'jobs', label: '发送任务' }, { id: 'care', label: '客户关怀' }];
const tab = computed(() => tabs.some(item => item.id === route.query.tab) ? String(route.query.tab) : 'templates'), page = ref(1), state = ref('');
const endpoint = computed(() => '/admin/messaging/' + tab.value + (tab.value === 'jobs' ? '?' + new URLSearchParams({ page: String(page.value), ...(typeof route.query.batchId === 'string' ? { batchId: route.query.batchId } : {}), ...(state.value ? { state: state.value } : {}) }) : ''));
watch(tab, () => { page.value = 1; failure.value = ''; });
const { data, pending, error, refresh } = await useAsyncData(computed(() => `messaging-admin:${endpoint.value}`), () => api<any>(endpoint.value));
const rows = computed<any[]>(() => Array.isArray(data.value) ? data.value : data.value?.items ?? []);
const templates = ref<MessageTemplate[]>([]), products = ref<Product[]>([]), capabilities = ref({ site: true, email: false, sms: false });
async function options() { [templates.value, products.value, capabilities.value] = await Promise.all([api<MessageTemplate[]>('/admin/messaging/templates'), api<Product[]>('/products'), api<typeof capabilities.value>('/admin/messaging/options')]); }
const busy = ref(false), failure = ref(''), success = ref(''), drawer = ref(''), editing = ref(''), key = ref(''), recipients = ref<string[]>([]), customerQuery = ref(''), customerPage = ref(1), customers = ref<{
    items: User[];
    total: number;
    limit: number;
} | null>(null), selectedJob = ref<MessageJob | null>(null), acknowledged = ref(false), password = ref(''), proof = ref<FactorInput>({ mode: 'totp', code: '' }), factorOpen = ref(false);
try {
    await options();
}
catch (reason) {
    failure.value = apiMessage(reason);
}
const template = reactive({ name: '', channel: 'site', category: 'transactional', scope: 'account', subject: '', body: '', link: '', active: true });
const batch = reactive({ templateId: '' }), care = reactive({ name: '', templateId: '', trigger: 'registered_days', days: '1', productIds: [] as string[], active: false }), resolution = reactive({ action: 'retry', evidence: '' }), cancelling = ref<MessageBatch | null>(null), cancelReason = ref('');
const editorOpen = computed({ get: () => !!drawer.value, set: (value: boolean) => {
        if (!value && !busy.value)
            drawer.value = '';
    } });
const channelItems = computed(() => [{ value: 'site', label: '站内消息' }, { value: 'email', label: '邮件' + (capabilities.value.email ? '' : '（发送尚未启用）') }, { value: 'sms', label: '短信' + (capabilities.value.sms ? '' : '（发送尚未启用）') }]);
const batchTemplates = computed(() => templates.value.filter(item => item.active && item.scope === 'account' && capabilities.value[item.channel]).map(item => ({ value: item.id, label: item.name })));
const serviceCare = computed(() => care.trigger.startsWith('service_'));
const careTemplates = computed(() => templates.value.filter(item => item.active && item.scope === (serviceCare.value ? 'service' : 'account')).map(item => ({ value: item.id, label: item.name })));
async function searchCustomers() {
    busy.value = true;
    failure.value = '';
    try {
        customers.value = await api('/admin/clients?' + new URLSearchParams({ keyword: customerQuery.value.trim(), page: String(customerPage.value), limit: '50' }));
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
function begin(kind: string, item?: any) {
    drawer.value = kind;
    editing.value = item?.id ?? '';
    failure.value = '';
    success.value = '';
    password.value = '';
    proof.value = { mode: 'totp', code: '' };
    factorOpen.value = false;
    acknowledged.value = false;
    if (kind === 'template')
        Object.assign(template, { name: item?.name ?? '', channel: item?.channel ?? 'site', category: item?.category ?? 'transactional', scope: item?.scope ?? 'account', subject: item?.subject ?? '', body: item?.body ?? '', link: item?.link ?? '', active: item?.active ?? true });
    if (kind === 'batch') {
        batch.templateId = '';
        key.value = crypto.randomUUID();
        recipients.value = [];
        customerPage.value = 1;
        void searchCustomers();
    }
    if (kind === 'care')
        Object.assign(care, { name: item?.name ?? '', templateId: item?.templateId ?? '', trigger: item?.trigger ?? 'registered_days', days: String(item?.days ?? 1), productIds: item?.productIds ?? [], active: item?.active ?? false });
    if (kind === 'resolve') {
        selectedJob.value = item;
        resolution.action = 'retry';
        resolution.evidence = '';
    }
}
async function save() {
    busy.value = true;
    failure.value = '';
    try {
        if (drawer.value === 'template')
            await api('/admin/messaging/templates' + (editing.value ? '/' + editing.value : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...template, link: template.link.trim() || null } });
        if (drawer.value === 'care')
            await api('/admin/messaging/care' + (editing.value ? '/' + editing.value : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...care, days: Number(care.days) } });
        if (drawer.value === 'batch') {
            const result = await api<{
                id: string;
            }>('/admin/messaging/batches', { method: 'POST', headers: { 'Idempotency-Key': key.value }, body: { templateId: batch.templateId, userIds: recipients.value } });
            drawer.value = '';
            await router.push({ path: '/admin/messaging', query: { tab: 'jobs', batchId: result.id } });
            success.value = '发送意图已保存，可在任务状态中跟进机构确认。';
            return;
        }
        if (drawer.value === 'resolve') {
            await api(`/admin/messaging/jobs/${selectedJob.value!.id}/resolve`, { method: 'POST', body: { ...resolution, password: password.value, ...(factorOpen.value ? factorProof(proof.value) : {}) } });
            password.value = '';
            proof.value.code = '';
        }
        drawer.value = '';
        success.value = '已保存。';
        await Promise.all([refresh(), options()]);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
        if (/双因素|恢复码/.test(failure.value))
            factorOpen.value = true;
    }
    finally {
        busy.value = false;
    }
}
async function cancelBatch() {
    if (!cancelling.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        await api(`/admin/messaging/batches/${cancelling.value.id}/cancel`, { method: 'POST', body: { reason: cancelReason.value.trim() } });
        cancelling.value = null;
        await refresh();
        success.value = '尚未发送的任务已取消，已提交机构的记录仍然保留。';
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
const editorTitle = computed(() => ({ template: '消息模板', batch: '创建发送批次', care: '客户关怀规则', resolve: '核对发送结果' }[drawer.value] ?? '消息操作'));
const templateHint = '可插入 {{name}}、{{email}}、{{phone}}；服务模板还可插入 {{serviceName}}、{{serviceId}}、{{dueAt}}。';
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>消息与关怀</h1>
        <p>先把发送意图保存下来，再跟进每一条真实结果。</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <AppLink to="/admin" :underline="false" class="inline-flex min-h-11 items-center">管理首页</AppLink>
        <KimaButton @click="begin('batch')">批量发送</KimaButton>
      </div>
    </header>
    <nav class="flex flex-wrap gap-2 mb-6" aria-label="消息管理视图">
      <KimaButton
        v-for="item in tabs"
        :key="item.id"
        :variant="item.id===tab?'filled':'tonal'"
        @click="router.push({path:'/admin/messaging',query:{tab:item.id}})"
      >
        {{ item.label }}
      </KimaButton>
    </nav>
    <KimaAlert v-if="failure && !drawer && !cancelling" variant="danger" class="mb-5">{{ failure }}</KimaAlert>
    <KimaAlert v-if="success" class="mb-5">{{ success }}</KimaAlert>
    <div class="flex flex-wrap gap-3 mb-5">
      <KimaButton v-if="tab==='templates'" @click="begin('template')">新增模板</KimaButton>
      <KimaButton v-if="tab==='care'" @click="begin('care')">新增关怀规则</KimaButton>
      <label class="field-label min-w-0" v-if="tab==='jobs'">
        <span class="form-label">发送状态</span>
        <KimaSelect
          v-model="state"
          label="发送状态"
          :items="[{value:'',label:'全部状态'},...Object.entries(messageStates).map(([value,label])=>({value,label}))]"
        />
      </label>
      <KimaButton variant="text" :disabled="pending" @click="refresh">刷新</KimaButton>
      <AppLink
        v-if="tab==='jobs' && route.query.batchId"
        to="/admin/messaging?tab=jobs"
        :underline="false"
        class="inline-flex items-center min-h-11"
      >
        查看所有任务
      </AppLink>
    </div>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="!rows.length"
      title="这里还没有记录"
      description="新增后可以在这里继续管理与核对。"
      @retry="refresh"
    />
    <div v-if="tab==='templates'" class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article v-for="item in (rows as MessageTemplate[])" :key="item.id" class="panel p-6 min-w-0">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="text-lg font-semibold">{{ item.name }}</h2>
          <KimaChip>{{ item.active?'已启用':'已停用' }}</KimaChip>
        </div>
        <p class="muted text-sm mt-3">
          {{ item.channel==='site'?'站内':item.channel==='email'?'邮件':'短信' }}
          ·
          {{ item.category==='marketing'?'营销，遵循客户订阅':'事务通知' }}
          ·
          {{ item.scope==='service'?'服务模板':'账户模板' }}
        </p>
        <p class="font-medium mt-4">{{ item.subject }}</p>
        <p class="mt-3 whitespace-pre-wrap break-words">{{ item.body }}</p>
        <KimaButton variant="tonal" class="mt-5" @click="begin('template',item)">编辑模板</KimaButton>
      </article>
    </div>
    <div v-else-if="tab==='batches'" class="grid grid-cols-1 gap-4">
      <article v-for="item in (rows as MessageBatch[])" :key="item.id" class="panel p-6">
        <h2 class="font-semibold text-lg">{{ item.name }}</h2>
        <p class="muted mt-3">{{ item.total }} 位接收者 · 已受理／入站 {{ item.sent }} · 待处理 {{ item.pending }} · 待核对 {{ item.uncertain }}</p>
        <p class="muted text-sm mt-2">{{ date(item.createdAt) }}</p>
        <div class="mt-5 flex flex-wrap gap-3">
          <KimaButton variant="tonal" @click="router.push({path:'/admin/messaging',query:{tab:'jobs',batchId:item.id}})">查看每条进度</KimaButton>
          <KimaButton v-if="item.pending" variant="text" @click="cancelling=item;cancelReason='';failure=''">取消待发任务</KimaButton>
        </div>
      </article>
    </div>
    <div v-else-if="tab==='jobs'" class="grid grid-cols-1 gap-4">
      <article v-for="item in (rows as MessageJob[])" :key="item.id" class="panel p-5 sm:p-7">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="font-semibold">{{ item.subject }}</h2>
          <KimaChip>{{ item.state==='sent'?(item.channel==='site'?'站内已入站':'机构已接受'):messageStates[item.state] || item.state }}</KimaChip>
        </div>
        <p class="muted mt-3 break-all">
          {{ item.name }}
          ·
          {{ item.email || item.phone }}
          ·
          {{ item.channel==='site'?'站内':item.channel==='email'?'邮件':'短信' }}
        </p>
        <p v-if="item.lastError" class="mt-3 break-words">{{ item.lastError }}</p>
        <p class="muted text-sm mt-3">实际提交 {{ item.attempts }} 次 · {{ date(item.createdAt) }}</p>
        <p class="muted text-xs mt-2 break-all">机构幂等编号：{{ item.id }}</p>
        <KimaButton v-if="['failed','uncertain'].includes(item.state)" variant="tonal" class="mt-4" @click="begin('resolve',item)">核对并处理</KimaButton>
      </article>
      <div v-if="data?.total>data?.limit" class="form-actions justify-between">
        <KimaButton variant="tonal" :disabled="page===1 || pending" @click="page--">上一页</KimaButton>
        <span>第 {{ page }} 页</span>
        <KimaButton variant="tonal" :disabled="page*data.limit>=data.total || pending" @click="page++">下一页</KimaButton>
      </div>
    </div>
    <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article v-for="item in (rows as CareRule[])" :key="item.id" class="panel p-6">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="font-semibold text-lg">{{ item.name }}</h2>
          <KimaChip>{{ item.active?'已启用':'已停用' }}</KimaChip>
        </div>
        <p class="muted mt-4">{{ careTriggers.find(trigger=>trigger.value===item.trigger)?.label }}：{{ item.days }} 天</p>
        <p class="mt-3">使用模板：{{ item.templateName }}</p>
        <p class="form-hint mt-3">同一注册或服务日期只生成一次发送意图，实际发送遵循客户偏好。</p>
        <KimaButton variant="tonal" class="mt-5" @click="begin('care',item)">编辑规则</KimaButton>
      </article>
    </div>
    <KimaDrawer
      v-model:open="editorOpen"
      :title="editorTitle"
      placement="right"
      :role="drawer==='resolve'?'alertdialog':'dialog'"
      :close-on-backdrop="!busy"
      :close-on-escape="!busy"
    >
      <form id="messaging-editor" class="drawer-form" @submit.prevent="save">
        <template v-if="drawer==='template'">
          <label class="field-label min-w-0">
            <span class="form-label">模板名称</span>
            <KimaTextField v-model="template.name" label="模板名称" maxlength="100" required :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">发送渠道</span>
            <KimaSelect v-model="template.channel" label="发送渠道" :items="channelItems" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">通知用途</span>
            <KimaSelect
              v-model="template.category"
              label="通知用途"
              :items="[{value:'transactional',label:'事务进展通知'},{value:'marketing',label:'营销消息，须客户订阅'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">适用范围</span>
            <KimaSelect
              v-model="template.scope"
              label="适用范围"
              :items="[{value:'account',label:'账户，可用于批量发送'},{value:'service',label:'具体服务，用于服务关怀'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">消息标题</span>
            <KimaTextField v-model="template.subject" label="消息标题" maxlength="160" required :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">消息正文</span>
            <KimaTextarea
              v-model="template.body"
              label="消息正文"
              :maxlength="20000"
              required
              :hint="templateHint"
              :disabled="busy"
            />
          </label>
          <div class="flex flex-wrap gap-2">
            <KimaButton variant="text" type="button" :disabled="busy" @click="template.body+='{{name}}'">插入客户称呼</KimaButton>
            <KimaButton
              v-if="template.scope==='service'"
              variant="text"
              type="button"
              :disabled="busy"
              @click="template.body+='{{serviceName}}'"
            >
              插入服务名称
            </KimaButton>
            <KimaButton
              v-if="template.scope==='service'"
              variant="text"
              type="button"
              :disabled="busy"
              @click="template.body+='{{dueAt}}'"
            >
              插入到期日期
            </KimaButton>
          </div>
          <label class="field-label min-w-0">
            <span class="form-label">相关站内页面（选填）</span>
            <KimaTextField
              v-model="template.link"
              label="相关站内页面（选填）"
              placeholder="例如 /console/services"
              maxlength="500"
              :disabled="busy"
            />
          </label>
          <KimaCheckbox v-model="template.active" label="启用此模板" :disabled="busy" />
        </template>
        <template v-if="drawer==='batch'">
          <label class="field-label min-w-0">
            <span class="form-label">消息模板</span>
            <KimaSelect v-model="batch.templateId" label="消息模板" :items="batchTemplates" :disabled="busy" />
          </label>
          <KimaAlert v-if="!batchTemplates.length">请先创建并启用账户模板。站内渠道可直接使用，邮件与短信需要配置真实发送程序。</KimaAlert>
          <label class="field-label min-w-0">
            <span class="form-label">查找接收客户</span>
            <KimaTextField
              v-model="customerQuery"
              label="查找接收客户"
              placeholder="姓名或邮箱"
              maxlength="100"
              :disabled="busy"
            />
          </label>
          <KimaButton variant="tonal" type="button" :disabled="busy" @click="customerPage=1;searchCustomers()">查找客户</KimaButton>
          <p class="form-hint">已选择 {{ recipients.length }} 位客户。营销模板只会向已订阅的已验证目标发送。</p>
          <div class="grid grid-cols-1 gap-3 max-h-72 overflow-y-auto">
            <KimaCheckbox
              v-for="user in customers?.items"
              :key="user.id"
              :model-value="recipients.includes(user.id)"
              :label="user.name+' · '+(user.email || user.phone || user.id.slice(0,8))"
              :disabled="busy"
              @update:model-value="(checked:boolean)=>{recipients=checked?[...recipients,user.id]:recipients.filter(id=>id!==user.id)}"
            />
          </div>
          <div v-if="customers && customers.total>customers.limit" class="flex justify-between gap-3">
            <KimaButton type="button" variant="text" :disabled="busy || customerPage===1" @click="customerPage--;searchCustomers()">上一页</KimaButton>
            <KimaButton
              type="button"
              variant="text"
              :disabled="busy || customerPage*customers.limit>=customers.total"
              @click="customerPage++;searchCustomers()"
            >
              下一页
            </KimaButton>
          </div>
        </template>
        <template v-if="drawer==='care'">
          <label class="field-label min-w-0">
            <span class="form-label">规则名称</span>
            <KimaTextField v-model="care.name" label="规则名称" maxlength="100" required :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">何时关怀</span>
            <KimaSelect
              v-model="care.trigger"
              label="何时关怀"
              :items="careTriggers"
              :disabled="busy"
              @update:model-value="()=>{care.templateId='';if(!serviceCare)care.productIds=[]}"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">天数</span>
            <KimaTextField v-model="care.days" type="number" label="天数" min="0" max="365" required :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">发送模板</span>
            <KimaSelect v-model="care.templateId" label="发送模板" :items="careTemplates" :disabled="busy" />
          </label>
          <fieldset v-if="serviceCare">
            <legend class="form-label mb-3">适用商品（不选则包含所有商品）</legend>
            <div class="grid grid-cols-1 gap-3">
              <KimaCheckbox
                v-for="product in products"
                :key="product.id"
                :model-value="care.productIds.includes(product.id)"
                :label="product.name"
                :disabled="busy"
                @update:model-value="(checked:boolean)=>{care.productIds=checked?[...care.productIds,product.id]:care.productIds.filter(id=>id!==product.id)}"
              />
            </div>
          </fieldset>
          <KimaCheckbox v-model="care.active" label="启用此关怀规则" :disabled="busy" />
        </template>
        <template v-if="drawer==='resolve'">
          <p class="font-semibold break-words">{{ selectedJob?.subject }}</p>
          <KimaAlert>先按任务编号核对机构记录。重试会沿用原幂等编号；结果未知时，不能仅凭本地等待时间判断是否已发送。</KimaAlert>
          <label class="field-label min-w-0">
            <span class="form-label">核对后的操作</span>
            <KimaSelect
              v-model="resolution.action"
              label="核对后的操作"
              :items="[{value:'retry',label:'继续按原编号重试'},...(selectedJob?.state==='uncertain'?[{value:'confirm_sent',label:'已核对机构真实接受凭据'}]:[]),{value:'cancel',label:'取消后续发送'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">核对结果与凭据编号</span>
            <KimaTextarea
              v-model="resolution.evidence"
              label="核对结果与凭据编号"
              hint="请勿填写支付、邮件或短信密钥。"
              required
              :maxlength="1000"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">当前管理员密码</span>
            <KimaTextField
              v-model="password"
              label="当前管理员密码"
              type="password"
              autocomplete="current-password"
              required
              maxlength="128"
              :disabled="busy"
            />
          </label>
          <KimaCollapsible v-model:open="factorOpen" label="已启用双因素认证？填写安全验证">
            <SecondFactor v-model="proof" :disabled="busy || !factorOpen" />
          </KimaCollapsible>
          <KimaCheckbox v-model="acknowledged" label="我已核对机构记录，并确认这次处理" :disabled="busy" />
        </template>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="drawer=''">取消</KimaButton>
        <KimaButton
          type="submit"
          form="messaging-editor"
          :loading="busy"
          :disabled="drawer==='batch' && (!recipients.length || !batch.templateId) || drawer==='care' && !care.templateId || drawer==='resolve' && !acknowledged"
        >
          {{ drawer==='batch'?'保存并进入发送队列':'确认保存' }}
        </KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      :open="!!cancelling"
      title="取消这批尚未发送的任务？"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!busy"
      @update:open="(value:boolean)=>{if(!value)cancelling=null}"
    >
      <form id="cancel-message-batch" class="drawer-form" @submit.prevent="cancelBatch">
        <p>已经提交机构的发送记录会保留，只取消仍在等待的任务。</p>
        <label class="field-label min-w-0">
          <span class="form-label">取消原因</span>
          <KimaTextarea v-model="cancelReason" label="取消原因" required :maxlength="1000" :disabled="busy" />
        </label>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="cancelling=null">继续发送</KimaButton>
        <KimaButton type="submit" form="cancel-message-batch" :loading="busy">确认取消待发任务</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
