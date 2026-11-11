<!-- 实名核验：默认遮盖资料；查看原文、下载材料和决策均需本人证明并留下访问审计。 -->
<script setup lang="ts">
import { KimaCheckbox, KimaAlertDialog } from '@kernel4632/kima';
definePageMeta({ layout: 'console', middleware: ['account', 'admin'] });
useSeoMeta({ title: '实名资料核验', robots: 'noindex, nofollow' });
const api = useApi();
type Application = { id: string; email: string; kind: string; status: string; method: string; maskedName: string; maskedDocument: string; fileCount: number; createdAt: string; decisionReason: string };
const state = ref('pending');
const { data, pending, error, refresh } = await useAsyncData(computed(() => 'certification-admin:' + state.value), () => api<Application[]>('/admin/certifications?status=' + state.value));
const selected = ref<Application | null>(null), password = ref(''), proof = ref({ mode: 'totp' as 'totp' | 'recovery', code: '' }), reason = ref(''), reference = ref(''), reviewed = ref(false), busy = ref(''), message = ref('');
const material = ref<{ details: Record<string, string>; files: { id: string; name: string; mediaType: string; sizeBytes: number }[] } | null>(null);
const decision = ref<'approved' | 'rejected' | ''>('');
const statuses: Record<string, string> = { pending: '人工审核中', approved: '人工审核通过', rejected: '人工审核未通过', withdrawn: '已撤回' };
function credentials() { return { password: password.value, ...factorProof(proof.value) }; }
function choose(item: Application) { selected.value = item; material.value = null; password.value = ''; proof.value.code = ''; reason.value = ''; reference.value = ''; reviewed.value = false; message.value = ''; }
function close(value: boolean) { if (value) return; selected.value = null; material.value = null; password.value = ''; proof.value.code = ''; }
async function reveal() { busy.value = 'reveal'; message.value = ''; try { material.value = await api(`/admin/certifications/${selected.value!.id}/reveal`, { method: 'POST', body: { ...credentials(), reason: reason.value } }); proof.value.code = ''; } catch (error) { message.value = apiMessage(error); } finally { busy.value = ''; } }
async function openFile(id: string) {
  busy.value = id; message.value = '';
  try { const blob = await $fetch<Blob>(`${useRuntimeConfig().public.apiBase}/admin/certifications/${selected.value!.id}/files/${id}/open`, { method: 'POST', credentials: 'include', responseType: 'blob', body: { ...credentials(), reason: reason.value } }); const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = '认证材料-' + id + (blob.type === 'application/pdf' ? '.pdf' : blob.type === 'image/png' ? '.png' : '.jpg'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); proof.value.code = ''; }
  catch (error) { const value = error as { data?: Blob }; if (value.data instanceof Blob) { try { message.value = JSON.parse(await value.data.text()).message; } catch { message.value = '材料读取失败，请核对本人验证后重试。'; } } else message.value = apiMessage(error); } finally { busy.value = ''; }
}
async function decide() {
  try { await api(`/admin/certifications/${selected.value!.id}/decision`, { method: 'POST', body: { ...credentials(), decision: decision.value, reason: reason.value, reviewReference: reference.value, reviewedEvidence: reviewed.value } }); decision.value = ''; close(false); await refresh(); }
  catch (error) { throw new Error(apiMessage(error)); }
}
</script>
<template>
  <div><AppLink to="/admin" class="auth-back mb-6">返回管理后台</AppLink><header class="page-heading"><div><h1>实名资料核验</h1><p>查看真实材料后记录人工核验依据。每次原文访问和处理结论均保留审计。</p></div></header>
    <div class="max-w-sm mb-6"><KimaSelect v-model="state" label="认证状态" :items="[{value:'pending',label:'等待核验'},{value:'approved',label:'人工审核通过'},{value:'rejected',label:'人工审核未通过'},{value:'withdrawn',label:'已撤回'},{value:'all',label:'全部记录'}]" /></div>
    <RequestState :pending="pending" :error="error" :empty="data?.length === 0" title="当前没有这类申请" description="可切换状态查看历史记录。" @retry="refresh" />
    <div class="grid grid-cols-1 gap-4"><KimaCard v-for="item in data || []" :key="item.id" class="p-5"><div class="flex flex-wrap justify-between items-center gap-4"><div><h2 class="font-semibold break-all">{{ item.email }}</h2><p class="muted text-sm mt-2">{{ item.kind === 'enterprise' ? '企业' : '个人' }} · {{ item.maskedName }} · {{ item.maskedDocument }}</p><p class="muted text-sm mt-2">{{ statuses[item.status] }} · {{ item.fileCount }} 份材料 · {{ date(item.createdAt) }}</p></div><KimaButton variant="tonal" @click="choose(item)">查看与核验</KimaButton></div><p v-if="item.decisionReason" class="mt-3">{{ item.decisionReason }}</p></KimaCard></div>
    <KimaDrawer :open="!!selected" title="人工核验资料" placement="right" @update:open="close">
      <div v-if="selected" class="grid grid-cols-1 gap-5"><p class="break-all">{{ selected.email }} · {{ selected.maskedName }}</p><KimaAlert v-if="message" variant="danger">{{ message }}</KimaAlert>
        <label class="grid grid-cols-1 gap-2">查看与处理说明<KimaTextarea v-model="reason" label="查看与处理说明" required minlength="3" maxlength="2000" placeholder="说明本次核验用途与结论依据，请勿复制证件号码。" /></label>
        <label class="grid grid-cols-1 gap-2">当前密码<KimaTextField v-model="password" label="当前密码" type="password" autocomplete="current-password" /></label><SecondFactor v-model="proof" :disabled="!!busy" />
        <KimaButton variant="tonal" :disabled="!!busy || !password || reason.trim().length < 3" :loading="busy === 'reveal'" @click="reveal">核对身份并查看原文</KimaButton>
        <template v-if="material"><dl class="grid grid-cols-1 gap-3"><template v-for="(value, field) in material.details" :key="field"><dt class="muted text-sm">{{ ({name:'姓名',documentType:'证件类型',documentNumber:'证件号码',country:'国家或地区',company:'企业名称',registrationNumber:'企业登记号码'} as Record<string,string>)[field] || field }}</dt><dd class="break-all">{{ value || '未填写' }}</dd></template></dl><div class="grid grid-cols-1 gap-3"><KimaButton v-for="file in material.files" :key="file.id" variant="tonal" :loading="busy === file.id" :disabled="!!busy || !password" @click="openFile(file.id)">下载{{ file.name }} · {{ file.sizeBytes }}B</KimaButton></div></template>
        <template v-if="selected.status === 'pending'"><label class="grid grid-cols-1 gap-2">核验凭据编号或来源<KimaTextField v-model="reference" label="核验凭据编号或来源" maxlength="200" placeholder="内部核验记录号或实际核对来源" /></label><KimaCheckbox v-model="reviewed" label="已实际核对证明材料，确认记录的是人工核验结论" /><KimaAlert variant="info">人工核验结果会明确标注来源。外部机构认证应以该机构的实际返回为准。</KimaAlert><div class="grid grid-cols-1 gap-3"><KimaButton :disabled="!!busy || !material || !reviewed || !password || reference.trim().length < 3" @click="decision = 'approved'">记录人工审核通过</KimaButton><KimaButton variant="tonal" :disabled="!!busy || !reviewed || !password || reference.trim().length < 3" @click="decision = 'rejected'">记录审核未通过</KimaButton></div></template>
      </div>
    </KimaDrawer>
    <KimaAlertDialog :open="!!decision" heading="保存这次人工核验结论？" description="处理结论会保留在认证历史中，确认后不能覆盖。" confirm-label="确认保存" :danger="decision === 'rejected'" :confirm-handler="decide" @update:open="(value: boolean) => { if (!value) decision = ''; }" />
  </div>
</template>
