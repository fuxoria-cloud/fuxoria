/* 人工资料核验：明确需要管理员查看材料并记录核验凭据，不调用或冒充外部实名认证。
 * 调用：certification.ts 启动扫描本目录；文件即渠道。
 */
export default {id:'manual',name:'人工资料核验',kinds:['personal','enterprise'],mode:'manual'} as const;
