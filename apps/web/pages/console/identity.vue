<!-- 身份与认证：本人提交资料、上传私有材料、查看人工核验历史及第三方绑定。秘密仅保留在当前表单。 -->
<script setup lang="ts">
import { KimaFileUpload, KimaAlertDialog } from '@kernel4632/kima';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '身份与认证', robots: 'noindex, nofollow' });
const api = useApi(), router = useRouter();
type Application = { id: string; kind: string; status: string; maskedName: string; maskedDocument: string; decisionReason: string; previousId: string | null; fileCount: number; createdAt: string };
type Binding = { id: string; provider: string; displayName: string };
const { data, pending, error, refresh } = await useAsyncData('identity-verification', async () => {
  const [channels, applications, providers, bindings] = await Promise.all([api<{ configured: boolean; channels: { id: string; name: string }[] }>('/certification-channels'), api<Application[]>('/certifications'), api<{ id: string; name: string }[]>('/oauth/providers'), api<Binding[]>('/oauth/bindings')]);
  return { channels, applications, providers, bindings };
});
const form = reactive({ kind: 'personal', name: '', documentType: 'identity', documentNumber: '', country: 'CN', company: '', registrationNumber: '', method: 'manual' });
const password = ref(''), proof = ref({ mode: 'totp' as 'totp' | 'recovery', code: '' }), files = ref<File[]>([]), busy = ref(''), message = ref(''), success = ref(''), removing = ref<Binding | null>(null);
const application = computed(() => data.value?.applications.find(item => item.status === 'pending'));
const labels: Record<string, string> = { pending: '人工审核中', approved: '人工审核通过', rejected: '人工审核未通过', withdrawn: '已撤回' };
function credentials() { return { password: password.value, ...factorProof(proof.value) }; }
function clearProof() { password.value = ''; proof.value.code = ''; }
async function upload(id: string) { for (const file of files.value) await api(`/certifications/${id}/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }); files.value = []; }
async function submit() {
  busy.value = 'application'; message.value = ''; success.value = '';
  try { const saved = await api<{ id: string }>('/certifications', { method: 'POST', body: { ...form, ...credentials() } }); clearProof(); form.name = ''; form.documentNumber = ''; form.company = ''; form.registrationNumber = ''; await upload(saved.id); success.value = '资料和证明材料已提交，审核结论会保留在下方记录中。'; }
  catch (error) { message.value = apiMessage(error); } finally { busy.value = ''; await refresh(); }
}
async function moreFiles() { if (!application.value) return; busy.value = 'files'; message.value = ''; try { await upload(application.value.id); success.value = '证明材料已保存。'; } catch (error) { message.value = apiMessage(error); } finally { busy.value = ''; await refresh(); } }
async function withdraw() { if (!application.value) return; busy.value = 'withdraw'; message.value = ''; try { await api(`/certifications/${application.value.id}/withdraw`, { method: 'POST', body: credentials() }); clearProof(); success.value = '本次申请已撤回，历史材料与处理记录保留。'; } catch (error) { message.value = apiMessage(error); } finally { busy.value = ''; await refresh(); } }
async function connect(id: string) { busy.value = id; message.value = ''; try { const saved = await api<{ url: string }>(`/oauth/${id}/bind`, { method: 'POST', body: { ...credentials(), next: '/console/identity' } }); clearProof(); window.location.assign(saved.url); } catch (error) { message.value = apiMessage(error); busy.value = ''; } }
async function unbind() { if (!removing.value) return; try { await api(`/oauth/bindings/${removing.value.id}`, { method: 'DELETE', body: credentials() }); clearProof(); await router.push('/login?next=/console/identity'); } catch (error) { throw new Error(apiMessage(error)); } }
</script>
<template>
  <div><header class="page-heading"><div><h1>身份与认证</h1><p>管理实名认证资料和用于登录的第三方身份。</p></div></header>
    <RequestState :pending="pending" :error="error" @retry="refresh" /><KimaAlert v-if="message" variant="danger" class="mb-6">{{ message }}</KimaAlert><KimaAlert v-if="success" variant="success" class="mb-6">{{ success }}</KimaAlert>
    <div v-if="data" class="grid grid-cols-1 gap-6">
      <KimaCard class="p-6"><h2 class="text-xl">本人确认</h2><p class="form-hint mt-2">提交、撤回和修改绑定需要当前密码，已开启双因素时还需验证码或恢复码。</p><div class="grid grid-cols-1 gap-5 mt-5 max-w-xl"><label class="grid grid-cols-1 gap-2">当前密码<KimaTextField v-model="password" label="当前密码" type="password" autocomplete="current-password" /></label><SecondFactor v-model="proof" :disabled="!!busy" /></div></KimaCard>
      <KimaCard class="p-6"><h2 class="text-xl">实名认证</h2><p class="muted text-sm mt-3">资料由管理员人工核对，审核结果会明确注明来源。证件和材料在部署存储中加密保存。</p>
        <KimaAlert v-if="!data.channels.configured" variant="info" class="mt-5">实名认证申请暂未开放。</KimaAlert>
        <form v-else-if="!application" class="grid grid-cols-1 gap-5 mt-6 md:grid-cols-2" @submit.prevent="submit">
          <div class="grid grid-cols-1 gap-2">认证类型<KimaSelect v-model="form.kind" label="认证类型" :items="[{value:'personal',label:'个人认证'},{value:'enterprise',label:'企业认证'}]" /></div>
          <div class="grid grid-cols-1 gap-2">核验方式<KimaSelect v-model="form.method" label="核验方式" :items="data.channels.channels.map(item => ({value:item.id,label:item.name}))" /></div>
          <label class="grid grid-cols-1 gap-2">{{ form.kind === 'enterprise' ? '法定代表人姓名' : '姓名' }}<KimaTextField v-model="form.name" label="姓名" required maxlength="120" autocomplete="off" /></label>
          <label class="grid grid-cols-1 gap-2">国家或地区代码<KimaTextField v-model="form.country" label="国家或地区代码" required maxlength="2" placeholder="CN" /></label>
          <div class="grid grid-cols-1 gap-2">证件类型<KimaSelect v-model="form.documentType" label="证件类型" :items="[{value:'identity',label:'身份证件'},{value:'passport',label:'护照'},{value:'other',label:'其他身份证明'}]" /></div>
          <label class="grid grid-cols-1 gap-2">证件号码<KimaTextField v-model="form.documentNumber" label="证件号码" required maxlength="80" autocomplete="off" /></label>
          <template v-if="form.kind === 'enterprise'"><label class="grid grid-cols-1 gap-2">企业名称<KimaTextField v-model="form.company" label="企业名称" required maxlength="200" /></label><label class="grid grid-cols-1 gap-2">企业登记号码<KimaTextField v-model="form.registrationNumber" label="企业登记号码" required maxlength="80" autocomplete="off" /></label></template>
          <div class="md:col-span-2"><KimaFileUpload v-model="files" label="选择证件或企业证明（PNG、JPEG、PDF）" accept="image/png,image/jpeg,.pdf" multiple :max-files="6" :max-size="5242880" required :disabled="!!busy" @reject="message = '每份材料最多5MiB，可选择六份PNG、JPEG或PDF。'" /></div>
          <KimaButton type="submit" :loading="busy === 'application'" :disabled="!!busy || !password || !files.length">提交人工核验</KimaButton>
        </form>
        <div v-else class="grid grid-cols-1 gap-4 mt-6"><KimaAlert variant="info">已有一份申请正在审核，已保存 {{ application.fileCount }} 份材料。可以补充材料或撤回。</KimaAlert><KimaFileUpload v-model="files" label="补充证明材料" accept="image/png,image/jpeg,.pdf" multiple :max-files="6 - application.fileCount" :max-size="5242880" :disabled="!!busy" /><div class="flex flex-wrap gap-3"><KimaButton :disabled="!!busy || !files.length" :loading="busy === 'files'" @click="moreFiles">上传补充材料</KimaButton><KimaButton variant="tonal" :disabled="!!busy || !password" :loading="busy === 'withdraw'" @click="withdraw">撤回这次申请</KimaButton></div></div>
        <div class="grid grid-cols-1 gap-4 mt-7"><KimaCard v-for="item in data.applications" :key="item.id" class="p-4"><div class="flex flex-wrap gap-3 justify-between"><strong>{{ item.kind === 'enterprise' ? '企业认证' : '个人认证' }} · {{ item.maskedName }}</strong><span>{{ labels[item.status] }}</span></div><p class="muted text-sm mt-2">{{ item.maskedDocument }} · {{ date(item.createdAt) }} · {{ item.fileCount }} 份材料</p><p v-if="item.decisionReason" class="mt-3">{{ item.decisionReason }}</p><p v-if="item.previousId" class="form-hint mt-2">这份申请保留前次认证的历史关联。</p></KimaCard></div>
      </KimaCard>
      <KimaCard class="p-6"><h2 class="text-xl">第三方登录</h2><p class="muted text-sm mt-3">绑定后可使用对应身份登录。解绑会撤销当前会话，需要重新登录。</p><div class="grid grid-cols-1 gap-4 mt-5"><KimaCard v-for="binding in data.bindings" :key="binding.id" class="p-4 flex flex-wrap items-center justify-between gap-3"><div><strong>{{ data.providers.find(item => item.id === binding.provider)?.name || binding.provider }}</strong><p class="muted text-sm mt-2">{{ binding.displayName || '已绑定' }}</p></div><KimaButton variant="tonal" :disabled="!!busy || !password" @click="removing = binding">解除绑定</KimaButton></KimaCard><KimaButton v-for="provider in data.providers.filter(item => !data!.bindings.some(binding => binding.provider === item.id))" :key="provider.id" variant="tonal" :disabled="!!busy || !password" :loading="busy === provider.id" @click="connect(provider.id)">绑定{{ provider.name }}</KimaButton><p v-if="!data.providers.length && !data.bindings.length" class="muted text-sm">当前没有开放的第三方登录通道。</p></div></KimaCard>
    </div>
    <KimaAlertDialog :open="!!removing" heading="解除第三方绑定？" description="解绑后该身份不能再登录狐岚云，当前会话也会失效。" confirm-label="确认解绑" :confirm-handler="unbind" @update:open="(value: boolean) => { if (!value) removing = null; }" />
  </div>
</template>
