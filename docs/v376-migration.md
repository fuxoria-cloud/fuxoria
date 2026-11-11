# 智简魔方 3.7.6 功能对照

原始目录为 `~/zjmfv376`，`version` 文件记录版本 `3.7.6`。源码保持只读。`python3 scripts/inventory-v376.py` 生成的文件与方法位置保存在 `reference/zjmfv376-inventory.json`，包含各控制器的 SHA-256。盘点中的公共方法声明数包含页面入口和辅助操作，不能直接当成功能数量。

## 商品、配置与优惠

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 浏览商品和分组，管理上下级分组、排序和开放状态 | `app/admin/controller/ProductController.php` 的 `getProuductlistPage`、`saveProductGroup`、`saveProductFirstGroup`、`editStock`；`app/home/controller/CartController.php` 的 `postProductGroups`、`getProducts` | `/products`、`/admin/catalogue`；`product.ts`、`catalogue.ts` |
| 选择下拉配置、按数量购买附加资源、启用附加项，按周期重新报价 | `app/admin/controller/ConfigOptionsController.php` 的 `addOptions`、`editConfigPost`；`app/home/controller/CartController.php` 的 `getProductConfig`、`getOptions`、`setConfig`、`getTotal` | `POST /api/v1/catalogue/quote`；前台 KIMA 配置抽屉；后台周期与资源表单 |
| 同一商品以不同配置和周期分别加入购物车，修改数量、单行移除和结算 | `app/home/controller/CartController.php` 的 `addToShop`、`editToShop`、`modifyProductQty`、`removeProduct`、`clearCart`、`settle` | `/console/cart`；`cart.ts`、`order.ts` |
| 设置优惠方式、有效期、商品与周期范围、总次数、个人次数和首单限制 | `app/admin/controller/PromoCodeController.php` 的 `add`、`save`、`getList`、`expireImmediately` | `/admin/catalogue` 的优惠码表单；`admin/promotions`；`promotion.ts` |
| 使用或移除优惠码，保存首次优惠价或持续优惠的续费合同 | `app/home/controller/CartController.php` 的 `addPromoToShop`、`removePromoToShop`、`settle` | `PUT /api/v1/cart/promotion`；`order_items`、`services`、`promotion_uses` 成交快照 |

计费周期由 `catalogue.ts` 的 `periods` 定义。公开目录接口返回周期名称、月数、固定秒数与是否可续费，前台读取相同元数据。

| 周期标识 | 名称 | 日历月数／固定时间 |
| --- | --- | ---: |
| `hour` | 时付 | 3600秒 |
| `day` | 日付 | 86400秒 |
| `ontrial` | 试用 | 商品设置的1至365天 |
| `month` | 月付 | 1 |
| `quarter` | 季付 | 3 |
| `halfyear` | 半年付 | 6 |
| `year` | 年付 | 12 |
| `biennium` | 两年付 | 24 |
| `triennium` | 三年付 | 36 |
| `onetime` | 一次性 | 0 |

未单独配置月付时，商品基础价格继续作为月价。停用月付需保存月付行并关闭开放状态。一次性合同不产生续费，到期日保持空值。自动插件和管理员人工交付均按合同月数与固定秒数计算到期日，月末遵循 PostgreSQL 的日历月规则。

3.7.6 的 `percent` 是付款比例：九折保存为 `9000` 基点，计算为原价乘 `9000 / 10000`。`fixed` 按件减免固定金额，`override` 将每件价格降至指定金额，`free` 免安装费。客户组的 `discount_percent` 是减免比例，10 表示减免 10%。客户组减免先分别计算周期费与安装费，优惠码随后作用于每件金额；每步向下取到整数分。持续优惠只改变该次成交服务的续费合同价。

金额通过十进制整数分字符串传输，计算使用 BigInt。成交行保存商品名称、配置值与显示文字、原价、安装费、折扣和周期。每行金额始终等于折后单价乘数量。PostgreSQL 在提交时核对订单总额、折扣汇总、优惠占额与每件独立服务数量，订单、库存、审计和开通任务一起提交。

