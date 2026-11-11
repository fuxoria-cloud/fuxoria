<!-- 自定义字段控件：资料和工单复用真实KIMA，字段定义来自服务端。调用：<CustomFields v-model="values" :definitions="fields" />。 -->
<script setup lang="ts">
import { KimaCheckbox, KimaNumberField } from '@kernel4632/kima';
import type { CustomField, FieldValues } from '~/features/fields';
const props = withDefaults(defineProps<{
    definitions: CustomField[];
    disabled?: boolean;
}>(), { disabled: false });
const values = defineModel<FieldValues>({ required: true });
function change(key: string, value: string | number | boolean) { values.value = { ...values.value, [key]: value }; }
watch(() => props.definitions, fields => { const next = { ...values.value }; for (const field of fields)
    if (!Object.hasOwn(next, field.key) && field.editable !== false)
        next[field.key] = field.kind === 'number' ? field.minimum : field.kind === 'boolean' ? false : ''; values.value = next; }, { immediate: true });
</script>
<template>
  <div v-if="definitions.length" class="grid grid-cols-1 gap-5">
    <div v-for="field in definitions" :key="field.id" class="grid grid-cols-1 gap-2 min-w-0">
      <span v-if="field.kind!=='boolean'" class="form-label">
        {{ field.name }}
        <span v-if="field.required"> *</span>
      </span>
      <KimaCheckbox
        v-if="field.kind==='boolean'"
        :model-value="values[field.key]===true"
        :label="field.name+(field.required?' *':'')"
        :disabled="disabled || field.editable===false"
        :required="field.required"
        @update:model-value="(value:boolean)=>change(field.key,value)"
      />
      <KimaSelect
        v-else-if="field.kind==='select'"
        :model-value="String(values[field.key] ?? '')"
        :label="field.name"
        :items="[{value:'',label:'请选择'},...field.options]"
        :disabled="disabled || field.editable===false"
        :required="field.required"
        @update:model-value="(value:string)=>change(field.key,value)"
      />
      <KimaNumberField
        v-else-if="field.kind==='number'"
        :model-value="Number(values[field.key] ?? field.minimum)"
        :label="field.name"
        :min="field.minimum"
        :max="field.maximum"
        :disabled="disabled || field.editable===false"
        :required="field.required"
        @update:model-value="(value:number)=>change(field.key,value)"
      />
      <KimaTextarea
        v-else-if="field.kind==='textarea'"
        :model-value="String(values[field.key] ?? '')"
        :label="field.name"
        :minlength="field.minimum"
        :maxlength="field.maximum"
        :required="field.required"
        :disabled="disabled || field.editable===false"
        @update:model-value="(value:string)=>change(field.key,value)"
      />
      <KimaTextField
        v-else
        :model-value="String(values[field.key] ?? '')"
        :label="field.name"
        :type="field.kind==='date'?'date':field.format==='email'?'email':field.format==='url'?'url':'text'"
        :minlength="field.minimum"
        :maxlength="field.maximum"
        :required="field.required"
        :disabled="disabled || field.editable===false"
        @update:model-value="(value:string)=>change(field.key,value)"
      />
      <p v-if="field.description" class="form-hint whitespace-pre-wrap break-words">{{ field.description }}</p>
      <p v-if="field.editable===false" class="form-hint">这项资料由支持团队维护。</p>
    </div>
  </div>
</template>
