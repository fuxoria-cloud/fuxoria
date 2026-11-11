# 狐岚云

默认使用简体中文，交流遵循用户提供的星绒人格。技术说明直接、准确；进度和验收以实际运行证据为准。

编程遵循 `reference/skills/HOP.md`。主体在 `apps/api/src/features/` 平铺，一个主体的HTTP入口和业务操作放在同一个文件。数据连接在 `store.ts`，跨主体小工具在 `utils/`。新增主体默认导出带NestJS装饰器的入口类，启动时自动发现，不维护中央登记清单。

前端在 `apps/web/`，使用Nuxt 3、Vue 3、TypeScript、Tailwind和真实KIMA组件。KIMA来自 `@kernel4632/kima`，安装版本由锁文件固定。安装后可查看 `node_modules/@kernel4632/kima/`；需要上游参考时，可从 `https://github.com/kernel4632/kima` 检出到 `reference/kima/`。该目录只作本地对照，不纳入版本控制，不在其中开发或向上游推送。页面颜色使用KIMA变量，主题通过其官方配色入口生成。Logo和云狐在 `apps/web/public/brand/`，均为本项目生成素材。

支付协议在 `packages/payments/plugins/`，一个文件一个渠道，启动扫描发现。修改源码后先构建支付包，API消费其 `dist`。外部协议校验发生在支付边界，入账统一经过 `settlement.ts`。金额以整数分字符串传输，用BigInt计算；不得用浮点修改资金。

数据库迁移在 `database/migrations/`，已执行文件不能修改，新增结构通过新迁移表达。资金分录、收款凭据和审计只追加。资金动作、审计与开通任务须在同一事务提交。用户自己的数据放PostgreSQL和部署卷，不能写进代码目录。

开通进程在 `agent/`。PostgreSQL队列是持久事实，Redis只负责会话、限流和缓存。同一服务的任务串行，结果提交检查租约令牌；供应商操作需要稳定幂等键。外部插件以受控可执行文件运行，不能拼接shell命令。人工服务须有管理员明确交付事实。

运行检查：`npm test`、`npm run build`、`npm run test:integration`；Go使用 `go test -race ./...` 和 `go vet ./...`。浏览器实测桌面和390px手机宽度，截图保存 `artifacts/`。文档按humanizer要求编辑，只记录可核对事实、操作说明和必要约束。

原项目证据在 `reference/inventory.json`，版本10.4.6、固定提交 `cf3b2d0d7586ec482f064f4e99259c062c89043c`。原始源码可从 `https://github.com/idcsmart/ZJMF-CBAP` 按该固定提交检出到 `reference/ZJMF-CBAP/`，作为不纳入版本控制的本地对照，不原地覆盖。沿用AGPL-3.0许可证，KIMA的MIT授权另行保留。