购物车的 `lineId` 由商品、周期和排序后的配置生成。同一商品的各配置共用库存，下单前合并数量并按商品 ID 排序加锁。结算使用客户提交键与购物车修订号识别重试，成交后通过 Redis CAS 清理原快照。并发新增的购物选择保留。

## 条件配置、试用和周期转换

`AdvancedOptionsController.php` 的 `page`、`create`、`addCondition`、`addResult`，以及 `ConfigOptionsController.php` 的 `getNextLinkAgeList`、`saveLinkAgeLevel`，对应 `/admin/catalogue` 的条件与链式配置。`catalogue-rule.ts` 按依赖图解析上游选择和下游可选值，支持全部或任一条件、等于／不等于、包含列表、数量比较、隐藏、必选、默认值和范围交集。保存时拒绝循环、同字段自引用与失效引用。购买、购物车和方案变更都使用相同规则；交互报价可规范下游选择，成交严格核对规范后的配置。

同页可以为主账号设置指定周期的专属价，限定精确配置或适用全部配置，并设置截止时间与启用状态。服务端先匹配专属价，再计算组折扣和优惠码。成交行保存完整规则、专属价与汇率定义快照，后续修改规则和目录价格不会改写合同。

原 `HostController.php` 的 `postHourDayRenew`、`postCycleToMonYear` 和 `checkHostCycle` 包含小时、日付、试用与包月年语义。狐岚云使用 `billing_months` 和 `billing_seconds` 区分日历周期、固定时长及一次性。每个主账号对同一商品只有一次试用资格，资格与零价订单同事务永久保存；试用不能续费或授权自动续费。试用与时日付转包月年通过 `/console/upgrades` 核价、付款和供应商确认，不接受客户端改价格或到期日。新周期金额扣除旧周期未使用部分的整数金额；试用抵扣为0。

时付自动续费的提前窗口为15分钟，日付为6小时，月付及更长日历周期为24小时。候选扫描、生成续费单和钱包扣款都重新核对授权与窗口；新到期日落在窗口外时不继续预付。相关结构在 `032_v376_catalogue_rules.sql`。

## 币种、汇率与账务隔离

原 `CurrencyController.php` 的 `currencyList`、`addCurrency`、`editCurrencyPost`、`deleteCurrency`、`updateRate`、`defaultCurrency`、`updatePrice` 对应 `/admin/currencies` 与 `currency.ts`。币种代码、币符、0至8位最小单位精度和启用状态由服务端管理；精度创建后固定。汇率保存为正整数分数，人民币为1/1锚点。汇率更新保留记录，批量换价用BigInt向上取目标最小单位，同时处理基础价、周期价、配置附加费、安装费与专属价，只影响新报价。

钱包、应收款、授信、还款与退款占额按会计事务的 `currency` 分桶。混合币种购物车不能合成一个总额，同币种合并支付继续使用原始子账单快照。`services.billing_currency` 从原订单回填并固定，后续商品换币种不会改变旧服务续费的金额含义。公开商品、报价与私有账单等金额对象同时返回 `currencyDecimals`，前端金额解析与显示使用同一精度。

微信、支付宝、易支付和虎皮椒的现有协议只支持CNY，外币收银台不显示这些渠道，接口也在创建付款意图和处理回调时检查币种。联盟推荐池限定CNY真实实收，员工销售与经营报表按币种分别统计。外币钱包可由经过核对的迁移期初形成；`scripts/opening.ts` 默认预检，显式写入后保存来源摘要、迁移权益与钱包负债双分录、审计。相同来源重试不重复入账，已有同币种钱包流水的账户不能追加期初。配置与操作见 [币种与期初迁入](currencies.md)，结构在 `033_v376_currencies.sql`。

## 客户、子账户与管理权限

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 搜索与编辑客户、内部备注、启用与停用 | `app/admin/controller/UserManageController.php` 的 `profile`、`profilePost`、`createClientPost`、`closeClient`、`getClientNotes`、`postClientNotes` | `/admin/clients`；`client.ts` |
| 配置客户组折扣、暂停豁免和出账偏好 | `app/admin/controller/ClientGroupController.php` 的 `index`、`save`、`read`、`update`、`delete` | `/admin/clients` 的客户组管理；`client.ts` |
| 联系人资料、通知偏好和子账户操作授权 | `app/home/controller/ContactsController.php` 的 `index`、`save`、`delete` | `/console/contacts`；`contact.ts` |
| 管理员角色、角色复制和成员分配 | `app/admin/controller/RbacController.php` 的 `addRole`、`editRole`、`copyRole`、`delete`；`RbacPageController.php` 的页面权限配置 | `/admin/roles`；`role.ts`、`utils/access.ts` |
| 创建、撤销和限制 API 密钥 | `app/admin/controller/ApiController.php` 的 `index`、`add`、`delete` | `/console/developer`；`api-key.ts` |

