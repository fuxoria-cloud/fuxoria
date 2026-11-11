<!-- 第三方登录确认：提供商完成身份授权后仍核对本地第二因素。票据只保留在HttpOnly Cookie。 -->
<script setup lang="ts">
definePageMeta({ layout: false });
useSeoMeta({ title: '确认第三方登录', robots: 'noindex, nofollow' });
const api = useApi(), router = useRouter(), account = useAccount();
const { data, pending, error, refresh } = await useAsyncData('oauth-pending', () => api<{ provider: string; factorRequired: boolean }>('/oauth/pending'), { server: false });
const proof = ref({ mode: 'totp' as 'totp' | 'recovery', code: '' }), busy = ref(false), message = ref('');
async function complete() {
  busy.value = true; message.value = '';
  try { const result = await api<{ next: string }>('/oauth/complete', { method: 'POST', body: data.value?.factorRequired ? factorProof(proof.value) : {} }); proof.value.code = ''; await account.load(); await router.push(result.next); }
  catch (error) { message.value = apiMessage(error); } finally { busy.value = false; }
}
</script>
<template>
  <main class="page-width py-12"><div class="max-w-lg mx-auto"><Brand /><KimaCard class="p-7 mt-8"><h1 class="text-2xl">确认这次登录</h1><p class="muted mt-3">第三方身份授权已经返回，请完成本次账号验证。</p><RequestState :pending="pending" :error="error" @retry="refresh" /><KimaAlert v-if="message" variant="danger" class="mt-5">{{ message }}</KimaAlert><form v-if="data" class="grid gap-6 mt-6" @submit.prevent="complete"><SecondFactor v-if="data.factorRequired" v-model="proof" required :disabled="busy" /><KimaButton type="submit" :loading="busy" :disabled="busy">确认登录</KimaButton></form><AppLink to="/login" class="mt-6">返回登录</AppLink></KimaCard></div></main>
</template>
