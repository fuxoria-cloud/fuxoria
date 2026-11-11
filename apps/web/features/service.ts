/* 服务的显示与续费规则：桌面表格和手机卡片共用。调用：canRenewService(service)。 */
import type { Service } from "~/types/api"; // 规则只依赖服务端真实资源事实

export const serviceActionNames = {
  resource: "资源操作",
  provision: "开通服务",
  upgrade: "更改方案与配置",
  renew: "续费",
  suspend: "暂停服务",
  resume: "恢复服务",
  terminate: "终止服务",
}; // 在途动作始终与实际运行状态分开

/** @param service 当前服务。@returns 是否可以在界面发起新的续费。 */
export function canRenewService(service: Service) {
  return (
    ["active", "suspended"].includes(service.status) &&
    !service.terminationRequestedAt &&
    !service.operation &&
    !["onetime", "ontrial"].includes(service.billingPeriod || "month") &&
    (service.billingMonths !== 0 || !!service.billingSeconds)
  ); // 等在途动作结束且没有终止意图后才给新入口
}

/** @param service 当前合同。@returns 无需计算价格的周期文字。 */
export function servicePeriod(service: Service) {
  return {
    hour: "时付",
    day: "日付",
    ontrial: "试用",
    month: "月付",
    quarter: "季付",
    halfyear: "半年付",
    year: "年付",
    biennium: "两年付",
    triennium: "三年付",
    onetime: "一次性",
  }[service.billingPeriod ?? "month"]; // 未迁移老资源默认月付
}