子账户使用独立登录身份，服务端按每条路由核对委托范围。停用或删除联系人后，相应委托立即失效。管理员权限从 Nest 控制器元数据发现，角色操作会检查自我提权与最后一位完整权限管理员。API 密钥使用 256 位随机值，仅首次显示，数据库保存 SHA-256；实际权限同时受密钥范围和账号角色约束，支持到期、撤销和账号版本失效。

## 联盟推荐与佣金

3.7.6 的客户入口来自 `app/home/controller/UserAffiliateController.php`：`activation` 启用推荐，`affindex` 显示收益，`affbuyrecord` 和 `updateCommission` 按订单核对佣金，`withdraw`、`withdrawrecord` 处理提现申请。后台依据是 `app/admin/controller/AffiliateController.php` 的 `index`、`useraffiPost`、`affiwithdrawrecord`、`affiwithdrawsh`。狐岚云的对应入口是 `/console/affiliates` 与 `/admin/affiliates`，业务和资金操作集中在 `features/affiliate.ts`。

管理员设置首购、续费和复购规则，支持净收款比例或固定金额，并指定等待天数和最低提现额。百分比按万分比保存，例如 `1000` 表示 10%；固定佣金以该笔净收款为上限。每张账单保存付款时的规则，之后调整全局配置不会改写已有佣金。

客户启用后获得随机推荐代码。链接进入注册页时保留首次归因，30天内注册随账号一起提交；服务端核验推荐人状态，并在注册事务中保存归属。原账号不能事后挂靠推荐关系，数据库拒绝自我推荐和循环归因。

佣金依据实际现金或钱包支付的业务账单生成。充值和信用还款单本身不计佣；信用消费须完整实际还款后才为原业务单计佣，等待期从该次实际还款开始。后台每60秒有界核对待释放佣金和后续退款，页面刷新也会核对当前推荐人的记录。等待期内的退款先从本金扣除，释放后的退款追加反向分录。已兑现部分产生不足时，联盟余额保留负数待追偿，后续收益先抵扣；客户钱包金额保持原有来源事实。

转入账户余额和提现申请均要求主账号当前密码及第二因素。提现先预留可用佣金，并发申请不能重复占用；撤回或驳回后释放预留。管理员登记已完成的实际打款时，须填写唯一流水凭据和时间，并重新验证密码和第二因素。系统在同一事务中保存打款事实、佣金负债与现金分录、审计。相关表和双向延迟约束见迁移 `022_v376_affiliates.sql`、`027_v376_affiliate_credit.sql`。

## 合并支付

原版操作依据为 `app/home/controller/UserInvoiceController.php` 的 `getCombineInvoices` 与 `combineInvoices`，盘点位置分别为733和761行。狐岚云入口是 `/console/combined`，接口位于 `/api/v1/combined-invoices`，实现集中在 `features/combined.ts` 与迁移 `029_v376_combined.sql`。

客户可选择2至50张本人同币种的新购、续费或升降级未付账单。已经生成付款链接、二维码或其他支付记录的账单不能加入。合并父单保存总额和原单顺序，原订单、成交价格与服务关系继续保留。父单通过同一收银台使用该币种已支持的渠道或同币种钱包余额付款；收款和收入只记父单一次，子单在同一事务中结清并各自执行交付操作。

合并期间，子单不能另行付款、借用信用或取消。父单尚未发起外部付款时，可以解除合并并释放原单；发起付款后需先核对付款结果。数据库在提交时核对父子归属、金额、状态和真实父资金来源，拒绝单独伪造已付子单。

