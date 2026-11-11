<!-- 币种管理：明确最小单位、有理数汇率与批量换价范围；历史成交和账本不重写。 -->
<script setup lang="ts">
import { KimaCheckbox,KimaNumberField } from '@kernel4632/kima';
import { registerCurrencies } from '~/features/money';
import type { Product } from '~/types/api';
definePageMeta({layout:'console',middleware:['account','admin']});
useSeoMeta({title:'币种与换价',robots:'noindex, nofollow'});
type Currency={code:string;name:string;symbol:string;decimals:number;rateNumerator:string;rateDenominator:string;active:boolean;isDefault:boolean};
const api=useApi();
const {data,pending,error,refresh}=await useAsyncData('admin-currencies',()=>api<{currencies:Currency[];rates:{id:string;currency:string;numerator:string;denominator:string;createdAt:string}[]}>('/admin/currencies'));
const {data:products,refresh:refreshProducts}=await useAsyncData('currency-products',()=>api<Product[]>('/admin/products'));
const editing=ref(''),busy=ref(false),failure=ref(''),saved=ref(''),selected=ref<string[]>([]),target=ref('CNY'),accepted=ref(false);
const form=reactive<Currency>({code:'',name:'',symbol:'',decimals:2,rateNumerator:'1',rateDenominator:'1',active:true,isDefault:false});
function edit(item?:Currency){editing.value=item?.code||'';Object.assign(form,item||{code:'',name:'',symbol:'',decimals:2,rateNumerator:'1',rateDenominator:'1',active:true,isDefault:false});failure.value='';saved.value='';}
async function save(){busy.value=true;failure.value='';saved.value='';try{const {code,...body}=form;await api(`/admin/currencies${editing.value?'/'+editing.value:''}`,{method:editing.value?'PUT':'POST',body:editing.value?body:form});await refresh();registerCurrencies(data.value!.currencies);saved.value='币种定义已保存。汇率用于之后的换价，旧合同和余额保持原币种。';}catch(reason){failure.value=apiMessage(reason);}finally{busy.value=false;}}
function toggle(id:string,on:boolean){selected.value=on?[...selected.value,id]:selected.value.filter(item=>item!==id);accepted.value=false;}
async function reprice(){busy.value=true;failure.value='';saved.value='';try{const result=await api<{products:unknown[]}>('/admin/currencies/reprice',{method:'POST',body:{productIds:selected.value,targetCurrency:target.value}});await refreshProducts();saved.value=`已为 ${result.products.length} 个商品按当前汇率换价，下一笔新订单使用新的报价。`;selected.value=[];accepted.value=false;}catch(reason){failure.value=apiMessage(reason);}finally{busy.value=false;}}
</script>
<template>
 <div>
  <AppLink to="/admin" class="auth-back mb-6">返回管理后台</AppLink>
  <header class="page-heading"><div><h1>币种与换价</h1><p>按币种分别记账。人民币为汇率锚点，各币种余额与额度互不抵扣。</p></div></header>
  <KimaAlert v-if="failure" variant="danger" class="mb-5">{{ failure }}</KimaAlert><KimaAlert v-if="saved" variant="success" class="mb-5">{{ saved }}</KimaAlert><RequestState :pending="pending" :error="error" @retry="refresh" />
  <div v-if="data" class="grid gap-6">
   <section class="panel p-5 sm:p-7 grid gap-4"><div class="flex justify-between flex-wrap gap-3"><h2 class="text-xl font-semibold">已定义币种</h2><KimaButton variant="tonal" @click="edit()">新增币种</KimaButton></div>
    <article v-for="item in data.currencies" :key="item.code" class="border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4" style="border-color:var(--kima-color-outline-variant)"><div><h3 class="font-semibold">{{ item.symbol }} {{ item.name }} · {{ item.code }}</h3><p class="form-hint mt-2">小数 {{ item.decimals }} 位 · 1 {{ item.code }} = {{ item.rateNumerator }}/{{ item.rateDenominator }} CNY</p></div><div class="flex flex-wrap items-center gap-3"><KimaChip>{{ item.isDefault?'默认币种':item.active?'已启用':'已停用新报价' }}</KimaChip><KimaButton variant="tonal" @click="edit(item)">编辑 {{ item.code }}</KimaButton></div></article>
   </section>
   <section class="panel p-5 sm:p-7"><h2 class="text-xl font-semibold">{{ editing?'编辑币种':'新增币种' }}</h2>
    <form class="grid min-w-0 gap-5 mt-5 sm:grid-cols-2" @submit.prevent="save"><div class="grid min-w-0 gap-2"><span class="form-label">三位大写币种代码</span><KimaTextField v-model="form.code" label="三位大写币种代码" pattern="[A-Z]{3}" maxlength="3" required :disabled="!!editing" class="w-full min-w-0 max-w-full" /></div><div class="grid min-w-0 gap-2"><span class="form-label">币种名称</span><KimaTextField v-model="form.name" label="币种名称" maxlength="80" required class="w-full min-w-0 max-w-full" /></div><div class="grid min-w-0 gap-2"><span class="form-label">显示币符</span><KimaTextField v-model="form.symbol" label="显示币符" maxlength="12" required class="w-full min-w-0 max-w-full" /></div><div class="grid gap-2"><span>最小单位的小数位</span><KimaNumberField v-model="form.decimals" label="币种小数位" :min="0" :max="8" :disabled="!!editing" /></div><div class="grid min-w-0 gap-2"><span class="form-label">兑换CNY汇率的分子</span><KimaTextField v-model="form.rateNumerator" label="兑换CNY汇率的分子" inputmode="numeric" pattern="[1-9][0-9]{0,11}" required :disabled="form.code==='CNY'" class="w-full min-w-0 max-w-full" /></div><div class="grid min-w-0 gap-2"><span class="form-label">兑换CNY汇率的分母</span><KimaTextField v-model="form.rateDenominator" label="兑换CNY汇率的分母" inputmode="numeric" pattern="[1-9][0-9]{0,11}" required :disabled="form.code==='CNY'" class="w-full min-w-0 max-w-full" /></div><KimaCheckbox v-model="form.active" label="开放新报价" /><KimaCheckbox v-model="form.isDefault" label="设为默认展示币种" /><p class="form-hint sm:col-span-2">代码和小数位创建后固定，确保历史金额含义一致。默认四个支付渠道仅支持CNY；外币账单可以用同币种已有余额或授信结算。停用新报价会保留旧合同与还款通道。</p><KimaButton type="submit" :loading="busy">保存币种定义</KimaButton></form>
   </section>
   <section class="panel p-5 sm:p-7 grid gap-5"><h2 class="text-xl font-semibold">按汇率转换商品报价</h2><KimaAlert>此操作同时转换商品基础价、所有周期、资源附加价、安装费与客户专属价。使用当前精确分数汇率，向上取目标币种最小单位。既有服务、订单、优惠码金额和资金记录保持原快照。</KimaAlert><div class="grid min-w-0 gap-2"><span class="form-label">换价后的币种</span><KimaSelect v-model="target" label="换价后的币种" :items="data.currencies.filter(item=>item.active).map(item=>({value:item.code,label:`${item.name}（${item.code}）`}))" :disabled="busy" /></div><div class="grid gap-3"><KimaCheckbox v-for="item in products||[]" :key="item.id" :model-value="selected.includes(item.id)" :label="`${item.name} · ${money(item.priceCents,item.currency,item.currencyDecimals)}`" :disabled="busy||item.currency===target" @update:model-value="toggle(item.id,$event)" /></div><KimaCheckbox v-model="accepted" label="我已核对商品范围与目标币种，按当前汇率换算新报价" :disabled="!selected.length||busy" /><KimaButton :disabled="!selected.length||!accepted||busy" :loading="busy" @click="reprice">确认转换 {{ selected.length }} 个商品</KimaButton></section>
   <section class="panel p-5 sm:p-7"><h2 class="text-xl font-semibold mb-5">汇率记录</h2><p v-if="!data.rates.length" class="muted">新增与调整的汇率会在这里保留。</p><article v-for="item in data.rates" :key="item.id" class="py-3 border-t" style="border-color:var(--kima-color-outline-variant)"><p>{{ item.currency }} · {{ item.numerator }}/{{ item.denominator }} CNY</p><p class="form-hint">{{ date(item.createdAt) }}</p></article></section>
  </div>
 </div>
</template>
