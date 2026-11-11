<!-- 商品选项：只显示服务端当前允许的字段和范围，购买与升降级共用真实KIMA控件。 -->
<script setup lang="ts">
import { KimaNumberField, KimaCheckbox } from '@kernel4632/kima';
import type { ProductOption, ProductConfiguration } from '~/types/api';
defineProps<{ options: ProductOption[]; disabled?: boolean }>();
const configuration = defineModel<ProductConfiguration>({ required: true });
</script>
<template>
  <div v-for="option in options.filter(option => !option.hidden)" :key="option.key" class="grid grid-cols-1 gap-2">
    <span v-if="option.kind !== 'boolean'" class="font-medium">{{ option.name }}</span>
    <KimaSelect v-if="option.kind === 'select'" v-model="configuration[option.key]" :label="option.name" :items="[...(option.required ? [] : [{ value: '', label: '不需要' }]), ...option.choices.map(choice => ({ value: choice.value, label: choice.label }))]" :disabled="disabled" />
    <KimaNumberField v-else-if="option.kind === 'quantity'" :model-value="Number(configuration[option.key])" :label="option.name" :min="option.minimum" :max="option.maximum" :disabled="disabled || option.minimum === option.maximum" @update:model-value="configuration[option.key] = $event" />
    <KimaCheckbox v-else :model-value="configuration[option.key] === true" :label="option.name" :disabled="disabled || option.allowedValues?.length === 1" @update:model-value="configuration[option.key] = $event" />
    <span v-if="option.kind === 'quantity'" class="form-hint">可选 {{ option.minimum }} 至 {{ option.maximum }}</span>
  </div>
</template>