开票与退款使用父单，子单不能重复申请税票。父单部分退款按合并时的原单顺序逐分冲减对应金额，佣金随各子单实际分配的退款追加冲回。多次小额退款和一次完整退款使用相同的累计金额依据。退款记录保留，资源变更仍经过各自的服务业务流程。

已开具的税票发生全额红冲时，管理员在 `/admin/documents` 登记实际红字票号、交付凭据和原因，并用当前密码及第二因素确认。原始票号、交付信息和开票快照继续保留，客户可在 `/console/vouchers` 查看原票据与红字记录；退款另行申请和核对。相应事实与约束保存在 `037_v376_tax_corrections.sql`。申请开票时，客户先选择币种，切换币种会清除此前的账单勾选，一张申请内的账单保持同币种。

## 员工销售与经营报表

员工销售依据 `app/admin/controller/SaleController.php` 的 `groupList`、`addSalegroup`、`editSalegroup`、`ladderList`、`addSaleLadder`、`editSaleLadder`、`saleStatistics`、`saleRecords`、`saleUsers` 和 `editAdminList`。狐岚云由 `/admin/sales` 配置销售组、商品范围、新购/续费/升降级比例、等待期和员工分工，通过 `/console/sales` 查看本人的客户、提成及兑现记录。实现保存在 `features/sales.ts` 与迁移 `034_v376_sales.sql`。

客户分配保存开始和结束时间。变更归属只影响之后的实际付款，已有记录继续归原员工。提成逐成交行保存商品和比例快照；阶梯按上海时区的本月同币种累计净实收计算，门槛达到后对当前成交行使用对应比例。销售组限制商品时，只计入范围内的成交行。充值、信用未实际偿还的应收款和合并父单不会重复产生员工提成，原业务单仍可识别实际还款或合并父收款。

等待期结束且退款已核对后，系统追加销售费用和员工提成负债分录。后续退款按原成交行分配金额冲回；已兑现后出现不足时，负余额保留为待抵扣金额。员工提交兑现申请需要当前密码和第二因素，金额按币种预留。管理员登记实际打款凭据和时间后，系统在同一事务中记录现金、提成负债与审计。联盟推荐和员工销售使用各自的归属、记录与资金来源。

经营报表依据 `app/admin/controller/ReportsController.php` 的 `getYearIncomeStatistics`、`getYearIncomeStatisticsForChart`、`getNewClientStatistics`、`rankForwardClient`、`productIncome`，以及 `RunMapController.php` 的 `runCronTrend`、`runCronList`。入口是 `/admin/reports`，实现位于 `features/reports.ts`。可以按日期、币种和日/月间隔查询资金变化、新客户、客户实收排名、商品实收排名及资源任务运行趋势。所有金额按币种分组。

资金变化取所选期间的真实账本分录，分别显示现金进出、净收入、钱包负债变化和应收款变化。客户与商品排名按原业务单的实际结清期间统计，并扣除其后已完成退款；商品退款按成交明细固定顺序分配。新客户人数排除联系人子账号。资源运行页读取真实任务状态、动作、供应商、尝试次数与最近错误，展示创建期间的状态趋势。日报范围最多一年，月报最多十年。

## 支持、知识库与下载

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 创建和回复工单、关联服务、上传私有附件、关闭与评价 | `app/home/controller/TicketController.php` 的 `getDepartmentList`、`createTicket`、`ticketDetail`、`replyTicket`、`closeTicket`、`evaluate`、`downloadAttachment` | `/console/tickets`；`ticket.ts` |
| 配置支持部门、分派客服、内部备注和同客户工单合并 | `app/admin/controller/TicketController.php` 的 `mergeTicket`、`addNote`、`ticketReceive`、`ticketTransfer`；`TicketDepartmentController.php` 的 `add`、`save` | `/admin/support`；`department.ts`、`ticket.ts` |
| 快捷回复及分类管理 | `app/admin/controller/TicketPrereplyController.php` 的 `addCategory`、`editCategory`、`deleteCategory`、`addPrereply`、`savePrereply`、`deletePrereply` | `/admin/support?tab=replies` |
| 知识库分类树、搜索与文章编辑 | `app/home/controller/KnowledgeBaseController.php` 的 `index`、`searchArticle`、`viewArticle`；后台同名控制器的 `addCategory`、`addArticle`、`editArticlePost`、`editCategoryPost`、`deleteCategory` | `/help`、`/admin/support?tab=knowledge`；`content.ts` |
| 按公开、登录与有效服务限制文件下载，维护文件分类 | `app/admin/controller/DownloadsController.php` 的 `postAddFile`、`postSaveFile`、`postUploadFile` | `/console/downloads`、`/admin/support?tab=downloads`；`download.ts` |
| 阅读和删除站内通知 | `app/home/controller/SystemMessageController.php` 的 `getMessageList`、`getUnreadList`、`readSystemMessage`、`deleteSystemMessage` | `/console/notifications`；`notification.ts` |

