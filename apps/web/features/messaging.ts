/* 消息模板与队列的界面合同，状态来自持久发送任务。调用：import type { MessageJob } from '~/features/messaging'。 */
export interface MessageTemplate {
    id: string;
    name: string;
    channel: 'site' | 'email' | 'sms';
    category: 'transactional' | 'marketing';
    scope: 'account' | 'service';
    subject: string;
    body: string;
    link: string | null;
    active: boolean;
}
export interface MessageBatch {
    id: string;
    name: string;
    channel: string;
    category: string;
    total: number;
    sent: number;
    uncertain: number;
    pending: number;
    createdAt: string;
}
export interface MessageJob {
    id: string;
    batchId: string | null;
    channel: string;
    category: string;
    subject: string;
    state: string;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    runAt: string;
    sentAt: string | null;
    createdAt: string;
    name: string;
    email: string | null;
    phone: string;
}
export interface CareRule {
    id: string;
    name: string;
    templateId: string;
    trigger: string;
    days: number;
    productIds: string[];
    active: boolean;
    templateName: string;
    channel: string;
    lastCheckedAt: string | null;
}
export const messageStates: Record<string, string> = { queued: '等待发送', running: '正在提交', sent: '机构已接受／站内已入站', failed: '明确失败', uncertain: '结果待核对', skipped: '已按规则跳过', cancelled: '已取消' };
export const careTriggers = [{ value: 'registered_days', label: '注册满指定天数' }, { value: 'inactive_days', label: '连续未登录指定天数' }, { value: 'service_created_days', label: '服务创建后指定天数' }, { value: 'service_due_days', label: '服务到期前指定天数' }, { value: 'service_overdue_days', label: '服务过期后指定天数' }];
