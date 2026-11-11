<!-- 真实资源控制：按钮来自在线插件能力，动作经AJAX排队；敏感结果本人复核后只读一次。调用：/console/resources/:id。 -->
<script setup lang="ts">
import { factorProof, type FactorInput } from '~/features/factor';
import '~/assets/css/identity.css';
definePageMeta({ layout: 'console', middleware: 'account' });
useSeoMeta({ title: '资源控制', robots: 'noindex, nofollow' });
interface Field {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
}
interface Action {
  id: string;
  label: string;
  destructive?: boolean;
  fields?: Field[];
}
interface Metric {
  key: string;
  label: string;
  unit?: string;
}
interface Point {
  at: string;
  value: number;
}
interface Job {
  id: string;
  state: string;
  operation: string;
  actionId: string;
  createdAt: string;
  error?: string;
  result?: {
    data?: {
      operation: string;
      fields?: Record<string, string>;
      metrics?: Record<string, Point[]>;
      privateAvailable?: boolean;
      expiresAt?: string;
    };
  };
}
interface Model {
  service: { id: string; name: string; status: string };
  capability: {
    clientActions?: Action[];
    inspect?: Field[];
    metrics?: Metric[];
    consoleOrigins?: string[];
    credentialFields?: Field[];
  } | null;
  jobs: Job[];
}
const api = useApi(),
  route = useRoute(),
  account = useAccount();
const serviceId = String(route.params.id),
  { data, error, pending, refresh } = await useAsyncData(
    `resource:${serviceId}`,
    () => api<Model>(`/services/${serviceId}/resource`),
  );
const selected = ref<{
    operation: string;
    action?: Action;
    jobId?: string;
  } | null>(null),
  input = ref<Record<string, string>>({}),
  password = ref(''),
  proof = ref<FactorInput>({ mode: 'totp', code: '' }),
  busy = ref(false),
  message = ref(''),
  notice = ref(''),
  privateResult = ref<{
    console?: { url: string; expiresAt: string };
    credentials?: Record<string, string>;
  } | null>(null);
const sensitive = computed(
  () =>
    !!selected.value &&
    (!!selected.value.jobId ||
      ['console', 'credentials'].includes(selected.value.operation) ||
      selected.value.action?.destructive ||
      selected.value.action?.fields?.some((item) => item.secret)),
);
const capability = computed(() =>
    error.value ? null : data.value?.capability,
  ),
  isMain = computed(() => !account.user.value?.delegated);
const names: Record<string, string> = {
    action: '资源动作',
    inspect: '刷新状态',
    metrics: '刷新监控',
    console: '获取控制台',
    credentials: '获取登录凭据',
  },
  states: Record<string, string> = {
    queued: '排队中',
    running: '执行中',
    waiting: '等待供应商确认',
    succeeded: '已完成',
    failed: '执行失败',
    manual_review: '待人工核对',
  };
const monitorFrom = ref(''),
  monitorTo = ref(''),
  monitorMetric = ref('');
const monitorOptions = computed(() => [
  { value: '', label: '全部指标' },
  ...(capability.value?.metrics ?? []).map((item) => ({
    value: item.key,
    label: item.label,
  })),
]);
let attempt = { body: '', key: '' },
  timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    if (
      data.value?.jobs.some((job) =>
        ['queued', 'running', 'waiting'].includes(job.state),
      )
    )
      void refresh();
    if (
      privateResult.value?.console &&
      Date.parse(privateResult.value.console.expiresAt) <= Date.now()
    )
      privateResult.value = null;
  }, 3000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  privateResult.value = null;
  password.value = '';
  input.value = {};
});
function begin(operation: string, action?: Action, jobId?: string) {
  selected.value = { operation, action, jobId };
  input.value = {};
  monitorFrom.value = '';
  monitorTo.value = '';
  monitorMetric.value = '';
  password.value = '';
  proof.value = { mode: 'totp', code: '' };
  message.value = '';
  notice.value = '';
  privateResult.value = null;
  if (operation === 'inspect' && !jobId) void submit();
}
async function submit() {
  if (!selected.value) return;
  busy.value = true;
  message.value = '';
  try {
    const choice = selected.value,
      confirmation = sensitive.value
        ? { password: password.value, ...factorProof(proof.value) }
        : {};
    if (choice.jobId) {
      privateResult.value = await api(
        `/resource-jobs/${choice.jobId}/private`,
        { method: 'POST', body: confirmation },
      );
      notice.value = '私有结果已读取，刷新或离开页面后不再保留。';
    } else {
      if (choice.operation === 'metrics') {
        input.value = {
          ...(monitorMetric.value ? { metric: monitorMetric.value } : {}),
          ...(monitorFrom.value
            ? { from: new Date(monitorFrom.value).toISOString() }
            : {}),
          ...(monitorTo.value
            ? { to: new Date(monitorTo.value).toISOString() }
            : {}),
        };
      }
      const body = {
          operation: choice.operation,
          ...(choice.action ? { actionId: choice.action.id } : {}),
          input: input.value,
          ...confirmation,
        },
        fingerprint = JSON.stringify(body);
      if (attempt.body !== fingerprint)
        attempt = { body: fingerprint, key: crypto.randomUUID() };
      await api(`/services/${serviceId}/resource/jobs`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body,
      });
      notice.value = '操作已排队，供应商确认后会自动更新。';
      await refresh();
    }
    selected.value = null;
    password.value = '';
    input.value = {};
    proof.value.code = '';
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  }
}
function points(series: Point[]) {
  if (!series.length) return '';
  const values = series.map((item) => item.value),
    min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  return series
    .map(
      (item, i) =>
        `${series.length === 1 ? 150 : (i / (series.length - 1)) * 300},${90 - ((item.value - min) / range) * 80}`,
    )
    .join(' ');
}
const recentState = computed(
    () =>
      data.value?.jobs.find(
        (job) => job.state === 'succeeded' && job.operation === 'inspect',
      )?.result?.data?.fields,
  ),
  recentMetrics = computed(
    () =>
      data.value?.jobs.find(
        (job) => job.state === 'succeeded' && job.operation === 'metrics',
      )?.result?.data?.metrics,
  );
