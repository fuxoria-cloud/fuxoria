/* 发送边界的失败分类：未接受可按策略重试，结果未知必须人工核对。调用：throw new DeliveryError('机构未接受',false,true)。 */
export class DeliveryError extends Error {
    constructor(message: string, readonly uncertain: boolean, readonly retryable = false) { super(message); }
}
