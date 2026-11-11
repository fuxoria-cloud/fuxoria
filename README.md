# 狐岚云 Fuxoria Cloud

狐岚云把云产品订购、服务交付、续费、账单与支持放在一个工作台里。前端使用 Nuxt 3、Vue 3、TypeScript、Tailwind 和 KIMA，业务 API 使用 NestJS，资源任务由 Go 进程执行。PostgreSQL 保存业务与资金事实，Redis 保存会话和限流数据。

3.7.6 的业务扩展包含条件选配、客户专属价、十种计费周期、多币种、优惠码、客户组、联系人与子账号、员工权限、开发者密钥、工单与附件、下载、消息与关怀、合同与开票红冲、服务取消与转移、批量和自动续费、升降级、充值与信用账期、推荐佣金、员工销售、经营报表、实名核验、邮箱与手机验证、找回密码、微信和第三方登录，以及资源控制与客户活动。原版依据与新入口见 [3.7.6业务说明](docs/v376-migration.md)，源码清单保存在 `reference/zjmfv376-inventory.json`。

旧部署的会话、密文与数据目录兼容说明见 [品牌与升级](docs/branding.md)。

## 启动

需要 Node.js 22.18 以上版本、PostgreSQL、Redis。开发 Go 进程需要 Go 1.26。

```bash
git clone https://github.com/fuxoria-cloud/fuxoria.git
cd fuxoria
npm install
npm run setup
```

`setup` 创建权限为 `600` 的 `.env`，为审计、认证器、实名资料、验证码、数据库、Redis和管理员分别生成随机凭据。已有 `.env` 时会停止，避免覆盖配置；升级已有部署时运行 `npm run keys:ensure`，只补缺少的独立密钥。先在文件里填写自己的连接地址和管理员邮箱；`PUBLIC_ORIGIN` 是浏览器访问狐岚云的完整来源，例如 `http://127.0.0.1:3300`，不带结尾斜杠。

```bash
npm run db:migrate
npm run bootstrap
npm run build --workspace=@fuxoria/payments
npm run dev:api
```

另开终端启动前端：

```bash
npm run dev
```

打开 `http://127.0.0.1:3300`，使用 `.env` 中的管理员邮箱与密码登录。在管理后台创建商品，再从产品目录订购。`manual` 商品由管理员交付：账单结清后，在开通任务中填写真实资源标识并确认交付。

Go 进程读取与 API 相同的 `DATABASE_URL` 和 `AUDIT_KEY`。在注入环境变量的终端中运行：

```bash
cd agent
go run . --plugins "$PWD/plugins"
```

插件清单、执行约束和任务恢复方式见 [开通进程](docs/agent.md)。

## Docker Compose

先运行 `npm run setup`，检查 `.env` 中的域名和管理员资料，再启动：

```bash
docker compose up --build -d
docker compose exec api node scripts/bootstrap.ts
```

浏览器入口为 `http://127.0.0.1:3300`。数据库与 Redis 使用独立卷保存数据，不向主机公开端口。工单附件、下载文件和加密实名材料保存在 `api-files` 卷，随数据库和原加密密钥一起备份。正式接入域名时，在反向代理终止 HTTPS，并把 `PUBLIC_ORIGIN` 改成该域名后重启 API。

Nuxt默认只使用真实连接地址。放到Nginx或CDN之后时，在 `NUXT_TRUST_PROXY_CIDRS` 中明确填写代理的CIDR，按可信链还原客户端IP；API的 `TRUST_PROXY_CIDRS` 只应包含Nuxt所在网络。两个入口都会覆盖或核对转发来源，浏览器自行填写的代理头不会直接成为限流身份。

## 支付和资金

微信、支付宝、易支付与虎皮椒分别在自己的插件文件中实现。商户配置由服务端环境提供，页面只能看到渠道是否可用。配置及各渠道的协议能力见 [支付说明](docs/payments.md)。

金额以整数分保存，以十进制字符串通过 API 传递。客户下单只提交商品与周期，价格来自数据库；同一提交标识只创建一张订单。支付通知通过签名、商户身份、金额和币种校验后，在同一事务中结清账单、追加借贷分录、记录审计并投递开通任务。浏览器跳转不改变付款状态。

充值记客户钱包负债，信用借用记应收款，还款冲销应收款。充值退款先预留可用余额；推荐佣金在实际收款、退款核对和等待期满足后释放。服务转移保留原订单与收款归属，升降级在真实任务完成后更新配置。[充值与信用说明](docs/credit-and-recharge.md)记录了操作方式和账务规则。