附件保存在部署数据卷。私有目录权限为 `0700`，文件权限为 `0600`；每次下载重新检查用户归属、工单内部可见性或所需服务。工单合并保留来源链和回复事实，知识库分类调整检查层级循环。

## 服务、合同与票据

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 服务备注、分组、续费、自动续费和双方确认转移 | `app/home/controller/HostController.php` 的 `postRemark`、`postSaveCate`、`postTransferCate`、`postRenew`、`postAutoRenew`、`postTransfer`、`postReceiveTranfer`、`postRefuseTranfer` | `/console/services`、`/console/services/:id`、`/console/transfers`；`service.ts`、`autorenew.ts`、`transfer.ts` |
| 申请立即或周期末取消，经批准后执行真实终止 | `app/home/controller/HostController.php` 的 `getCancelPage`、`postCancel`、`deleteCancel` | `/admin/lifecycle`；`cancellation.ts`、Go 调度与任务队列 |
| 选择新方案或配置，核对剩余周期差价与后续续费价格 | `app/home/controller/UpgradeController.php` 的 `upgradeConfigPost`、`checkoutConfigUpgrade`、`upgradeProductPost`、`checkoutProductUpgrade` | `/console/upgrades`；`upgrade.ts`、Go 供应商 `upgrade` 动作 |
| 申请、签署、撤回、作废和下载合同 | `app/home/controller/ContractController.php` 的 `contractCreate`、`contractSign`、`contractList`、`download`、`cancel`；后台同名控制器的模板与审核操作 | `/console/contracts`、`/admin/documents`；`contract.ts` |
| 保存普通或专用发票抬头，按真实已付账单申请开票并记录实际票号与交付地址 | `app/home/controller/VoucherController.php` 的 `postVoucherInfo`、`postIssueVoucher`、`getVoucherList`；后台同名控制器的 `postVoucherStatus` | `/console/vouchers`、`/admin/documents`；`voucher.ts` |

方案变更报价固定旧合同和目标配置，以 BigInt 计算剩余时间比例并向上取到分。供应商需明确具备变更能力；人工服务须由管理员确认实际处理。付款与资源变更分别保存事实，供应商同步结果或已验签回调成功后才更新当前商品、配置和续费价。原始购货项和资源外部标识保留；同周期配置变更保留到期日，试用或时日付转换到包月年后，从供应商实际确认的时刻开始新周期。

合同在申请时固定正文、主体信息和 SHA-256 指纹。本人签署核对签署人与文本指纹，中文 PDF 可供独立读取。服务转移保留原购买与旧账单归属，转移双方分别确认，并清除原自动续费授权。取消审批只产生执行意图，供应商真实终止成功后才把取消申请记为已执行。

## 充值与信用

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 充值、余额抵扣与原路退款 | `app/home/controller/PayController.php` 的 `recharge`、`applyCredit`、`startPay`；`UserInvoiceController.php` 的资金记录操作 | `/console/wallet`；`recharge.ts`、`wallet.ts`、`refund.ts` |
| 授信、信用付款、月结、提前归集与真实还款 | `app/home/controller/CreditLimitController.php` 的 `creditLimitUsed`、`creditLimitInvoice`、`creditLimitPrepayment`；后台同名控制器的 `save`、`update`、`postConfig` | `/console/credit`、`/admin/credit`；`credit.ts` |

充值借记渠道现金、贷记客户钱包负债，实际消费再确认业务收入。信用付款增加应收款，真实还款才释放额度。月结候选与锁后明细使用相同的未归集条件，首批50组客户币种完成后会继续处理后续账户。自动续费已经产生不足账单的服务不反复占用前25个候选；补款后可继续结清原账单，通知和订单保持幂等。

