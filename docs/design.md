---
version: alpha
name: 狐岚云 KIMA 青蓝动态主题
description: 狐岚云直接消费 KIMA 0.12.3 的 Vue 组件与 Material You 动态色板。默认深色空间承接原创云狐领航员，大尺寸胶囊动作、透明表面和 Maple Mono 半粗字重贯穿首页、购买与工作台。浅色模式使用同一种子生成的配对角色，业务页面不再维护另一套颜色。
colors:
  seed: "#61afef"
  dark-surface: "#101418"
  dark-on-surface: "#e0e2e8"
  dark-primary: "#9acbfa"
  dark-primary-container: "#0b4a72"
  dark-on-primary-container: "#cde5ff"
  light-surface: "#f7f9ff"
  light-on-surface: "#181c20"
  light-primary: "#2e628c"
  light-primary-container: "#cde5ff"
  light-on-primary-container: "#0b4a72"
typography:
  display:
    fontFamily: "Maple Mono NF CN, Maple Mono, ui-monospace, monospace"
    fontSize: "64px"
    fontWeight: 700
    lineHeight: 1.25
  heading:
    fontFamily: "Maple Mono NF CN, Maple Mono, ui-monospace, monospace"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Maple Mono NF CN, Maple Mono, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.7
  label:
    fontFamily: "Maple Mono NF CN, Maple Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "Maple Mono NF CN, Maple Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.7
spacing:
  unit: "4px"
  field-gap: "24px"
  content-pad: "40px"
  mobile-pad: "20px"
  touch-target: "48px"
components:
  action:
    description: KimaButton 直接承担主要动作、涟漪、焦点、按下回弹与加载状态；不另画按钮内部结构。
    minHeight: "48px"
    borderRadius: "999px"
  field:
    description: KimaTextField、KimaTextarea、KimaSelect 承担输入和键盘行为；可见标签由应用放在组件外。
    minHeight: "64px"
    borderRadius: "12px"
  panel:
    description: KimaCard 与业务容器使用 layer 透明叠色分层，不用边框切割页面。
    borderRadius: "12px"
  drawer:
    description: KimaDrawer 承担表单、手机导航和需要确认的操作，背景聚焦遮罩配合实色弹层。
    borderRadius: "28px"
  table:
    description: KimaTable 负责完整宽度、圆角行带、键盘与横向滚动；应用只提供业务列和单元格内容。
    borderRadius: "8px"
---

## 方向与来源

