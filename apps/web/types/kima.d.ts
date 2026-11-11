/* KIMA 0.12.3 是 JavaScript 包；这里声明实际消费的组件边界，不改动外部库源码。 */
declare module '@kernel4632/kima' {
  // Vue组件类型由运行时属性控制
  import type { DefineComponent, SlotsType } from 'vue'; // 保留宿主Vue运行时的组件类型
  type KimaVueComponent = DefineComponent<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    SlotsType<Record<string, (...args: any[]) => any>>
  >; // JS库的具名插槽不由TS包提供
  export const KimaButton: KimaVueComponent;
  export const KimaIconButton: KimaVueComponent;
  export const KimaIcon: KimaVueComponent;
  export const KimaLink: KimaVueComponent;
  export const KimaCard: KimaVueComponent;
  export const KimaTextField: KimaVueComponent;
  export const KimaTextarea: KimaVueComponent;
  export const KimaSelect: KimaVueComponent;
  export const KimaTable: KimaVueComponent;
  export const KimaRadioGroup: KimaVueComponent;
  export const KimaDrawer: KimaVueComponent;
  export const KimaTabs: KimaVueComponent;
  export const KimaChip: KimaVueComponent;
  export const KimaAlert: KimaVueComponent;
  export const KimaAlertDialog: KimaVueComponent;
  export const KimaEmptyState: KimaVueComponent;
  export const KimaSkeleton: KimaVueComponent;
  export const KimaQrCode: KimaVueComponent;
  export const KimaCollapsible: KimaVueComponent;
  export const KimaCheckbox: KimaVueComponent;
  export const KimaNumberField: KimaVueComponent;
  export const KimaFileUpload: KimaVueComponent;
}
declare module '@kernel4632/kima/theme' {
  // 只声明官方公开的主题入口
  export function applyPalette(
    seed: string,
    options?: { isDark?: boolean; target?: HTMLElement; variant?: string },
  ): Record<string, string>;
  export function generatePalette(
    seed: string,
    options?: { isDark?: boolean; variant?: string },
  ): Record<string, string>;
  export function resetPalette(target?: HTMLElement): void;
}