详细资金规则见 [充值与信用额度](credit-and-recharge.md)。

## 实名与身份验证

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 个人或企业资料核验，个人转企业保留历史 | `app/home/controller/CertificationController.php` 的 `personCertifiPost`、`companyCertifiPost`、`personToCompany`、`certifi` | `/console/identity`、`/admin/verification`；`certification.ts` |
| 第三方授权登录、本人绑定与解绑 | `app/home/controller/OauthController.php` 的 `listing`、`url`、`callback`；`OauthBindController.php` 的 `listing`、`untie` | `/login`、`/oauth/complete`、`/console/identity`；`oauth.ts` |
| 验证并更换邮箱或手机号 | `app/home/controller/UserController.php` 的 `bind_phone_send`、`bind_phone_handle`、`bind_phone_change`、`bind_email_handle`、`change_email_handle` | `/console/verification`；`verification.ts` |

实名文件使用独立密钥加密，查看原文和材料需通过本人证明并留下访问审计。人工结论明确标注来源，历史申请和终态保留。第三方登录使用真实授权码、S256 PKCE、一次性浏览器 state 和 OIDC 令牌核对，随后继续执行本地 MFA。同邮箱身份不自动接管账号。

邮箱和手机验证码通过配置的受控发送程序交付。服务端保存 HMAC 摘要，限制有效期、尝试次数和发送频率。更换绑定须同时核对验证码、当前密码和已开启的双因素，成功后撤销旧版本会话。渠道拒绝发送时，接口返回失败。

配置见 [实名资料核验](identity-verification.md) 和 [第三方登录](oauth.md)。

## 登录、注册与密码恢复

`LoginController.php` 的 `mobileSend`、`mobileLoginVerify`、`phonePassLogin`、`emailLogin` 对应 `/login`、`/verify-login` 与 `recovery.ts`。`RegisterController.php` 的 `registerPhone`、`registerEmail`、`resetPhoneSend`、`resetEmailSend`、`passPhoneReset`、`passEmailReset` 对应 `/verify-register`、`/recover`。发送和验证使用已配置的真实消息通道，验证码登录和重置密码继续要求本地MFA。邮箱找回只接受已经验证的邮箱，不能用未验证地址接管账号。绑定与恢复入口共享发送预算，交替调用也不能绕过冷却期。

原微信登录依据 `WechatController.php` 的 `index`、`login_handle`、`wechat_regist`。狐岚云通过微信原生授权码协议核对 `AppID:openid`，保留本地密码与MFA后的显式绑定；已有邮箱地址不会被第三方身份自动接管。微信协议没有PKCE支持，浏览器一次性state、固定回调地址和本地身份复核仍执行。配置见 [第三方登录](oauth.md)。

## 客户与工单自定义字段

`SetController.php` 的 `getCustomFields`、`postCustomFields`、`delCustomFields`，以及 `TicketDepartmentController.php` 的 `addTicketCustomParam`、`editTicketCustomParam`、`delTicketCustomParam`，对应 `/admin/fields`、`/console/profile-fields` 与工单创建表单。`fields.ts` 保存字段定义、权限、格式和必填规则。提交值保存当时定义快照，更新采用版本检查，并保留追加历史；删除或修改字段不会悄悄改写旧工单含义。结构见 `031_v376_custom_fields.sql`。

## 消息模板、批次与客户关怀

`EmailTemplateController.php` 的 `createTemplatePost`、`editTemplatePost`，`ConfigMessageController.php` 的 `sendMessagePost`，`SendMessageBatchController.php` 的 `sendMessagePost`、`getProgress`，以及 `ClientCareController.php` 的 `createCarePost`、`editCarePost`，对应 `/admin/messaging` 与 `messaging.ts`。模板、持久发送批次、实际进度和关怀计划分别保存，渠道未配置时不会显示为已送达。

消息任务区分机构明确未受理与结果未知：前者可按退避规则重试，后者保留待核对事实；过期租约也不会被当成可安全重发。营销发送要求目标已经验证、客户主动订阅且仍有权限，退订会取消尚未发送的营销任务。静默时间按客户本地时区计算并处理夏令时，关怀分页推进，多节点依靠数据库幂等。客户偏好入口是 `/console/message-preferences`，结构见 `035_v376_messaging.sql`。

