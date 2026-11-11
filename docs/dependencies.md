# 依赖与运行边界

2026年11月10日执行 `npm audit --json`。完整结果保存在 `artifacts/dependency-audit.json`：高危和严重级别均为0，中等9项、低危2项。这是依赖公告匹配结果，不等同于业务代码审计或零漏洞证明。

项目按指定版本使用 Nuxt 3.21.11。Nuxt 官方已将3.x列为结束维护；下列公告的框架补丁发布在4.x，应用当前的配置约束与上游补丁是两件事。[Nuxt 官方公告](https://github.com/nuxt/nuxt/security/advisories/GHSA-xfq5-w38q-pc2x)

| 公告 | 当前应用的入口约束 |
| --- | --- |
| 服务端规则对大小写路径匹配不一致 | 独立 `server/middleware/privacy.ts` 解码并识别所有私有前缀，对大小写和编码别名直接返回404/no-store；实际业务权限由Nest会话与角色检查，不依赖Nuxt规则 |
| 开发服务器可返回包含私有配置的开发包 | `dev`仅监听127.0.0.1；正式运行 `.output/server/index.mjs`；Nuxt运行配置不放数据库、支付和审计密钥 |
| 服务端岛的安全head输入序列化 | 显式关闭 `experimental.componentIslands`，项目没有 `.server.vue` 与 `NuxtIsland` 入口 |
| 关闭pages时特殊协议链接检查不完整 | 显式 `pages:true`，使用vue-router；页面导航使用受控站内路径 |

以上入口条件分别对照 [路径规则公告](https://github.com/nuxt/nuxt/security/advisories/GHSA-vjh5-4x84-xrqp)、[开发包公告](https://github.com/nuxt/nuxt/security/advisories/GHSA-648h-gw55-m2g7)、[服务端岛公告](https://github.com/nuxt/nuxt/security/advisories/GHSA-xfq5-w38q-pc2x) 和 [链接公告](https://github.com/nuxt/nuxt/security/advisories/GHSA-jjm6-p2m9-9w4x)。它们说明当前使用范围，不把受影响的依赖版本写成已经获得框架补丁。

其余公告涉及构建链中的deepmerge、glob、minimatch及引入它们的打包依赖。HTTP入口不接受用户提交的构建配置、glob表达式或文件树；发布操作只处理部署方提供的构建目录。更新依赖时同时核对锁文件、构建产物与本项目的路径、代理和缓存回归，不能只看依赖审计的总数。

支付、数据库和审计密钥只由服务端环境提供。KIMA、字体与图标的来源和许可见 [视觉系统](design.md)；资金、会话、回调与发布的实际测试见 [验证记录](verification.md)。
