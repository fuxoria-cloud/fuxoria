/* 支持中心的浏览器字段。调用：import type { SupportTicket } from '~/features/support'。 */
import type { Ticket, Reply } from '~/types/api'; // 旧工单合同只补字段，不改变既有响应
export interface SupportFile {
    id: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    replyId?: string | null;
    internal?: boolean;
}
export interface SupportTicket extends Ticket {
    customFields?:import('./fields').FieldData;
    userId: string;
    departmentId: string | null;
    departmentName: string | null;
    assignedTo: string | null;
    assigneeName: string | null;
    serviceId: string | null;
    serviceName: string | null;
    mergedInto: string | null;
    rating: number | null;
    ratingComment: string | null;
    replies?: (Reply & {
        internal?: boolean;
        userId?: string;
    })[];
    attachments?: SupportFile[];
}
export interface Department {
    id: string;
    name: string;
    description: string;
    active?: boolean;
    position?: number;
    members?: {
        id: string;
        name: string;
        email: string | null;
    }[];
}
export interface SupportAgent {
    id: string;
    name: string;
    email: string | null;
    role: string;
}
export interface ReplyTemplate {
    id: string;
    title: string;
    message: string;
    categoryId: string | null;
    categoryName?: string;
}
export interface ContentCategory {
    id: string;
    name: string;
    kind: string;
    parentId: string | null;
    position: number;
}
export interface DownloadItem {
    id: string;
    fileId: string;
    title: string;
    description: string;
    categoryId: string | null;
    categoryName?: string;
    productId: string | null;
    access: 'public' | 'account' | 'service';
    published: boolean;
    name: string;
    sizeBytes: number;
    mediaType: string;
}
export interface Notice {
    id: string;
    title: string;
    message: string;
    link: string | null;
    readAt: string | null;
    createdAt: string;
}