## 批量续费

原 `HostController.php` 的 `postBatchRenewPage`、`postBatchRenew` 对应 `/console/renewals` 与 `batch.ts`。批次保存每个服务的独立幂等子键与执行结果，逐项调用正式续费入口；不同币种保持各自金额，选中的同币种未付账单可以继续合并支付。持久租约支持多实例执行，崩溃后重放返回已经成交的续费事实，账号会话版本变化后不继续使用旧授权。结构见 `036_v376_batches.sql`。

## 资源模块与客户活动

| 用户操作 | 3.7.6 源码依据 | 狐岚云入口与实现 |
| --- | --- | --- |
| 查看真实状态、流量和图表，执行声明的自定义动作与按钮 | `app/home/controller/ProvisionController.php` 的 `execute`、`customFunc`、`getChartData`、`execCustomButton`；`HostController.php` 的服务归属与状态检查 | `/console/resources/:id`；`resource.ts`、Go `resource.go`、在线文件插件能力 |
| 打开短期控制台、获取资源登录凭据 | 同一控制器的资源接口与客户区域模块输出 | 主账号密码与已启用的第二因素；来源白名单、最长五分钟的加密私有结果、单次读取 |
| 查看自己的业务活动并按日期和事件搜索 | `app/home/controller/RecordLogController.php` 的 `getUserLogs`、`getUserLogDcs` | `/console/activity`；`activity.ts`；账号实体归属和公开事件白名单 |

资源输入入队前由独立 `RESOURCE_KEY` 加密，Go 仅在执行前解密；同步和签名回调均在首次持久化前剥离并加密私有输出。运行节点只领取自己实际支持的供应商、动作和能力快照。界面使用结构化文本与图表，供应商任意 HTML 和脚本不进入页面。实际服务转移后，旧发起人和新主人均不能读旧私有结果，新主人可以重新查询。协议和部署方式见 [资源模块](resource-modules.md)。

## 验证命令

在项目根目录运行：

```sh
node --env-file=.env --import tsx --test apps/api/tests/catalogue.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/identity.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/support.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/documents.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/upgrade.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/credit.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/affiliate.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/resource.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/currency.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/scheduler-fairness.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/identity-provider.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/wechat.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/verification.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/recovery.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/custom-fields.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/messaging.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/resource.integration.test.ts
```

商品测试创建随机命名的独立 PostgreSQL 数据库，运行真实迁移和业务主体，Redis 只清理本轮账号对应的购物车键。验收包含配置边界、逐分取整、客户组与优惠叠加、成交快照、购物车重放、取消恢复额度、最后库存并发争抢、最后优惠额度并发争抢，以及十种周期的人工交付、链式条件、专属价格、单次试用转正和时日付自动续费窗口。结束前核对完整审计链。

身份与支持测试启动真实 Nest HTTP 服务并经过生产访问控制，覆盖错误输入、跨账号访问、权限委托、密钥撤销、MFA 恢复码、附件完整性、并发写入、工单合并、分类和下载范围。各测试独立创建数据库和临时文件目录，退出后清理本轮数据。

联盟、合并、销售和报表测试使用随机独立 PostgreSQL、真实 Redis 和完整 Nest HTTP 服务，17项通过。验证包括注册归因和循环拒绝、重复付款只计一次佣金、转余额幂等、提现并发预留、打款凭据与现金分录、退款前后净额、固定佣金封顶、孤立资金来源拒绝，以及信用实际还款后才起等待期。合并场景检查同键只建一单、子单禁止另付与取消、父取消释放、父现金及钱包各只入账一次、原单交付和父退款逐分冲回多个子佣金。销售场景核对员工归属、阶梯、退款、并发预留、实际兑现及后续负余额；USD与零位小数JPY分别累计阶梯、退款、兑现和筛选报表，外币业务不进入联盟CNY佣金池；报表同时核对充值、收入、应收和合并父子金额。验收付款与打款凭据仅存在于隔离测试库，测试不连接外部支付或打款服务。