狐岚云使用用户指定的 [KIMA](https://github.com/kernel4632/kima)，安装版本为 0.12.3。该库的 README、AGENTS.md 和 [视觉规范](https://github.com/kernel4632/kima/blob/main/docs/visual-spec.md) 是控件、动效和主题的直接依据。

首页的云狐、Logo 与标题构成品牌识别，KIMA 承担页面上的操作。青蓝的柔和容器色把公开首页、付款和工作台连接起来。页面沿用大控件和宽松密度，避免进入后台后突然切回细边框、小字和紧凑表单。

文档中的色值取自 KIMA `_palette.scss`，用于核对默认主题。运行时代码只引用 `--kima-*` 变量，配色修改只走官方 `applyPalette()`。应用没有第二份手工调色逻辑。

## 可核对的特征

- 默认深色页面，青蓝主动作；切换浅色时整套角色同步变化。
- 首页有原创白狐领航员，业务页保留 Logo，减少与当前任务无关的插画。
- 按钮为满圆胶囊，最小档 48px，输入区域为 64px。
- 卡片与业务表面通过 `layer-1/2/3` 透明叠色区分。
- 页面内不使用分割边框建立层级，弹层使用不透字的实色底。
- 字体使用 Maple Mono 半粗，中文通过系统字体回退。
- 全部图标来自 Hugeicons，经 KimaIcon 保持统一线宽。
- 创建产品、新建工单、手机导航和确认操作使用 KimaDrawer。
- 账单和服务使用 KimaTable，不在它下面另写一套表格键盘行为。

## 配色

### 角色

背景使用 `--kima-color-surface`，正文使用 `--kima-color-on-surface`。说明使用 `--kima-color-on-surface-variant`。主要动作使用 `primary` 与 `on-primary` 配对。

选中项使用 `primary-container` 与 `on-primary-container`，不能只换背景而保留原文字颜色。深浅模式下这两个角色始终一起变化。

页面层级引用 `--kima-color-layer-1/2/3`。这些是从当前文字色派生的透明层，因此背景变化后仍保留层次。抽屉、菜单和支付跳转说明使用库的 popup 角色，遮住背后内容。

成功、警告和危险色遵循 KIMA 的独立语义色。成功不能随品牌种子变化而变灰，失败也不能只靠颜色表达；状态旁始终有文字。

### 默认选择

新增普通业务容器先使用 `layer-1`。需要抬高一层时使用现有的 `layer-2`，不要添加新的十六进制颜色。背景色和字体色变化由 KIMA 主题 API 同步处理。

## 字体

全站以 `--kima-font-family` 和半粗字重为基准。应用加载 `@fontsource/maple-mono` 的 Latin 600 分片。装有 Maple Mono NF CN 的系统优先使用完整字体；未安装时中文由系统回退，英文与数字仍使用本地分发的 Maple Mono。

不把整套中文字体内联进 HTML。字体文件和静态脚本一样由构建器生成指纹地址，可长期缓存。

### 字号角色

| 位置 | 字号 | 用法 |
|---|---:|---|
| 首页主标题 | 响应式 44–76px | 只用于首页的品牌表达 |
| 工作台标题 | 32px，手机 28px | 说明当前正在做什么 |
| 章节标题 | 26–40px | 根据公开页与业务页层级选择 |
| 正文与控件 | 16px | KIMA 的默认阅读和操作大小 |
| 说明 | 14px | 辅助决策的信息 |
| 元信息 | 12px | 日期、编号辅助说明 |

金额和日期保留等宽数字，金额格式化由 `features/money.ts` 中的 `money()` 负责。浏览器只展示服务端金额，不计算成交价格。

## 标志性处理

### 云狐与青蓝空间

首页出现云狐时，使用 `/brand/fuxoria-mascot.png` 原创透明资产，融入页面的柔和主色空间。旁边的装饰不伪造运行指标、收益、用户数量或安全认证。

Logo 来自 `/brand/fuxoria-logo.png`。导航中的标志框裁剪透明余白，使图形在 48px 框里保持可见；不重新描绘或拼出另一种 Logo。

### 大控件

出现可提交的主动作时，直接用 KimaButton。传入 `loading` 后由组件显示忙碌状态、禁用重复提交和保持可访问状态，不用应用层手写 spinner。

出现文本输入时，使用 KimaTextField 或 KimaTextarea。应用保留可见标签，组件负责 aria-label、密码显示、输入法和焦点层。不要为了多排一行把控件缩回 36px。

### 抽屉聚焦

出现需要填写的新任务时，使用 KimaDrawer，将输入和保存操作放进同一个可聚焦区域。正文单独滚动，底部按钮在 footer。提交中即使关闭抽屉，原请求的处理状态和错误仍在页面可见；返回结果前，不能换一个确认目标，避免旧回包覆盖新操作。

结束工单的抽屉明确说明结果，默认焦点放在继续沟通。Escape 与焦点限制由组件处理，应用不维护另一套监听。

## 布局

### 公开页面

`.page-width` 最大 1280px，桌面左右保留 40px，手机为 20px。公共页顶栏桌面高 96px，手机为 88px。首页自己的版式类全部以 `home-` 开头，放在 `home.css`。

产品页在宽屏中使用三列，900px 以下改为单列。每张产品卡片同时放名称、说明、真实价格、库存与选择动作。零库存明确写“暂时售罄”，不允许继续购买。

### 工作台

桌面侧栏 268px，较窄桌面为 240px。主内容置于一个大圆角区域，内部保留 40px 或 32px 留白。手机使用 20px。

统计桌面四列，窄屏两列。最近账单与最近服务在宽屏并排，在较窄屏幕上下排列。网格列使用 `minmax(0, 1fr)`，不让表格的最小宽度撑开整页。

### 手机

手机保留四项底部导航：总览、我的服务、账单、支持工单。每项保留图标和文字，底部使用设备安全区。正文预留底栏高度，最后一条记录不会被遮挡。

更多导航和管理入口从 KIMA 底部抽屉打开。无需在手机顶栏塞入全部菜单。

表格只在自己的滚动区域横向滚动，账户页面不产生整页横向漂移。表单与详情页改为单列，输入框不会因页面变窄而缩小热区。

## 表面与形状

圆角只使用 KIMA 的 4、8、12、16、28 与 full 刻度。普通容器使用 12，大内容区域与抽屉使用 28，动作和选中导航使用 full。

KimaCard 承担卡片表面与可点击卡片的涟漪。业务页仍可用 section 表达语义分组，分组样式引用相同的层级变量。

表格使用独立圆角行带。应用不添加单元格分割线，也不覆盖表格内部布局以压缩密度。

## 动效与交互

控件保留 KIMA 的状态层、焦点环和涟漪；按钮还保留按下回弹。图标、文本和颜色一起表明当前状态，动效不独自承担反馈。

新增展开、错误提示和面板切换时，优先使用 KIMA 已提供的内容过渡。已有 KimaAlert、KimaSkeleton 和 Drawer 自带相应行为。

深浅切换由 `useTheme()` 调用 `applyPalette('#61afef', { isDark })`，库负责统一颜色过渡。偏好保存在 `yunzou_theme` 非敏感 cookie 中。

减少动态效果偏好下，动画与过渡退化为即时变化。页面不加入循环 WebGL 背景，资源开销留给主要业务。

## 状态与错误

数据空、正在读取和请求失败分别显示。KimaSkeleton 表示读取，KimaEmptyState 解释没有内容的原因，并给一个下一步。错误与操作放在同一处，保留用户输入。

工单和用户输入只按纯文本显示。付款成功以服务端验证过的通知为准，浏览器回跳和扫码界面不改变账单状态。

KimaQrCode 在浏览器本地编码服务端返回的支付内容，不把账单与付款链接发送给外部二维码服务。

## 应做与避免

| 应做 | 避免 |
|---|---|
| 直接使用 KIMA Vue 组件 | 只把旧原生按钮换个颜色后称为接入组件库 |
| 保留 48px 按钮、64px 输入 | 靠覆盖内部样式换回紧凑密度 |
| 从库的角色取背景与文字 | 在每个页面硬编码一套深浅色 |
| 页面内透明叠层、弹层实底 | 让抽屉后面的文字透上来 |
| 统一 Hugeicons | 混用 Lucide、emoji 和其它图标库 |
| 用抽屉承接新任务 | 表单展开时把整页内容突然推下去 |
| 状态文字与语义色同时保留 | 用品牌色把成功、待处理、失败都染成一种颜色 |
| 保留真实空状态和重试 | 用演示商品、假统计填满界面 |

## 缓存与加载

公共首页和目录先生成静态 HTML，价格与库存打开时由 API 更新。个人工作台、后台、登录注册和个人 API 设置 private/no-store；公开产品 API 保留服务端明确给出的短缓存。路径大小写与编码变体由独立 Nitro 中间件处理，避免缓存规则差异。

KIMA 样式通过单一 `kima.css` 入口合并共享 token。Nuxt 不将组件样式反复内联到每份 HTML，带指纹的 CSS、脚本和字体可长期缓存。

同源 API 转发读取运行时 `apiOrigin`，容器可以通过 `NUXT_API_ORIGIN` 指向服务端。代理保留原始请求正文、查询参数、Origin 与会话 cookie；支付通知不会被 JSON 重新编码。

站内链接使用 `AppLink` 接入客户端路由，内部仍由真实KimaLink渲染href、焦点与涟漪。普通点击只切换页面内容，修饰键、中键、新窗口与下载交给浏览器。界面按钮也直接使用捕获的路由实例，避免前一项身份中间件尚未返回时吞掉新的导航。手机菜单在选择当前页面或完成切页后关闭。

后台按当前接口使用独立异步数据key，慢清单不能挡住随后选择的清单。工单刷新保留旧正文与表单节点，发送状态与当前输入留在原位置。注册、登录和退出在同一会话主体中串行处理，晚到的旧身份结果不能覆盖新会话；确认退出或当前身份401后清理客户端页面缓存。

默认客户端地址取真实 socket，不采信调用者自报的转发头。部署在反向代理后时，`NUXT_TRUST_PROXY_CIDRS` 只接受明确的可信 CIDR 列表，并按连接链逐跳核对；不能填 `true` 或信任全部地址。向业务端转发时重新写入已核对的地址，清除原始 `Forwarded`。

## 增加页面时

1. 从实际任务选择 KIMA 组件，再组织文字、数据与动作。
2. 只加业务排版，不重建输入、选择、焦点和抽屉行为。
3. 新颜色先检查现有 token；品牌变化通过种子色生成整套角色。
4. 新图标从 Hugeicons 选择，并由 KimaIcon 显示。
5. 检查手机、键盘、减少动态效果、深浅主题和长文本。
6. 先验证空数据、失败和权限，再核对视觉。

## 边界与许可

KIMA 0.12.3 提供 JavaScript ESM，没有 TypeScript 声明。应用在 `types/kima.d.ts` 声明消费的 Vue 组件与具名插槽边界，业务请求和金额字段仍保留独立 TypeScript 类型。

KIMA 使用 MIT 许可。原许可证与 `THIRD_PARTY_NOTICES.txt` 随前端放在 `/legal/kima-LICENSE.txt` 和 `/legal/kima-THIRD_PARTY_NOTICES.txt`。Maple Mono 的 OFL 许可在 `/legal/maple-mono-OFL.txt`。

文档写法遵循 [humanizer](https://github.com/blader/humanizer)：说明具体行为，保留真实验证边界，不承诺未经测量的性能和安全等级。

## 资金与资源确认

用户和管理员按元填写金额，`toCents()` 先拆分字符串，再用 BigInt 转成整数分。输入框不接受科学计数或超过两位小数的金额。账单可以使用真实已有余额付款，确认抽屉会再次列出本次扣款与当前余额。

退款申请、批准、拒绝与查询分别显示真实状态。批准退款和资源暂停、恢复、终止均通过确认抽屉重新核对当前密码与需要的第二因素。任务排队不显示为资源已经变化。人工任务按动作要求提供真实资源标识或实际处理说明。

账户设置保留资料、密码、认证器、恢复码和会话操作。明文密钥与一次性恢复码只留在当前页面；二维码在浏览器生成，复制和下载只在用户点击后执行。

购物车显示服务端报价、数量和真实库存条件。一次结算绑定当时的修订号与幂等键，网络重试继续使用原标识。订单已确认但购物车同步失败时，页面保留原提交，禁止另起一份订单。账单按成交明细列出产品、数量、月付单价与小计，免费方案同样保留订单和账单记录。

账单的付款入口同时检查真实状态和 `payable`。资源正在终止或已终止时，旧续费单停止提供付款操作。旧二维码随后到账的款项保留收款事实，同时显示需要退款核对；不显示资源已恢复或续费成功。后台“款项核对”保留分页清单，全部实际退款完成后才由服务端标记已处理。

服务的运行状态和正在执行的任务分别显示。终止请求发出后隐藏新的续费与冲突操作，直到供应商结果确认前，运行状态仍使用服务端原值。人工终止使用的 `cancelled` 在服务语境显示“已终止”，账单的同名状态仍显示“已取消”。

尚未交付的服务还要核对原订单：未付款显示“待付款”，已付款显示“待开通”，未付记录可以直接进入原账单。人工到期暂停待办即使已因续费过时，也需要管理员向实际处理人核实尚未执行，才能凭当前密码与需要的第二因素关闭。跳过后明确显示“已跳过 / 未执行”，不把它显示成供应商已完成暂停。
