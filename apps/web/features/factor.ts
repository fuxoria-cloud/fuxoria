/* 第二因素：验证码或一次性恢复码二选一，所有安全动作共用同一请求形状。
 * 调用：factorProof({mode:'totp',code:'123456'})返回{totp:'123456'}；空输入返回{}。
 */
export interface FactorInput {
  mode: 'totp' | 'recovery';
  code: string;
} // 表单只保留当前选中的证明

/** @param input 当前证明方式与输入。@returns API允许的一种证明字段。 */
export function factorProof(input: FactorInput): { totp?: string; recoveryCode?: string } {
  // 不让一次请求同时携带两种第二因素
  const code = input.code.trim(); // 外部输入先去掉首尾空格
  if (!code) return {}; // 未开启MFA的账号不提交空验证字段
  return input.mode === 'totp' ? { totp: code } : { recoveryCode: code }; // 服务端最终校验并防重放
}
