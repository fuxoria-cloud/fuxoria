<!-- 客户合同：申请文本快照、查看全文、本人签署与下载。调用：/console/contracts，签署需要当前密码/MFA。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '我的合同', robots: 'noindex, nofollow' });
interface Party {
  name: string;
  company: string;
  address: string;
  phone: string;
  email: string;
}
interface Contract {
  id: string;
  number: string;
  snapshot: {
    title: string;
    content: string;
    party: Party;
    service?: { id: string; name: string } | null;
  };
  snapshotHash: string;
  status: string;
  signer?: string;
  signedAt?: string;
  voidReason?: string;
  createdAt: string;
}
interface Template {
  id: string;
  title: string;
  content: string;
  productIds: string[];
}
const api = useApi(),
  base = useRuntimeConfig().public.apiBase;
const { data, pending, error, refresh } = await useAsyncData(
  'document-contracts',
  () => api<Contract[]>('/contracts'),
);
const { data: templates } = await useAsyncData(
  'document-contract-templates',
  () => api<Template[]>('/contract-templates'),
);
const { data: services } = await useAsyncData(
  'document-contract-services',
  () => api<{ id: string; name: string; status: string }[]>('/services'),
);
const creating = ref(false),
  selected = ref<Contract | null>(null),
  templateId = ref(''),
  serviceId = ref('');
const account = useAccount();
const party = reactive<Party>({
  name: account.user.value?.name ?? '',
  company: '',
  address: '',
  phone: '',
  email: account.user.value?.email ?? '',
});
const password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' }),
  accepted = ref(false),
  busy = ref(''),
  message = ref(''),
  success = ref('');
