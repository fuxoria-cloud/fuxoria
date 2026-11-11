/* 自定义字段的界面合同。调用：<CustomFields v-model="values" :definitions="definitions" />。 */
export type FieldValues = Record<string, string | number | boolean | null>;
export interface CustomField {
    id: string;
    scope: 'profile' | 'ticket';
    key: string;
    name: string;
    description: string;
    kind: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'date';
    format: string;
    options: {
        value: string;
        label: string;
    }[];
    required: boolean;
    access: 'customer' | 'staff' | 'admin';
    customerEditable: boolean;
    editable?: boolean;
    minimum: number;
    maximum: number;
    departmentId: string | null;
    position: number;
    active: boolean;
}
export interface FieldData {
    definitions: CustomField[];
    values: FieldValues;
    revision: number;
}
export function editableFields(data: FieldData) { return Object.fromEntries(data.definitions.filter(field => field.editable !== false).map(field => [field.key, data.values[field.key] ?? null])); }
