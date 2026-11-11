# 实名资料与人工核验

客户在 `/console/identity` 提交个人或企业资料，上传 PNG、JPEG 或 PDF 证明。每份材料最多 5MiB，每次申请最多六份。提交与撤回需要当前密码，已开启双因素时同时核对验证码或恢复码。

资料默认只显示遮盖后的名称与证件号码。证件正文和材料使用独立 `CERTIFICATION_KEY` 做 AES-256-GCM 加密，认证数据绑定申请 ID 和文件 ID。文件写入源码目录以外的 `CERTIFICATION_STORAGE_DIR`，目录权限为 `0700`，文件权限为 `0600`。Compose 使用 `/var/lib/yunzou/certifications` 持久卷路径。密钥应与数据备份分别保管；更换密钥前需要先迁移现有密文。

管理员在 `/admin/verification` 筛选申请，填写查看用途并通过本人密码与双因素后读取原文。每次原文访问和材料下载都会追加审计。下载前同时验证 GCM 认证标签、原始长度和 SHA-256，响应使用附件下载与 `private, no-store`。

人工核验需填写实际核对说明与凭据来源，确认已经查看材料，再记录通过或拒绝。通过时必须存在私有证明材料，结论明确标注为“人工审核通过”。数据库保留原始申请和材料，禁止覆盖终态。个人认证转企业时创建新申请并关联前次记录，原个人结论继续保留。

`apps/api/src/verification-plugins/` 保存核验渠道，一个文件一个渠道。随包的 `manual.ts` 提供个人与企业人工审核。外部机构返回的认证结论应由对应渠道验证并记录其真实来源。

配置 `CERTIFICATION_KEY` 为独立随机 64 位十六进制值，并设置私有存储路径。项目安装与 `scripts/keys.ts` 会生成缺少的独立密钥；未配置密钥时，申请入口保持关闭。

```sh
node --env-file=.env --import tsx --test apps/api/tests/identity-provider.integration.test.ts
```

测试使用合成身份、随机 PostgreSQL 数据库和临时文件目录，核对密文、遮盖、越权拒绝、材料访问审计、重复决策与个人转企业历史。邮箱和手机号的验证换绑另见 `verification.ts` 与 `apps/api/tests/verification.integration.test.ts`。
