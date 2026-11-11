# 狐岚云品牌与现有部署

对外名称为「狐岚云 · Fuxoria Cloud」，代码包使用 `@fuxoria`，Go模块为 `github.com/fuxoria-cloud/fuxoria/agent`。域名和仓库名称不改变账单、资金、审计或已交付资源的归属。

本次更名在用户确认商标没有冲突后执行。项目进行的公开索引检索未发现确切同名记录，未取得官方近似查询结果；用户确认与公开索引初筛不替代官方商标核验或注册结论。

已有部署继续读取原数据库连接和数据目录。Cookie名称、Redis会话格式、验证码摘要前缀、密文附加认证数据、导出格式及静态发布清单的文件名保留原值。直接替换这些标识会让已有登录、加密资料或失败发布恢复失效。

| 保留项 | 用途 |
| --- | --- |
| `yunzou_session`、`yunzou_oauth_browser`、`yunzou_oauth_result` | 会话和第三方登录的一次性票据 |
| `yunzou_referral`、`yunzou_theme`、`yunzou:cart-checkout:*` | 推荐归因、主题选择与购物车重试意图 |
| `yunzou:totp:v1:*`、`yunzou-resource:v1:*` | 已保存认证器及资源凭据的AES-GCM用途绑定 |
| `yunzou-verification:*`、`yunzou-access:*` | 仍在有效期内的验证码摘要 |
| `yunzou-zjmf-1` | 已导出的旧系统数据快照格式 |
| `.yunzou-content-*`、`.yunzou-static-pending.json` | 差异发布基线和可恢复的失效意图 |
| `/var/lib/yunzou`、`~/.local/share/yunzou/`、Compose数据库连接 | 已部署的数据卷与私有文件 |
| `YUNZOU_TEST_DATABASE_URL`、`YUNZOU_TEST_DIAGNOSTICS` | 既有验收命令的明确环境入口 |

正式迁移文件保持原始内容与摘要。品牌更名不改历史审计、账单快照、导入记录或原始生图提示词。旧的PNG路径可在过渡期继续作为同一素材的兼容别名；新页面引用 `fuxoria-logo.png` 和 `fuxoria-mascot.png`。