资源模块真实 HTTP、Go 入口、本地可执行程序和签名回调检查共13项通过，覆盖来源、归属、加密、重放、子账号、API密钥、真实转移及MFA恢复码一次消费。客户日志不返回全站审计详情。

Go 队列使用独立测试 schema：

```sh
cd agent
YUNZOU_TEST_DATABASE_URL='postgres://测试连接' go test -race ./features -run TestQueueBillingPeriods -count=1
```

周期测试检查开通插件收到的配置和周期快照、首次交付到期日、续费日历月边界及一次性合同空到期日。供应商输入包含 `configuration`、`billingPeriod`、`billingMonths`、`billingSeconds`、`billingCurrency`，备注与客户隐私不进入这组字段。

浏览器组件回归使用真实 Nuxt 与 KIMA，API 使用严格限定的浏览器夹具核对请求合同。业务事务和身份协议由上述真实 HTTP 与数据库测试验证。正式前端3300上的支持、商品与核验、账户与资源三组浏览器测试按序30项通过，日志为 `artifacts/final-support.log`、`final-catalogue.log`、`final-accounts.log`。

```sh
WEB_TEST_ORIGIN=http://127.0.0.1:3300 node --test apps/web/tests/catalogue.browser.mjs
WEB_TEST_ORIGIN=http://127.0.0.1:3300 node --test apps/web/tests/support.browser.mjs
```

商品与核验截图包括 `artifacts/v376-catalogue-rules-mobile.png`、`v376-currencies-mobile.png`、`v376-cycle-conversion-mobile.png`、`v376-product-configuration-mobile.png`、`v376-promotion-cart-mobile.png`、`v376-catalogue-admin-desktop.png`、`v376-certification-history-mobile.png`、`v376-certification-review-desktop.png` 和 `v376-oauth-mfa-desktop.png`。桌面与 390px 手机回归检查横向溢出、浏览器异常和未预期 API；配置到购物车、OAuth 确认到工作台均保留同一文档。

浏览器表单与连续导航可在本机前端预览上验证：

```sh
WEB_TEST_ORIGIN=http://127.0.0.1:3300 node --test apps/web/tests/v376-accounts.browser.mjs
```

该组使用真实 Nuxt 路由和 KIMA 控件，严格拦截全部业务 API 与站外请求。八个场景覆盖联系人编辑字段、API密钥一次显示、客户和角色创建、授信金额转换、合同快照签署、开票选择、联盟规则与提现凭据，以及手机端佣金转余额和合并支付；销售场景还检查零小数币种的阶梯门槛和员工兑现金额，报表场景验证币种切换。红冲场景核对原票号保留、实际红字凭据、客户端展示和开票切币种清除旧勾选。每个场景检查连续操作只装载首次一份文档，并拒绝 Vue 属性类型警告；截图同时检查整页横向溢出。1440px桌面与390px手机的记录保存为 `artifacts/v376-*-browser-*.png`；这些截图使用明确标注的浏览器夹具，真实资金边界由前述独立数据库测试验证。

## 既有业务兼容回归

正式迁移序列下，以下命令按序执行通过。测试数据使用各自独立库或私有临时目录，日志保存在交付目录。

| 命令 | 通过项 | 日志 |
| --- | ---: | --- |
| `npm run test:finance` | 11 | `artifacts/final-finance.log` |
| `npm run test:wallet` | 7 | `artifacts/final-wallet.log` |
| `npm run test:security` | 9 | `artifacts/final-security.log` |
| `npm run test:cart` | 10 | `artifacts/final-cart.log` |
| `npm run test:import` | 8 | `artifacts/final-import.log` |
| `npm run test:lifecycle` | 11 | `artifacts/final-lifecycle.log` |
| `npm run test:review` | 10组独立复核 | `artifacts/final-review.log` |
| `npm run test:static` | 2 | `artifacts/final-static.log` |

会话撤销检查核对真实401拒绝结果，购物车同时核对有效但未配置的周期返回409、未知周期返回400。导入回归保留严格空业务库限制，仅允许迁移自身的精确初始配置。静态测试验证分发失败后的上传与删除意图重放、同尺寸损坏修复及内容撤回路径，资金与生命周期复核包含真实Go和跨语言审计链。
