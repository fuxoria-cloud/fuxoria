<!-- 第二因素填写：KIMA下拉与文本框承接验证码/恢复码选择。调用：<SecondFactor v-model="proof" />。 -->
<script setup lang="ts">
import type { FactorInput } from '~/features/factor'; // 登录、改密和资金审批复用同一份形状
const proof = defineModel<FactorInput>({ required: true }); // 证明只存在调用方当前表单中
withDefaults(defineProps<{ required?: boolean; disabled?: boolean }>(), {
  required: false,
  disabled: false,
}); // 是否必须提供由当前安全动作决定
const methods = [
  { value: 'totp', label: '身份验证器的验证码' },
  { value: 'recovery', label: '一次性恢复码' },
]; // 不能同时输入两种证明
watch(
  () => proof.value.mode,
  () => {
    proof.value.code = '';
  },
); // 切换方法后不误发旧证明
</script>
<template>
  <div class="second-factor">
    <div class="field-label">
      <span class="form-label">安全验证方式</span>
      <KimaSelect v-model="proof.mode" label="安全验证方式" :items="methods" :disabled="disabled" />
    </div>
    <label class="field-label mt-5">
      <span class="form-label">{{ proof.mode === 'totp' ? '6位验证码' : '一次性恢复码' }}</span>
      <KimaTextField
        v-model="proof.code"
        :label="proof.mode === 'totp' ? '6位验证码' : '一次性恢复码'"
        :inputmode="proof.mode === 'totp' ? 'numeric' : 'text'"
        :pattern="proof.mode === 'totp' ? '[0-9]{6}' : undefined"
        :maxlength="proof.mode === 'totp' ? 6 : 64"
        :placeholder="proof.mode === 'totp' ? '123456' : '填写保存的恢复码'"
        autocomplete="one-time-code"
        :required="required"
        :disabled="disabled"
        :hint="
          proof.mode === 'totp'
            ? '打开身份验证器，填写当前6位数字。已使用的验证码需等待更新。'
            : '每条恢复码只能使用一次。'
        "
      />
    </label>
  </div>
</template>
