<!-- 信用付款：本人确认借用已授予的额度，不增加钱包余额。调用：<CreditPayment :invoice="invoice" @paid="refresh" />。 -->
<script setup lang="ts">
import type { Invoice } from "~/types/api"; // 可用入口由服务端授信结果决定
import type { FactorInput } from "~/features/factor"; // 本人证明复用同一验证表单
import { factorProof } from "~/features/factor";
const props = defineProps<{ invoice: Invoice }>(),
  emit = defineEmits<{ paid: [] }>();
const account = useAccount(),
  api = useApi(),
  open = ref(false),
  busy = ref(false),
  message = ref(""),
  password = ref(""); // 密码只留在当前表单
const factor = ref<FactorInput>({ mode: "totp", code: "" });
async function pay() {
  busy.value = true;
  message.value = "";
  try {
    await api(`/invoices/${props.invoice.id}/pay-credit`, {
      method: "POST",
      body: { password: password.value, ...factorProof(factor.value) },
    });
    open.value = false;
    password.value = "";
    factor.value.code = "";
    emit("paid");
  } catch (failure) {
    message.value = apiMessage(failure);
  } finally {
    busy.value = false;
  } // 服务端再次检查额度、到期欠款和真实交付
}
</script>
<template>
  <section
    v-if="invoice.creditEligible && !account.user.value?.delegated"
    class="mt-6"
  >
    <h3>使用信用额度</h3>
    <p class="form-hint mt-2">
      借用已授予的额度结清业务账单，之后按约定账期还款。
    </p>
    <KimaButton variant="tonal" class="w-full mt-4" @click="open = true"
      >核对信用付款</KimaButton
    >
  </section>
  <KimaDrawer
    v-model:open="open"
    title="确认使用信用额度"
    :close-on-backdrop="!busy"
    :close-on-escape="!busy"
  >
    <p class="mb-5">
      本次借用
      {{
        money(invoice.amountCents, invoice.currency, invoice.currencyDecimals)
      }}，实际应还账期可在信用额度页核对。
    </p>
    <form @submit.prevent="pay" class="grid gap-5">
      <label class="field-label"
        ><span class="form-label">当前密码</span
        ><KimaTextField
          v-model="password"
          label="当前密码"
          type="password"
          autocomplete="current-password"
          required
          :disabled="busy"
      /></label>
      <SecondFactor v-model="factor" :disabled="busy" /><KimaAlert
        v-if="message"
        variant="danger"
        >{{ message }}</KimaAlert
      >
      <KimaButton type="submit" :loading="busy">确认使用信用额度</KimaButton>
    </form>
  </KimaDrawer>
</template>
