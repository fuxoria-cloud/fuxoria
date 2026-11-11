/* 币种公共元数据：渲染前恢复最小单位与币符，不接触用户余额或会话内容。 */
import { registerCurrencies,type CurrencyMetadata } from '~/features/money';
export default defineNuxtPlugin(async () => {
 const api=useApi();
 const definitions=useState<CurrencyMetadata[]|null>('currency-definitions',()=>null);
 if(import.meta.client||!definitions.value){try{definitions.value=await api<CurrencyMetadata[]>('/currencies');}catch{definitions.value=[{code:'CNY',symbol:'¥',decimals:2}];}}
 registerCurrencies(definitions.value);
});