const privateFields = computed(() =>
  Object.entries(privateResult.value?.credentials ?? {}).map(
    ([key, value]) => ({
      key,
      value,
      label:
        capability.value?.credentialFields?.find((field) => field.key === key)
          ?.label ?? key,
    }),
  ),
);
function live(job: Job) {
  return (
    !!job.result?.data?.privateAvailable &&
    Date.parse(job.result.data.expiresAt ?? '') > Date.now()
  );
}
</script>
<template>
  <main class="page-stack identity-page resource-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">SERVICE CONTROL</p>
        <h1>{{ data?.service.name ?? '资源控制' }}</h1>
        <p class="muted">查看供应商真实状态，操作完成后自动更新。</p>
      </div>
      <AppLink to="/console/services">返回服务</AppLink>
    </header>
    <KimaAlert v-if="error" variant="danger" :description="apiMessage(error)" />
    <KimaAlert v-if="notice" variant="success" :description="notice" />
    <KimaSkeleton v-if="pending && !data" class="h-40" />
    <KimaEmptyState
      v-else-if="!capability && !error"
      heading="供应商当前未开放在线控制"
      description="现有服务不受影响，可稍后刷新或通过工单联系管理员。"
    />
    <template v-else-if="capability">
      <section class="panel identity-stack">
        <h2>服务操作</h2>
        <div class="identity-actions">
          <KimaButton
            v-if="capability.inspect?.length"
            variant="tonal"
            :disabled="busy"
            @click="begin('inspect')"
            >刷新状态</KimaButton
          >
          <KimaButton
            v-if="capability.metrics?.length"
            variant="tonal"
            :disabled="busy"
            @click="begin('metrics')"
            >刷新监控</KimaButton
          >
          <KimaButton
            v-for="action in capability.clientActions"
            :key="action.id"
            :disabled="
              busy ||
              (!isMain &&
                (action.destructive ||
                  action.fields?.some((field) => field.secret)))
            "
            :variant="action.destructive ? 'outlined' : 'tonal'"
            @click="begin('action', action)"
            >{{ action.label }}</KimaButton
          >
          <KimaButton
            v-if="capability.consoleOrigins?.length"
            :disabled="busy || !isMain"
            @click="begin('console')"
            >打开控制台</KimaButton
          >
          <KimaButton
            v-if="capability.credentialFields?.length"
            variant="tonal"
            :disabled="busy || !isMain"
            @click="begin('credentials')"
            >获取登录凭据</KimaButton
          >
        </div>
      </section>
      <section v-if="recentState" class="panel identity-stack">
        <h2>供应商状态</h2>
        <dl class="resource-values">
          <div v-for="field in capability.inspect" :key="field.key">
            <dt>{{ field.label }}</dt>
            <dd>{{ recentState[field.key] ?? '—' }}</dd>
          </div>
        </dl>
      </section>
      <section v-if="recentMetrics" class="panel identity-stack">
        <h2>运行监控</h2>
        <div class="resource-charts">
          <figure v-for="metric in capability.metrics" :key="metric.key">
            <figcaption>
              {{ metric.label }} <span class="muted">{{ metric.unit }}</span>
            </figcaption>
            <template v-if="recentMetrics[metric.key]?.length"
              ><svg
                viewBox="0 0 300 100"
                role="img"
                :aria-label="metric.label + '趋势'"
              >
                <polyline
                  :points="points(recentMetrics[metric.key]!)"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
              <p class="muted">
                最近：{{ recentMetrics[metric.key]?.at(-1)?.value }}
                {{ metric.unit }} ·
                {{ date(recentMetrics[metric.key]?.at(-1)?.at) }}
              </p>
              <details>
                <summary>查看数据点</summary>
                <p v-for="point in recentMetrics[metric.key]" :key="point.at">
                  {{ point.at }} · {{ point.value }} {{ metric.unit }}
                </p>
              </details></template
            >
            <p v-else class="muted">供应商没有返回数据点。</p>
          </figure>
        </div>
      </section>
    </template>
    <section v-if="selected" class="panel identity-stack">
      <form class="identity-stack" @submit.prevent="submit">
        <h2>
          {{
            selected.jobId
              ? '读取私有结果'
              : (selected.action?.label ?? names[selected.operation])
          }}
        </h2>
        <p v-if="selected.action?.destructive" class="muted">
          这项操作会改变服务，请确认已保存需要的数据。
        </p>
        <label v-for="field in selected.action?.fields" :key="field.key"
          ><span>{{ field.label }}</span
          ><KimaTextField
            v-model="input[field.key]"
            :label="field.label"
            :type="field.secret ? 'password' : 'text'"
            :required="field.required"
            maxlength="4096"
            autocomplete="off"
        /></label>
        <div v-if="selected.operation === 'metrics'" class="identity-fields">
          <KimaSelect
            v-model="monitorMetric"
            label="监控指标"
            :items="monitorOptions"
          /><KimaTextField
            v-model="monitorFrom"
            label="监控开始时间"
            type="datetime-local"
          /><KimaTextField
            v-model="monitorTo"
            label="监控结束时间"
            type="datetime-local"
          />
          <p class="muted identity-wide">
            可查询最长31天的数据，留空时使用供应商默认时间段。
          </p>
        </div>
        <div v-if="sensitive" class="identity-proof identity-stack">
          <h3>主账号确认</h3>
          <KimaTextField
            v-model="password"
            label="当前密码"
            type="password"
            autocomplete="current-password"
            required
          /><SecondFactor v-model="proof" />
        </div>
        <KimaAlert v-if="message" variant="danger" :description="message" />
        <div class="identity-actions">
          <KimaButton type="submit" :loading="busy" :disabled="busy">{{
            selected.jobId ? '验证并读取' : '确认提交'
          }}</KimaButton
          ><KimaButton
            variant="text"
            :disabled="busy"
            @click="
              selected = null;
              password = '';
              input = {};
            "
            >取消</KimaButton
          >
        </div>
      </form>
    </section>
    <section v-if="privateResult" class="panel identity-stack">
      <h2>私有结果</h2>
      <p class="muted">仅在本页临时显示，请妥善保管。</p>
      <a
        v-if="
          privateResult.console &&
          Date.parse(privateResult.console.expiresAt) > Date.now()
        "
        :href="privateResult.console.url"
        target="_blank"
        rel="noopener noreferrer"
        referrerpolicy="no-referrer"
        class="resource-console-link"
        >进入供应商控制台</a
      >
      <dl v-if="privateFields.length" class="resource-values">
        <div v-for="field in privateFields" :key="field.key">
          <dt>{{ field.label }}</dt>
          <dd class="break-all">{{ field.value }}</dd>
        </div>
      </dl>
      <KimaButton variant="text" @click="privateResult = null"
        >隐藏结果</KimaButton
      >
    </section>
    <section v-if="data?.jobs.length" class="panel identity-stack">
      <h2>操作记录</h2>
      <article v-for="job in data.jobs" :key="job.id" class="resource-job">
        <div>
          <h3>
            {{
              capability?.clientActions?.find(
                (action) => action.id === job.actionId,
              )?.label ?? names[job.operation]
            }}
          </h3>
          <p class="muted">
            {{ states[job.state] ?? job.state }} · {{ date(job.createdAt) }}
          </p>
          <p v-if="job.error">{{ job.error }}</p>
        </div>
        <KimaButton
          v-if="live(job) && isMain"
          variant="tonal"
          @click="begin(job.operation, undefined, job.id)"
          >验证并读取</KimaButton
        >
      </article>
    </section>
  </main>
</template>
<style scoped>
.resource-page {
  display: grid;
  gap: var(--kima-space-6);
}
.resource-page > .panel {
  padding: var(--kima-space-6);
}
.resource-page > .page-heading {
  margin-bottom: 0;
}
.resource-page h2 {
  font-size: var(--kima-font-size-title-medium);
  font-weight: var(--kima-font-weight-medium);
}
.resource-page h3 {
  font-size: var(--kima-font-size-title-small);
}
@media (max-width: 600px) {
  .resource-page > .panel {
    padding: var(--kima-space-5);
  }
}

.resource-values {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.resource-values dt {
  color: var(--kima-color-on-surface-variant);
}
.resource-values dd {
  margin: 0.3rem 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.resource-charts {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
}
.resource-charts figure {
  margin: 0;
  min-width: 0;
}
.resource-charts svg {
  width: 100%;
  max-height: 180px;
  color: var(--kima-color-primary);
}
.resource-job {
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--kima-color-outline-variant);
  padding: 1rem 0;
}
.resource-console-link {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  text-decoration: underline;
}
@media (max-width: 600px) {
  .resource-job {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