const labels: Record<string, string> = {
  pending: '待签署',
  signed: '已签署',
  cancelled: '已撤回',
  voided: '已作废',
};
const templateOptions = computed(() =>
  (templates.value ?? []).map((item) => ({
    value: item.id,
    label: item.title,
  })),
);
const serviceOptions = computed(() => [
  { value: '', label: '账户合同（不绑定服务）' },
  ...(services.value ?? [])
    .filter((item) => ['active', 'suspended'].includes(item.status))
    .map((item) => ({ value: item.id, label: item.name })),
]);
let attempt = { body: '', key: '' };
async function create() {
  busy.value = 'create';
  message.value = '';
  success.value = '';
  try {
    const body = {
        templateId: templateId.value,
        ...(serviceId.value ? { serviceId: serviceId.value } : {}),
        party: { ...party },
      },
      fingerprint = JSON.stringify(body);
    if (attempt.body !== fingerprint)
      attempt = { body: fingerprint, key: crypto.randomUUID() };
    const result = await api<{ id: string }>('/contracts', {
      method: 'POST',
      headers: { 'Idempotency-Key': attempt.key },
      body,
    });
    creating.value = false;
    await refresh();
    selected.value = data.value?.find((item) => item.id === result.id) ?? null;
    success.value = '合同已生成，请核对全文后签署。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
function view(item: Contract) {
  selected.value = item;
  creating.value = false;
  message.value = '';
  password.value = '';
  proof.value.code = '';
  accepted.value = false;
}
async function sign() {
  if (!selected.value) return;
  busy.value = selected.value.id;
  message.value = '';
  success.value = '';
  try {
    const id = selected.value.id;
    await api(`/contracts/${id}/sign`, {
      method: 'POST',
      body: {
        signer: selected.value.snapshot.party.name,
        accept: accepted.value,
        snapshotHash: selected.value.snapshotHash,
        password: password.value,
        ...factorProof(proof.value),
      },
    });
    password.value = '';
    proof.value.code = '';
    await refresh();
    selected.value = data.value?.find((item) => item.id === id) ?? null;
    success.value = '合同已签署，文本与签署记录已保存。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
async function cancel(item: Contract) {
  busy.value = item.id;
  message.value = '';
  try {
    await api(`/contracts/${item.id}/cancel`, { method: 'POST' });
    selected.value = null;
    await refresh();
    success.value = '待签合同已撤回。';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = '';
  }
}
</script>
<template>
  <div>
    <div class="page-heading">
      <div>
        <p class="eyebrow">约定留存</p>
        <h1>我的合同</h1>
        <p class="muted">核对合同全文和签约资料，再由主账号本人确认签署。</p>
      </div>
      <KimaButton
        @click="
          creating = true;
          selected = null;
          message = '';
        "
        >申请合同</KimaButton
      >
    </div>
    <KimaAlert
      v-if="error"
      variant="danger"
      :description="apiMessage(error)"
    /><KimaAlert
      v-if="success"
      variant="success"
      :description="success"
      class="mb-6"
    />
    <div class="identity-grid">
      <section class="panel">
        <div class="panel-header"><h2>合同记录</h2></div>
        <KimaSkeleton v-if="pending" /><KimaEmptyState
          v-else-if="!data?.length && !error"
          heading="还没有合同"
          description="需要签约时，可从可用模板申请。"
        />
        <article v-for="item in data" :key="item.id" class="identity-record">
          <h3>{{ item.snapshot.title }}</h3>
          <p class="muted">
            #{{ item.number }} · {{ labels[item.status] ?? item.status }} ·
            {{ date(item.createdAt) }}
          </p>
          <p v-if="item.snapshot.service" class="muted">
            {{ item.snapshot.service.name }}
          </p>
          <div class="identity-actions">
            <KimaButton variant="tonal" @click="view(item)">查看全文</KimaButton
            ><a
              :href="`${base}/contracts/${item.id}/document`"
              download
              class="min-h-11 inline-flex items-center px-3"
              >下载PDF</a
            >
          </div>
        </article>
      </section>
      <section class="panel">
        <form v-if="creating" class="identity-stack" @submit.prevent="create">
          <h2>申请合同</h2>
          <p v-if="!templates?.length" class="muted">目前没有可用合同模板。</p>
          <div
            ><span>合同模板</span
            ><KimaSelect
              v-model="templateId"
              label="合同模板"
              :items="templateOptions" /></div><div
            ><span>适用服务</span
            ><KimaSelect
              v-model="serviceId"
              label="适用服务"
              :items="serviceOptions"
          /></div>
          <div class="identity-fields">
            <label
              ><span>签约人姓名</span
              ><KimaTextField
                v-model="party.name"
                label="签约人姓名"
                required
                maxlength="100" /></label
            ><label
              ><span>公司名称（选填）</span
              ><KimaTextField
                v-model="party.company"
                label="公司名称"
                maxlength="200" /></label
            ><label class="identity-wide"
              ><span>联系地址</span
              ><KimaTextarea
                v-model="party.address"
                label="联系地址"
                required
                :maxlength="500" /></label
            ><label
              ><span>电话</span
              ><KimaTextField
                v-model="party.phone"
                label="签约联系电话"
                type="tel"
                required
                maxlength="40" /></label
            ><label
              ><span>邮箱</span
              ><KimaTextField
                v-model="party.email"
                label="签约联系邮箱"
                type="email"
                required
                maxlength="254"
            /></label>
          </div>
          <KimaAlert v-if="message" variant="danger" :description="message" />
          <div class="identity-actions">
            <KimaButton
              type="submit"
              :loading="!!busy"
              :disabled="!!busy || !templateId"
              >生成待签合同</KimaButton
            ><KimaButton variant="text" @click="creating = false"
              >取消</KimaButton
            >
          </div>
        </form>
        <div v-else-if="selected" class="identity-stack">
          <div>
            <p class="muted">
              合同 #{{ selected.number }} · {{ labels[selected.status] }}
            </p>
            <h2>{{ selected.snapshot.title }}</h2>
          </div>
          <div>
            <p>
              {{ selected.snapshot.party.name
              }}<template v-if="selected.snapshot.party.company">
                · {{ selected.snapshot.party.company }}</template
              >
            </p>
            <p class="muted">{{ selected.snapshot.party.address }}</p>
            <p class="muted break-all">
              {{ selected.snapshot.party.phone }} ·
              {{ selected.snapshot.party.email }}
            </p>
          </div>
          <div class="whitespace-pre-wrap break-words leading-7">
            {{ selected.snapshot.content }}
          </div>
          <details>
            <summary class="identity-check">核对文本指纹</summary>
            <code class="identity-secret">{{ selected.snapshotHash }}</code>
          </details>
          <p v-if="selected.signedAt" class="muted">
            {{ selected.signer }} 于 {{ date(selected.signedAt) }} 签署
          </p>
          <KimaAlert
            v-if="selected.voidReason"
            :description="selected.voidReason"
          />
          <form
            v-if="
              selected.status === 'pending' && !account.user.value?.delegated
            "
            class="identity-stack"
            @submit.prevent="sign"
          >
            <label class="identity-check"
              ><input
                v-model="accepted"
                type="checkbox"
                required
              />我已阅读全文，确认资料无误并同意签署。</label
            >
            <div class="identity-proof identity-stack">
              <label
                ><span>当前密码</span
                ><KimaTextField
                  v-model="password"
                  label="签署确认密码"
                  type="password"
                  required
                  autocomplete="current-password" /></label
              ><SecondFactor v-model="proof" />
            </div>
            <KimaAlert v-if="message" variant="danger" :description="message" />
            <div class="identity-actions">
              <KimaButton
                type="submit"
                :loading="!!busy"
                :disabled="!!busy || !accepted"
                >确认签署</KimaButton
              ><KimaButton
                variant="text"
                :disabled="!!busy"
                @click="cancel(selected!)"
                >撤回申请</KimaButton
              >
            </div>
          </form>
        </div>
        <div v-else>
          <h2>留一份清楚的约定</h2>
          <p class="muted">
            合同生成后保留当时的文本和签约资料。签署后可随时下载记录。
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