[推荐佣金](docs/v376-migration.md#联盟推荐与佣金)支持注册归因、等待期核对、转余额和提现预留。[合并支付](docs/v376-migration.md#合并支付)将多张未付业务账单交给同一收银台结清，保留原单和服务关系；开票与退款统一使用合并父单。

[员工销售与经营报表](docs/v376-migration.md#员工销售与经营报表)提供客户分工、商品组和同币种月业绩阶梯，并按实际实收与退款净额计提。报表分别展示现金、收入、钱包负债、应收款和资源任务趋势。

[资源控制与活动记录](docs/resource-modules.md)从在线受控插件发现状态、监控、自定义动作、短期控制台和凭据。输入与私有结果使用独立密钥加密，敏感操作需本人核验，活动页只展示自己的公开业务事件。

审计使用外置密钥签署的哈希链。`AUDIT_KEY` 需要与数据库分开备份，迁移时保留原值。资金与审计记录只允许追加，核验命令为：

```bash
npm run audit:verify
```

## 页面与缓存

首页和产品目录在构建时生成公共 HTML。价格和库存从 API 读取，账户页不进入公共静态输出。带指纹的前端资源允许长期缓存，登录、工作台、后台和私有 API 返回 `private, no-store`。

公告、帮助和独立文章按修订号差异发布，只重写内容变化的页面：

```bash
STATIC_OUTPUT=/srv/yunzou/public npm run publish:content
```

发布器生成 `invalidation.json`，其中的 `paths` 是本次实际变化的 URL，可交给 CDN 做按路径失效。将输出目录交给反向代理或静态托管服务即可直接提供 HTML。

构建产物也可以按内容摘要差异分发，未变化文件保持原样；旧的指纹资源保留供已打开的页面继续使用：

```bash
STATIC_OUTPUT=/srv/yunzou/public npm run publish:static
```

对应的变化清单为 `static-invalidation.json`。原始图片、JS和CSS只在内容变化时复制，文章发布与构建产物分发可使用同一个目标目录。

发布器先保存待刷新的路径，再修改文件，成功写入失效清单与发布基线后才清理临时日志。中途失败可以直接重跑；更换空目录、文件丢失或内容损坏都会重新核对生成。每次运行输出的变化清单应交给CDN处理后，再开始下一轮发布。

## 界面与素材

页面直接使用KIMA组件与青蓝色主题。手机上的服务、账单与购买明细逐条显示，付款和续费动作保留48px热区。下面是本机运行页面的截图：

| 页面 | 截图 |
|---|---|
| 首页 | [深色桌面](artifacts/kima-home-desktop.png)、[浅色桌面](artifacts/kima-home-light-desktop.png)、[手机](artifacts/kima-home-mobile.png) |
| 手机服务 | [状态与原账单入口](artifacts/kima-services-mobile.png) |
| 手机账单 | [购买明细](artifacts/kima-invoice-mobile.png) |
| 购物车 | [桌面](artifacts/kima-cart-desktop.png)、[手机](artifacts/kima-cart-mobile.png) |
| 商品条件与专属价 | [桌面](artifacts/v376-catalogue-admin-desktop.png)、[手机](artifacts/v376-catalogue-rules-mobile.png) |
| 多币种 | [币种与换价](artifacts/v376-currencies-mobile.png) |
| 销售与资源控制 | [销售管理](artifacts/v376-sales-browser-desktop.png)、[手机控制台](artifacts/v376-resource-overview-browser-mobile.png) |

Logo与云狐由内置生图工具生成，透明PNG保存在 `apps/web/public/brand/`。原始尺寸、用途与完整提示词见 [品牌素材](docs/brand-assets.md)。

站内链接和按钮通过客户端路由切页，表单与业务列表通过异步API更新。后台切换清单时分别读取数据，工单回复刷新时保留已有对话。前进后退、复制地址、Ctrl或中键新标签仍使用浏览器原有操作。首次打开的公共页面继续使用静态HTML。

`npm run test:ajax` 检查无整页重载的导航、表单和会话时序；`npm run test:ajax-live` 只读实际首页与产品API，并输出截图和文档装载统计。先启动本机预览，浏览器可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。

## 开发入口

| 要改什么 | 位置 |
|---|---|
| 页面、表单和工作台 | `apps/web/pages/` |
| 布局与主题 | `apps/web/layouts/`、`apps/web/assets/css/` |
| KIMA与品牌规范 | [视觉系统](docs/design.md) |
| Logo和云狐 | `apps/web/public/brand/` |
| 账号、订单、账单、服务和工单 | `apps/api/src/features/`，按主体命名 |
| 资金入账 | `apps/api/src/features/settlement.ts` |
| 数据连接与事务 | `apps/api/src/features/store.ts` |
| 支付渠道 | `packages/payments/plugins/` |
| 开通与调度 | `agent/features/`、`agent/plugins/` |
| 数据库结构 | `database/migrations/` |
| 原版功能与迁移依据 | [迁移说明](docs/migration.md)、`reference/inventory.json` |

新增业务主体默认导出 NestJS 入口类，放进 `features` 后自动发现。新增支付方式放进 `plugins`，按同一接口导出即可。代码遵循 [HOP](reference/skills/HOP.md)，主体文件保留职责、调用示例和业务步骤说明。

## 验证

```bash
npm test
npm run build
npm run test:integration
cd agent
go test -race ./...
go vet ./...
```

集成测试使用隔离数据库与独立 API 进程，覆盖业务和资金边界。浏览器截图保存在 `artifacts/`。验证方法与运行证据见 [验证记录](docs/verification.md)。

## 许可证

项目沿用原仓库的 AGPL-3.0，完整条款见 [LICENSE](LICENSE)。KIMA 使用 MIT 许可证，分发时保留其授权声明。原项目来源为 [idcsmart/ZJMF-CBAP](https://github.com/idcsmart/ZJMF-CBAP)。
