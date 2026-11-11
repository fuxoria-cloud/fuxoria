/*
金额：用户以元填写，API以分传输；计算全程用BigInt，不经过浮点数。
调用：toCents('29.00') === '2900'；money('2900') === '¥29.00'；amount('2900') === '29.00'。
*/

/** @param text 用户填写的元金额。@param allowZero 免费商品可显式允许0，默认禁止。@returns 整数分字符串，错误时给出可直接展示的原因。 */
export type CurrencyMetadata={code:string;symbol:string;decimals:number};
const currencies = new Map<string,CurrencyMetadata>();
const standardCurrencies=new Set(Intl.supportedValuesOf('currency'));
function knownCurrency(code:string){return currencies.has(code)||standardCurrencies.has(code);}
export function registerCurrencies(rows:CurrencyMetadata[]){for(const row of rows)if(/^[A-Z]{3}$/.test(row.code)&&Number.isInteger(row.decimals)&&row.decimals>=0&&row.decimals<=8)currencies.set(row.code,row);}
export function currencyDecimals(code:string){return digitsFor(code);}
export function currencySymbol(code:string){return currencies.get(code)?.symbol || (code==='CNY'?'¥':new Intl.NumberFormat('zh-CN',{style:'currency',currency:code}).formatToParts(0).find(part=>part.type==='currency')?.value||code);}
function digitsFor(currency: string, decimals?: number): number {
  if(decimals===undefined&&!knownCurrency(currency))throw new Error('币种精度尚未加载，请刷新后重试。');
  const digits = decimals ?? currencies.get(currency)?.decimals ?? new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  if (!Number.isInteger(digits) || digits < 0 || digits > 8) throw new Error('币种小数位需要在0至8之间。');
  return digits;
}

export function toCents(text: string, allowZero = false, currency = 'CNY', decimals?: number): string {
  // 表单边界统一验证金额格式
  const digits = digitsFor(currency, decimals);
  const matched = new RegExp(`^(\\d{1,${12 - digits}})${digits ? `(?:\\.(\\d{1,${digits}}))?` : ''}$`).exec(text.trim());
  if (!matched) throw new Error(digits === 2 ? '请输入有效金额，最多保留两位小数。' : digits ? `请输入有效金额，最多保留${digits}位小数。` : '这个币种使用整数金额。');
  const cents = BigInt(matched[1]!) * 10n ** BigInt(digits) + BigInt((matched[2] || '').padEnd(digits, '0') || '0'); // 按最小单位解析，避免浮点
  if (cents === 0n && !allowZero) throw new Error(currency === 'CNY' ? '金额需要大于0元。' : '金额需要大于0。');
  if (cents > 999999999999n) throw new Error('金额超过可支持的范围。'); // 与API最大12位整数分保持一致
  return cents.toString(); // 前端与API不传浮点金额
}

/** @param cents 十进制分金额。@returns 元金额的纯数字文本，适合编辑表单。 */
export function amount(cents: string, currency = 'CNY', decimals?: number): string {
  // 只处理内部已经验证的账本金额
  const value = BigInt(cents); // 无论金额大小都保留每一分
  const absolute = value < 0n ? -value : value; // 负余额或退款保留原符号
  const digits = digitsFor(currency, decimals), scale = 10n ** BigInt(digits);
  return `${value < 0n ? '-' : ''}${absolute / scale}${digits ? '.' + String(absolute % scale).padStart(digits, '0') : ''}`;
}

/** @param cents 十进制分金额。@returns 人民币展示，金额计算仍只在服务器进行。 */
export function money(cents: string | number, currency = 'CNY', decimals?: number): string {
  // 页面只展示服务端返回的金额
  if(decimals===undefined&&!knownCurrency(currency))return `${BigInt(cents).toLocaleString('zh-CN')} ${currency}（最小单位）`;
  const value = BigInt(cents); // 大金额也保留完整的分
  const absolute = value < 0n ? -value : value; // 符号和数字分开排版
  const formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency });
  const precision = digitsFor(currency, decimals);
  const scale = 10n ** BigInt(precision);
  const symbol = currencySymbol(currency);
  const fraction = precision ? `.${String(absolute % scale).padStart(precision, '0')}` : '';
  return `${value < 0n ? '-' : ''}${symbol}${(absolute / scale).toLocaleString('zh-CN')}${fraction}${currency === 'CNY' ? '' : ' ' + currency}`; // 非人民币保留明确币种，大金额仍由BigInt分拆
}
