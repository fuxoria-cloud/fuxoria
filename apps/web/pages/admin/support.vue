<!-- 支持工作台：部门、工单、回复、知识和下载使用实际接口。调用：/admin/support?tab=tickets。 -->
<script setup lang="ts">
import { KimaCheckbox } from '@kernel4632/kima'; // 选择项直接使用KIMA提供的键盘与焦点行为
import type { Article, Product, User, PageResult } from '~/types/api';
import type { SupportTicket, Department, SupportAgent, ReplyTemplate, ContentCategory, DownloadItem, SupportFile } from '~/features/support';
definePageMeta({ layout: 'console', middleware: ['account', () => {
            if (!['admin', 'support'].includes(useAccount().user.value?.role ?? ''))
                return navigateTo('/console');
        }] });
useSeoMeta({ title: '支持工作台', robots: 'noindex, nofollow' });
const router = useRouter(), route = useRoute(), api = useApi(), account = useAccount();
const isAdmin = computed(() => account.user.value?.role === 'admin');
const tabs = computed(() => [{ id: 'tickets', label: '工单队列' }, ...(isAdmin.value ? [{ id: 'departments', label: '部门与成员' }, { id: 'replies', label: '快捷回复' }, { id: 'knowledge', label: '知识内容' }, { id: 'categories', label: '内容分类' }, { id: 'downloads', label: '下载资料' }, { id: 'messages', label: '发送消息' }] : [])]);
const tab = computed(() => tabs.value.some(item => item.id === route.query.tab) ? String(route.query.tab) : 'tickets');
const page = ref(1), search = ref(''), query = ref(''), status = ref(''), busy = ref(false), failure = ref(''), success = ref('');
const endpoints: Record<string, string> = { departments: '/admin/support/departments', replies: '/admin/support/replies', knowledge: '/admin/content', categories: '/admin/content/categories', downloads: '/admin/support/downloads', messages: '/admin/users' };
const endpoint = computed(() => tab.value === 'tickets' ? '/admin/support/tickets?' + new URLSearchParams({ page: String(page.value), q: search.value, ...(status.value ? { status: status.value } : {}) }) : endpoints[tab.value]!);
watch(tab, () => { page.value = 1; failure.value = ''; success.value = ''; });
const { data, pending, error, refresh } = await useAsyncData(computed(() => `support-desk:${endpoint.value}`), () => api<any>(endpoint.value));
const records = computed<any[]>(() => Array.isArray(data.value) ? data.value : data.value?.items ?? []);
const departments = ref<Department[]>([]), agents = ref<SupportAgent[]>([]), categories = ref<ContentCategory[]>([]), replyCategories = ref<{
    id: string;
    name: string;
}[]>([]), products = ref<Product[]>([]);
async function options() {
    [departments.value, agents.value] = await Promise.all([api<Department[]>('/admin/support/departments'), api<SupportAgent[]>('/admin/support/agents')]);
    if (isAdmin.value)
        [categories.value, replyCategories.value, products.value] = await Promise.all([api<ContentCategory[]>('/admin/content/categories'), api<{
                id: string;
                name: string;
            }[]>('/admin/support/reply-categories'), api<Product[]>('/products')]);
}
try {
    await options();
}
catch (reason) {
    failure.value = apiMessage(reason);
} // 选项失败保留具体原因，列表仍可重试
const departmentItems = computed(() => [{ value: '', label: '未分部门' }, ...departments.value.map(item => ({ value: item.id, label: item.name }))]);
const agentItems = computed(() => [{ value: '', label: '暂不指定' }, ...agents.value.map(item => ({ value: item.id, label: `${item.name} · ${item.email || item.id.slice(0, 8)}` }))]);
const categoryItems = (kind: string) => [{ value: '', label: '未分类' }, ...categories.value.filter(item => item.kind === kind).map(item => ({ value: item.id, label: item.name }))];
const replyItems = computed(() => [{ value: '', label: '未分类' }, ...replyCategories.value.map(item => ({ value: item.id, label: item.name }))]);
const productItems = computed(() => [{ value: '', label: '选择关联商品' }, ...products.value.map(item => ({ value: item.id, label: item.name }))]);
const drawer = ref(''), editing = ref(''), selectedMembers = ref<string[]>([]), ticket = ref<SupportTicket | null>(null), fileInput = ref<HTMLInputElement | null>(null);
const department = reactive({ name: '', description: '', active: 'true', position: '0' }), assignment = reactive({ departmentId: '', assignedTo: '', priority: 'normal', targetId: '' });
const reply = reactive({ title: '', message: '', categoryId: '' }), category = reactive({ name: '', kind: 'help', parentId: '', position: '0' }), replyCategoryName = ref('');
const article = reactive({ slug: '', title: '', content: '', kind: 'help', published: 'false', categoryId: '' });
const download = reactive({ fileId: '', name: '', title: '', description: '', categoryId: '', access: 'account', productId: '', published: 'false' });
const notice = reactive({ title: '', message: '', link: '' }), recipients = ref<string[]>([]);
const removing = ref<{
    path: string;
    label: string;
} | null>(null);
function open(kind: string, item?: any) {
    editing.value = item?.id ?? '';
    failure.value = '';
    success.value = '';
    drawer.value = kind;
    if (kind === 'department') {
        Object.assign(department, { name: item?.name ?? '', description: item?.description ?? '', active: String(item?.active ?? true), position: String(item?.position ?? 0) });
        selectedMembers.value = (item?.members ?? []).map((member: SupportAgent) => member.id);
    }
    if (kind === 'reply-category')
        replyCategoryName.value = item?.name ?? '';
    if (kind === 'reply')
        Object.assign(reply, { title: item?.title ?? '', message: item?.message ?? '', categoryId: item?.categoryId ?? '' });
    if (kind === 'category')
        Object.assign(category, { name: item?.name ?? '', kind: item?.kind ?? 'help', parentId: item?.parentId ?? '', position: String(item?.position ?? 0) });
    if (kind === 'article')
        Object.assign(article, { slug: item?.slug ?? '', title: item?.title ?? '', content: item?.content ?? '', kind: item?.kind ?? 'help', published: String(item?.published ?? false), categoryId: item?.categoryId ?? '' });
    if (kind === 'download')
        Object.assign(download, { fileId: item?.fileId ?? '', name: item?.name ?? '', title: item?.title ?? '', description: item?.description ?? '', categoryId: item?.categoryId ?? '', access: item?.access ?? 'account', productId: item?.productId ?? '', published: String(item?.published ?? false) });
    if (kind === 'assign') {
        ticket.value = item;
        Object.assign(assignment, { departmentId: item.departmentId ?? '', assignedTo: item.assignedTo ?? '', priority: item.priority, targetId: '' });
    }
}
/** 保存配置与刷新使用同一条流程，错误留在原表单，成功后再关闭。 */
async function save() {
    busy.value = true;
    failure.value = '';
    try {
        if (drawer.value === 'department') {
            const saved = await api<Department>('/admin/support/departments' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...department, active: department.active === 'true', position: Number(department.position) } });
            await api(`/admin/support/departments/${saved.id}/members`, { method: 'PUT', body: { userIds: selectedMembers.value } });
        }
        if (drawer.value === 'reply')
            await api('/admin/support/replies' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...reply, categoryId: reply.categoryId || null } });
        if (drawer.value === 'category')
            await api('/admin/content/categories' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...category, parentId: category.parentId || null, position: Number(category.position) } });
        if (drawer.value === 'article')
            await api('/admin/content' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { ...article, published: article.published === 'true', categoryId: article.categoryId || null } });
        if (drawer.value === 'download')
            await api('/admin/support/downloads' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { fileId: download.fileId, title: download.title, description: download.description, categoryId: download.categoryId || null, access: download.access, productId: download.productId || null, published: download.published === 'true' } });
        if (drawer.value === 'assign')
            await api(`/admin/support/tickets/${editing.value}/assign`, { method: 'POST', body: { departmentId: assignment.departmentId || null, assignedTo: assignment.assignedTo || null, priority: assignment.priority } });
        if (drawer.value === 'reply-category')
            await api('/admin/support/reply-categories' + (editing.value ? `/${editing.value}` : ''), { method: editing.value ? 'PUT' : 'POST', body: { name: replyCategoryName.value } });
        drawer.value = '';
        success.value = '已保存。';
        await Promise.all([refresh(), options()]);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function merge() {
    busy.value = true;
    failure.value = '';
    try {
        await api(`/admin/support/tickets/${editing.value}/merge`, { method: 'POST', body: { targetId: assignment.targetId.trim() } });
        drawer.value = '';
        success.value = '工单已合并，对话和附件已保留。';
        await refresh();
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function upload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file)
        return;
    busy.value = true;
    failure.value = '';
    try {
        const saved = await api<SupportFile>('/admin/support/files?' + new URLSearchParams({ name: file.name }), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        download.fileId = saved.id;
        download.name = saved.name;
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
async function remove() {
    if (!removing.value)
        return;
    busy.value = true;
    failure.value = '';
    try {
        await api(removing.value.path, { method: 'DELETE' });
        removing.value = null;
        await Promise.all([refresh(), options()]);
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
async function send() {
    busy.value = true;
    failure.value = '';
    success.value = '';
    try {
        const result = await api<{
            count: number;
        }>('/admin/notifications', { method: 'POST', body: { userIds: recipients.value, title: notice.title, message: notice.message, ...(notice.link.trim() ? { link: notice.link.trim() } : {}) } });
        notice.title = '';
        notice.message = '';
        notice.link = '';
        recipients.value = [];
        success.value = `已发送给 ${result.count} 个账户。`;
    }
    catch (reason) {
        failure.value = apiMessage(reason);
    }
    finally {
        busy.value = false;
    }
}
const editorOpen = computed({ get: () => !!drawer.value, set: (value: boolean) => {
        if (!value)
            drawer.value = '';
    } }); // 抽屉开关与业务表单名称各自保留明确类型
const drawerTitle = computed(() => ({ department: '部门与成员', reply: '快捷回复', category: '内容分类', article: '知识内容', download: '下载资料', assign: '工单安排', 'reply-category': '快捷回复分类' }[drawer.value] ?? '编辑'));
</script>
<template>
  <div>
    <header class="page-heading">
      <div>
        <h1>支持工作台</h1>
        <p>把问题交到合适的人手中，也把有用的答案留下来。</p>
      </div>
      <AppLink to="/admin" :underline="false">管理首页</AppLink>
    </header>
    <nav class="flex gap-2 flex-wrap mb-7" aria-label="支持工作台视图">
      <KimaButton
        v-for="item in tabs"
        :key="item.id"
        :variant="tab===item.id?'filled':'tonal'"
        @click="router.push({path:'/admin/support',query:{tab:item.id}})"
      >
        {{ item.label }}
      </KimaButton>
    </nav>
    <KimaAlert v-if="failure && !drawer && !removing" variant="danger" class="mb-5">{{ failure }}</KimaAlert>
    <KimaAlert v-if="success" class="mb-5">{{ success }}</KimaAlert>
    <div v-if="tab==='tickets'" class="panel p-5 mb-5">
      <form class="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem_auto]" @submit.prevent="search=query.trim();page=1">
        <label class="field-label min-w-0">
          <span class="form-label">查找工单</span>
          <KimaTextField v-model="query" label="查找工单" placeholder="输入标题" maxlength="160" />
        </label>
        <label class="field-label min-w-0">
          <span class="form-label">工单状态</span>
          <KimaSelect
            v-model="status"
            label="工单状态"
            :items="[{value:'',label:'全部状态'},{value:'open',label:'待处理'},{value:'answered',label:'已回复'},{value:'closed',label:'已结束'}]"
          />
        </label>
        <KimaButton type="submit" class="self-end">搜索</KimaButton>
      </form>
    </div>
    <div v-if="tab!=='tickets' && tab!=='messages'" class="flex flex-wrap gap-3 mb-5">
      <KimaButton
        @click="open(({departments:'department',replies:'reply',categories:'category',knowledge:'article',downloads:'download'} as Record<string,string>)[tab]!)"
      >
        新增
        {{ tabs.find(item=>item.id===tab)?.label }}
      </KimaButton>
      <KimaButton v-if="tab==='replies'" variant="tonal" @click="replyCategoryName='';open('reply-category')">新增回复分类</KimaButton>
      <KimaButton variant="text" :disabled="pending" @click="refresh">刷新</KimaButton>
    </div>
    <section v-if="tab==='replies' && replyCategories.length" class="panel p-5 mb-5">
      <h2 class="font-semibold mb-3">回复分类</h2>
      <div class="flex flex-wrap gap-3">
        <div v-for="item in replyCategories" :key="item.id" class="flex items-center gap-2">
          <KimaButton variant="tonal" @click="open('reply-category',item)">{{ item.name }}</KimaButton>
          <KimaButton variant="text" @click="removing={path:`/admin/support/reply-categories/${item.id}`,label:item.name}">删除</KimaButton>
        </div>
      </div>
    </section>
    <RequestState
      :pending="pending && !data"
      :error="error"
      :empty="records.length===0 && tab!=='messages'"
      title="这里还没有记录"
      description="新增后就能在这里继续管理。"
      @retry="refresh"
    />
    <div v-if="tab==='tickets'" class="grid grid-cols-1 gap-4">
      <article v-for="item in (records as SupportTicket[])" :key="item.id" class="panel p-5 sm:p-6">
        <div class="flex flex-wrap justify-between gap-3">
          <AppLink :to="`/console/tickets/${item.id}`" :underline="false" class="font-semibold text-lg break-words">{{ item.subject }}</AppLink>
          <StatusBadge :status="item.status" />
        </div>
        <p class="muted mt-3 break-words">
          {{ item.departmentName || '尚未分部门' }}
          ·
          {{ item.assigneeName || '等待认领' }}
          ·
          {{ item.priority==='high'?'紧急':item.priority==='low'?'咨询':'普通' }}
          ·
          {{ date(item.updatedAt || item.createdAt) }}
        </p>
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <KimaButton variant="tonal" @click="router.push(`/console/tickets/${item.id}`)">查看与回复</KimaButton>
          <KimaButton variant="text" :disabled="!!item.mergedInto" @click="open('assign',item)">分配与合并</KimaButton>
          <span class="muted text-xs break-all">{{ item.id }}</span>
        </div>
      </article>
      <div v-if="data?.total>data?.limit" class="form-actions justify-between">
        <KimaButton variant="tonal" :disabled="page===1 || pending" @click="page--">上一页</KimaButton>
        <span>第 {{ page }} 页 · {{ data.total }} 张</span>
        <KimaButton variant="tonal" :disabled="page*data.limit>=data.total || pending" @click="page++">下一页</KimaButton>
      </div>
    </div>
    <div v-else-if="tab==='departments'" class="grid grid-cols-1 gap-5 md:grid-cols-2">
      <article v-for="item in (records as Department[])" :key="item.id" class="panel p-6">
        <h2 class="font-semibold text-lg">
          {{ item.name }}
          <KimaChip v-if="!item.active" size="sm">已停用</KimaChip>
        </h2>
        <p class="mt-3 whitespace-pre-wrap break-words">{{ item.description }}</p>
        <p class="muted mt-4">{{ item.members?.map(member=>member.name).join('、') || '还没有成员' }}</p>
        <KimaButton variant="tonal" class="mt-5" @click="open('department',item)">编辑部门与成员</KimaButton>
      </article>
    </div>
    <div v-else-if="tab==='replies'" class="grid grid-cols-1 gap-4">
      <article v-for="item in (records as ReplyTemplate[])" :key="item.id" class="panel p-6">
        <p class="muted text-sm">{{ item.categoryName || '未分类' }}</p>
        <h2 class="font-semibold text-lg mt-1">{{ item.title }}</h2>
        <p class="whitespace-pre-wrap break-words mt-3">{{ item.message }}</p>
        <div class="flex gap-3 mt-5">
          <KimaButton variant="tonal" @click="open('reply',item)">编辑</KimaButton>
          <KimaButton variant="text" @click="removing={path:`/admin/support/replies/${item.id}`,label:item.title}">删除</KimaButton>
        </div>
      </article>
    </div>
    <div v-else-if="tab==='categories'" class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article v-for="item in (records as ContentCategory[])" :key="item.id" class="panel p-6">
        <p class="muted text-sm">{{ {help:'帮助',news:'公告',page:'独立页面',download:'下载'}[item.kind as 'help'] }}</p>
        <h2 class="font-semibold text-lg mt-2">{{ item.name }}</h2>
        <p v-if="item.parentId" class="muted mt-2">上级：{{ categories.find(parent=>parent.id===item.parentId)?.name }}</p>
        <div class="flex gap-3 mt-5">
          <KimaButton variant="tonal" @click="open('category',item)">编辑</KimaButton>
          <KimaButton variant="text" @click="removing={path:`/admin/content/categories/${item.id}`,label:item.name}">删除</KimaButton>
        </div>
      </article>
    </div>
    <div v-else-if="tab==='knowledge'" class="grid grid-cols-1 gap-4">
      <article v-for="item in (records as (Article&{categoryId:string|null})[])" :key="item.id" class="panel p-6">
        <div class="flex flex-wrap justify-between gap-3">
          <h2 class="font-semibold text-lg">{{ item.title }}</h2>
          <KimaChip size="sm">{{ item.published?'已发布':'草稿' }}</KimaChip>
        </div>
        <p class="muted mt-3">{{ categories.find(category=>category.id===item.categoryId)?.name || '未分类' }} · {{ date(item.updatedAt) }}</p>
        <div class="mt-4 flex flex-wrap gap-3">
          <KimaButton variant="tonal" @click="open('article',item)">编辑内容</KimaButton>
          <AppLink
            v-if="item.published"
            :to="`/${item.kind}/${item.slug}`"
            :underline="false"
            class="inline-flex items-center min-h-11"
          >
            查看发布页
          </AppLink>
          <KimaButton variant="text" @click="removing={path:`/admin/content/${item.id}`,label:item.title}">删除</KimaButton>
        </div>
      </article>
    </div>
    <div v-else-if="tab==='downloads'" class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <article v-for="item in (records as DownloadItem[])" :key="item.id" class="panel p-6 min-w-0">
        <h2 class="font-semibold text-lg">{{ item.title }}</h2>
        <p class="whitespace-pre-wrap break-words mt-3">{{ item.description }}</p>
        <p class="muted mt-3 break-all">{{ item.name }} · {{ Math.ceil(item.sizeBytes/1024) }}KB</p>
        <p class="muted mt-2">{{ item.published?'已发布':'草稿' }} · {{ item.access==='public'?'公开':item.access==='account'?'登录可见':'指定服务可见' }}</p>
        <div class="flex gap-3 mt-5">
          <KimaButton variant="tonal" @click="open('download',item)">编辑资料</KimaButton>
          <KimaButton variant="text" @click="removing={path:`/admin/support/downloads/${item.id}`,label:item.title}">删除</KimaButton>
        </div>
      </article>
    </div>
    <form v-else-if="tab==='messages'" class="panel p-5 sm:p-7 grid grid-cols-1 gap-5" @submit.prevent="send">
      <h2 class="font-semibold text-lg">发送站内消息</h2>
      <label class="field-label min-w-0">
        <span class="form-label">消息标题</span>
        <KimaTextField v-model="notice.title" label="消息标题" required maxlength="160" :disabled="busy" />
      </label>
      <label class="field-label min-w-0">
        <span class="form-label">消息正文</span>
        <KimaTextarea v-model="notice.message" label="消息正文" required :maxlength="20000" :disabled="busy" />
      </label>
      <label class="field-label min-w-0">
        <span class="form-label">相关页面（选填）</span>
        <KimaTextField v-model="notice.link" label="相关页面（选填）" placeholder="例如 /console/tickets" :disabled="busy" />
      </label>
      <fieldset>
        <legend class="form-label mb-3">选择接收账户</legend>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 max-h-80 overflow-y-auto">
          <div
            v-for="item in (records as User[])"
            :key="item.id"
            class="min-h-12 flex items-center gap-3 p-3 rounded-xl bg-[var(--kima-color-layer-2)] min-w-0"
          >
            <KimaCheckbox
              :model-value="recipients.includes(item.id)"
              :disabled="busy"
              :label="`${item.name} · ${item.email || item.phone || item.id.slice(0,8)}`"
              @update:model-value="(checked:boolean)=>{recipients=checked?[...recipients,item.id]:recipients.filter(id=>id!==item.id)}"
            />
          </div>
        </div>
      </fieldset>
      <div>
        <KimaButton type="submit" :loading="busy" :disabled="!recipients.length">发送给 {{ recipients.length }} 个账户</KimaButton>
      </div>
    </form>
    <KimaDrawer v-model:open="editorOpen" :title="drawerTitle" :close-on-backdrop="!busy" :close-on-escape="!busy">
      <form id="support-editor" class="drawer-form" @submit.prevent="save">
        <template v-if="drawer==='department'">
          <label class="field-label min-w-0">
            <span class="form-label">部门名称</span>
            <KimaTextField v-model="department.name" label="部门名称" required maxlength="100" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">部门说明</span>
            <KimaTextarea v-model="department.description" label="部门说明" :maxlength="2000" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">是否接收新工单</span>
            <KimaSelect
              v-model="department.active"
              label="是否接收新工单"
              :items="[{value:'true',label:'启用'},{value:'false',label:'停用'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">显示顺序</span>
            <KimaTextField
              v-model="department.position"
              label="显示顺序"
              type="number"
              min="0"
              max="10000"
              :disabled="busy"
            />
          </label>
          <fieldset>
            <legend class="form-label">团队成员</legend>
            <div v-for="agent in agents" :key="agent.id" class="min-h-12 flex gap-3 items-center py-3">
              <KimaCheckbox
                :model-value="selectedMembers.includes(agent.id)"
                :disabled="busy"
                :label="`${agent.name} · ${agent.email || agent.id.slice(0,8)}`"
                @update:model-value="(checked:boolean)=>{selectedMembers=checked?[...selectedMembers,agent.id]:selectedMembers.filter(id=>id!==agent.id)}"
              />
            </div>
          </fieldset>
        </template>
        <template v-if="drawer==='reply'">
          <label class="field-label min-w-0">
            <span class="form-label">回复名称</span>
            <KimaTextField v-model="reply.title" label="回复名称" required maxlength="160" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">回复分类</span>
            <KimaSelect v-model="reply.categoryId" label="回复分类" :items="replyItems" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">回复正文</span>
            <KimaTextarea v-model="reply.message" label="回复正文" required :maxlength="20000" :disabled="busy" />
          </label>
        </template>
        <label class="field-label min-w-0" v-if="drawer==='reply-category'">
          <span class="form-label">分类名称</span>
          <KimaTextField v-model="replyCategoryName" label="分类名称" required maxlength="100" :disabled="busy" />
        </label>
        <template v-if="drawer==='category'">
          <label class="field-label min-w-0">
            <span class="form-label">分类名称</span>
            <KimaTextField v-model="category.name" label="分类名称" required maxlength="100" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">内容类型</span>
            <KimaSelect
              v-model="category.kind"
              label="内容类型"
              :items="[{value:'help',label:'帮助文档'},{value:'news',label:'公告'},{value:'page',label:'独立页面'},{value:'download',label:'下载文件'}]"
              :disabled="busy || !!editing"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">上级分类</span>
            <KimaSelect
              v-model="category.parentId"
              label="上级分类"
              :items="categoryItems(category.kind).filter(item=>item.value!==editing)"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">显示顺序</span>
            <KimaTextField
              v-model="category.position"
              type="number"
              min="0"
              max="10000"
              label="显示顺序"
              :disabled="busy"
            />
          </label>
        </template>
        <template v-if="drawer==='article'">
          <label class="field-label min-w-0">
            <span class="form-label">标题</span>
            <KimaTextField v-model="article.title" label="标题" required maxlength="200" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">页面地址</span>
            <KimaTextField
              v-model="article.slug"
              label="页面地址"
              placeholder="如 getting-started"
              required
              maxlength="100"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">内容类型</span>
            <KimaSelect
              v-model="article.kind"
              label="内容类型"
              :items="[{value:'help',label:'帮助文档'},{value:'news',label:'公告'},{value:'page',label:'独立页面'}]"
              :disabled="busy"
              @update:model-value="article.categoryId=''"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">内容分类</span>
            <KimaSelect
              v-model="article.categoryId"
              label="内容分类"
              :items="categoryItems(article.kind)"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">正文</span>
            <KimaTextarea v-model="article.content" label="正文" required :maxlength="200000" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">发布状态</span>
            <KimaSelect
              v-model="article.published"
              label="发布状态"
              :items="[{value:'false',label:'保留草稿'},{value:'true',label:'发布'}]"
              :disabled="busy"
            />
          </label>
        </template>
        <template v-if="drawer==='download'">
          <label class="field-label min-w-0">
            <span class="form-label">资料名称</span>
            <KimaTextField v-model="download.title" label="资料名称" required maxlength="160" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">资料说明</span>
            <KimaTextarea v-model="download.description" label="资料说明" :maxlength="5000" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">下载分类</span>
            <KimaSelect
              v-model="download.categoryId"
              label="下载分类"
              :items="categoryItems('download')"
              :disabled="busy"
            />
          </label>
          <input
            ref="fileInput"
            type="file"
            class="sr-only"
            aria-label="上传下载中心文件"
            accept=".png,.jpg,.jpeg,.pdf,.zip,.txt,.log,.csv"
            :disabled="busy"
            @change="upload"
          />
          <div>
            <KimaButton variant="tonal" type="button" :disabled="busy" @click="fileInput?.click()">{{ download.fileId?'更换文件':'上传文件' }}</KimaButton>
            <p class="form-hint mt-3 break-all">{{ download.name || '每个文件最多5MiB，支持图片、PDF、ZIP或UTF-8文本。' }}</p>
          </div>
          <label class="field-label min-w-0">
            <span class="form-label">谁能下载</span>
            <KimaSelect
              v-model="download.access"
              label="谁能下载"
              :items="[{value:'public',label:'所有人'},{value:'account',label:'已登录账户'},{value:'service',label:'持有指定服务的账户'}]"
              :disabled="busy"
            />
          </label>
          <label class="field-label min-w-0" v-if="download.access==='service'">
            <span class="form-label">关联商品</span>
            <KimaSelect v-model="download.productId" label="关联商品" :items="productItems" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">发布状态</span>
            <KimaSelect
              v-model="download.published"
              label="发布状态"
              :items="[{value:'false',label:'保留草稿'},{value:'true',label:'发布'}]"
              :disabled="busy"
            />
          </label>
        </template>
        <template v-if="drawer==='assign'">
          <h2 class="font-semibold">{{ ticket?.subject }}</h2>
          <label class="field-label min-w-0">
            <span class="form-label">处理部门</span>
            <KimaSelect v-model="assignment.departmentId" label="处理部门" :items="departmentItems" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">跟进人员</span>
            <KimaSelect v-model="assignment.assignedTo" label="跟进人员" :items="agentItems" :disabled="busy" />
          </label>
          <label class="field-label min-w-0">
            <span class="form-label">紧急程度</span>
            <KimaSelect
              v-model="assignment.priority"
              label="紧急程度"
              :items="[{value:'low',label:'咨询'},{value:'normal',label:'普通'},{value:'high',label:'紧急'}]"
              :disabled="busy"
            />
          </label>
          <KimaAlert>合并会结束本工单，对话与附件保留到接收工单。接收工单必须属于同一客户并仍在处理中。</KimaAlert>
          <label class="field-label min-w-0">
            <span class="form-label">接收工单完整编号</span>
            <KimaTextField v-model="assignment.targetId" label="接收工单完整编号" :disabled="busy" />
          </label>
          <KimaButton variant="tonal" type="button" :disabled="busy || !assignment.targetId.trim()" @click="merge">合并到接收工单</KimaButton>
        </template>
        <KimaAlert v-if="failure" variant="danger">{{ failure }}</KimaAlert>
      </form>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="drawer=''">取消</KimaButton>
        <KimaButton type="submit" form="support-editor" :loading="busy" :disabled="drawer==='download' && !download.fileId">保存</KimaButton>
      </template>
    </KimaDrawer>
    <KimaDrawer
      :open="!!removing"
      title="确认删除这条记录？"
      role="alertdialog"
      :close-on-backdrop="false"
      :close-on-escape="!busy"
      @update:open="(value:boolean)=>{if(!value)removing=null}"
    >
      <p class="break-words">{{ removing?.label }}</p>
      <p class="form-hint mt-3">这条记录将从列表移除。</p>
      <KimaAlert v-if="failure" variant="danger" class="mt-4">{{ failure }}</KimaAlert>
      <template #footer>
        <KimaButton variant="tonal" :disabled="busy" @click="removing=null">保留</KimaButton>
        <KimaButton :loading="busy" @click="remove">确认删除</KimaButton>
      </template>
    </KimaDrawer>
  </div>
</template>
