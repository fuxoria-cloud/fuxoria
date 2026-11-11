/*
 * 业务集成验收：在独立数据库和 API 进程中真正调用账号、订单、支付、交付、续费、工单和审计。
 * 调用：项目根 npm run test:integration。PostgreSQL/Redis 使用根 .env 的连接主机，数据库固定另建 yunzou_integration_test，Redis 使用独立 DB14。
 * 测试易支付密钥只存在于临时进程；不开真实支付、不调用云供应商，结束后删除数据库、会话与临时进程。
 */
import assert from 'node:assert/strict';                             // 以业务结果判断成功，不靠截图或日志猜测
import test from 'node:test';                                       // 所有子场景顺序执行，资金竞态在场景内显式并发
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'; // 独立签名参考与不可预测的测试凭据
import { existsSync } from 'node:fs';                               // 环境允许直接注入连接配置
import { mkdtemp, rm } from 'node:fs/promises';                      // 隔离并清理测试二进制
import { tmpdir } from 'node:os';                                   // 测试产物不混入代码目录
import { join, resolve } from 'node:path';                          // 进程路径固定到项目而非调用目录
import { fileURLToPath } from 'node:url';                            // ESM 中定位本项目
import { spawn, execFile, type ChildProcess } from 'node:child_process'; // 启动独立API与Go消费者，不修改dev进程
import { promisify } from 'node:util';                              // 构建失败直接反馈测试
import { setTimeout as delay } from 'node:timers/promises';          // 有界等待就绪与安全停机
import { createServer } from 'node:net';                            // 启动前检查专用测试端口空闲
import pg from 'pg';                                               // 资金和约束核对使用真实 PostgreSQL
import { createClient } from 'redis';                               // 只清理专用测试Redis中的本次会话
import { verifyAudit } from '../../../scripts/verify-audit.js';       // 验证脚本与集成使用同一公开入口

const root = fileURLToPath(new URL('../../../', import.meta.url));    // 启动位置变化不会指向另一份配置
const execute = promisify(execFile);                                // 只执行确定的程序及分开的参数
const origin = 'https://yunzou.test';                               // 独立测试来源，不给dev配置假商户
const databaseName = 'yunzou_integration_test';                       // 只允许销毁这个明确预留的测试库
const port = 3303;                                                 // 与dev API3301分离
const base = `http://127.0.0.1:${port}/api/v1`;                       // 所有HTTP调用只到独立测试进程
const password = `Test-${randomBytes(18).toString('base64url')}`;      // 测试密码不来自任何真实用户

type Actor = { id: string; cookie: string; email: string };           // 只有本轮签发的会话可以参与清理

type Reply = { status: number; body: any; text: string; headers: Headers }; // 同时检查JSON业务结果与渠道纯文本回执

// --- 管理本轮的进程、专用数据库与随机配置 ---
class Fixture {
  auditKey = randomBytes(32).toString('hex');                         // 与生产审计密钥完全隔离
  paymentKey = randomBytes(32).toString('hex');                       // 只用于本轮协议签名，没有真实商户权限
  merchant = 'test-merchant';                                       // 机构身份同样是显式测试值
  databaseUrl = '';                                                // 创建专用库后才允许启动API
  redisUrl = '';                                                   // 不对dev Redis DB0执行任何清理
  admin!: pg.Client;                                               // 持有测试库互斥锁直到清理完成
  database!: pg.Pool;                                              // 接入专用库进行结果核对
  cache!: ReturnType<typeof createClient>;                          // 清理本次签发的会话键
  processes: ChildProcess[] = [];                                  // 只终止本轮自己启动的进程
  tokens = new Set<string>();                                      // 不使用 FLUSHDB 或匹配全站会话
  addresses = new Set<string>();                                   // 清理本轮账号的限流键
  directory = '';                                                  // 临时Go二进制所在目录
  created = false;                                                 // 尚未取得锁或建库时不会误删别人的测试
  logs = '';                                                       // 有上限且脱敏的启动诊断
  environment!: NodeJS.ProcessEnv;                                 // 独立进程配置不修改根 .env

  async start() {
    const environmentFile = new URL('../../../.env', import.meta.url); // 只借用本机基础设施连接
    if (existsSync(environmentFile)) process.loadEnvFile(environmentFile); // 显式注入变量优先于文件
    assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, '需提供 PostgreSQL 与 Redis 连接'); // 缺基础设施不能假装集成通过
    await execute('npm', ['run', 'build', '--workspace=@fuxoria/payments'], { cwd: root, timeout: 90_000 }); // 每轮验证最新支付产物
    await execute('npm', ['run', 'build', '--workspace=@fuxoria/api'], { cwd: root, timeout: 90_000 }); // 不以过期dist文件冒充当前源码行为
    const source = new URL(process.env.DATABASE_URL);                // 主库只用于推导同一实例的连接
    const master = new URL(source);                                 // 测试管理连接不进入dev业务库
    master.pathname = '/postgres';                                 // 在系统库建立独立测试数据库
    this.admin = new pg.Client({ connectionString: master.href });    // 连接字符串不写日志
    await this.admin.connect();                                    // 无创建权限时明确失败
    const locked = await this.admin.query("SELECT pg_try_advisory_lock(812439) AS locked"); // 同时只运行一套该数据库测试
    assert.equal(locked.rows[0].locked, true, '另一套集成测试正在运行'); // 不强行杀掉另一个合法测试进程
    await this.admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); // 只清理专用库的上次残留
    await this.admin.query(`CREATE DATABASE ${databaseName}`);       // 不覆盖dev数据库
    this.created = true;                                           // 从此只清理本轮创建的库
    source.pathname = `/${databaseName}`;                           // API与测试查询都切到专用库
    this.databaseUrl = source.href;                                // 密码仍只在进程内保留
    this.database = new pg.Pool({ connectionString: source.href, max: 8 }); // 结果核对与API连接相互独立
    await execute('npm',['run','db:migrate'],{cwd:root,env:{...process.env,DATABASE_URL:this.databaseUrl},timeout:60_000}); // 与部署相同的迁移命令同时登记内容摘要
    const redisAddress = new URL(process.env.REDIS_URL);             // 复用测试基础设施的网络地址
    redisAddress.pathname = '/14';                                 // 专用测试逻辑库，dev会话不受影响
    this.redisUrl = redisAddress.href;                              // 不在输出中展示凭据
    this.cache = createClient({ url: this.redisUrl });               // 连接只用于精确键清理
    await this.cache.connect();                                    // 会话系统也是本次集成的一部分
    this.environment = { ...process.env, DATABASE_URL: this.databaseUrl, REDIS_URL: this.redisUrl,
      AUDIT_KEY: this.auditKey, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
      NODE_ENV: 'test', SESSION_TTL_SECONDS: '600' };                 // 所有业务配置覆盖根环境值
    for (const name of Object.keys(this.environment)) {
      if (/^(EPAY_|ALIPAY_|WECHAT_|HUPIJIAO_)/.test(name)) delete this.environment[name]; // 不向测试进程继承真实收款通道配置
    }
    Object.assign(this.environment, { EPAY_VERSION: '1', EPAY_URL: 'https://pay.example.invalid/submit.php', EPAY_PID: this.merchant, EPAY_KEY: this.paymentKey }); // 仅生成协议URL，不访问外部网关
    await this.freePort();                                         // 不把现有服务误认成测试进程
    this.launch(process.execPath, [join(root, 'apps/api/dist/main.js')]); // 使用实际编译产物启动独立API
    await this.wait(async () => { try { return (await fetch(`${base}/health`)).status === 200; } catch { return false; } }, '测试API未能启动'); // 真实依赖就绪后才开始验收
    this.directory = await mkdtemp(join(tmpdir(), 'yunzou-integration-')); // 构建产物不进入源码目录
  }

  async freePort() {
    const server = createServer();                                 // 端口已占用时拒绝继续
    await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady); }); // 不向其他API发送测试数据
    await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())); // 检查后立即释放
  }

  launch(program: string, arguments_: string[]) {
    const process_ = spawn(program, arguments_, { cwd: root, env: this.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); // 无shell，方便整组停止
    this.processes.push(process_);                                 // 清理只针对自己持有的句柄
    const keep = (chunk: Buffer) => { this.logs = (this.logs + chunk.toString().replaceAll(this.auditKey, '[redacted]').replaceAll(this.paymentKey, '[redacted]')).slice(-12_000); }; // 有界且不暴露测试密钥
    process_.stdout!.on('data', keep);                              // Nest启动日志只留内存诊断
    process_.stderr!.on('data', keep);                              // 服务故障不误当成功
    process_.on('error', error => { this.logs = (this.logs + error.message).slice(-12_000); }); // 启动错误不会变成未处理事件
    return process_;                                               // 调用方可以精确等待其正常退出
  }

  async wait(check: () => Promise<boolean>, message: string) {
    for (let attempt = 0; attempt < 100; attempt++) {                // 最长约十秒，不无限等待服务
      if (await check()) return;                                   // 状态由实际依赖确认
      await delay(100);                                            // 仅用于等待外部进程就绪
    }
    throw new Error(`${message}；启动日志：${this.logs}`);             // 只在失败时给出脱敏诊断
  }

  async request(method: string, path: string, options: { actor?: Actor; body?: unknown; origin?: string | null; key?: string; raw?: string; contentType?: string; fetchSite?: string } = {}): Promise<Reply> {
    const headers = new Headers();                                 // 每次请求独立，避免串用账号
    if (options.actor) headers.set('cookie', options.actor.cookie);  // 身份只来自真实HTTP签发的会话
    if (options.origin !== null) headers.set('origin', options.origin ?? origin); // 写请求默认来自独立测试站点
    if (options.fetchSite) headers.set('sec-fetch-site', options.fetchSite); // 浏览器Fetch Metadata不因省略Origin而跳过
    if (options.key) headers.set('idempotency-key', options.key);     // 并发用例显式选择重试是否同键
    if (options.body !== undefined || options.raw !== undefined) headers.set('content-type', options.contentType ?? 'application/json'); // 支付表单可以保留原始字节
    const response = await fetch(`${base}${path}`, { method, headers, body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)), signal: AbortSignal.timeout(15_000) }); // 故障请求也有等待上限
    for (const cookie of response.headers.getSetCookie()) {
      const token = /^yunzou_session=([^;]+)/.exec(cookie)?.[1];      // 只追踪本轮签发的会话键
      if (token) this.tokens.add(decodeURIComponent(token));         // 清理不扫描或删除其他用户会话
    }
    const text = await response.text();                            // 回调纯文本和错误JSON都要核对
    let body: unknown = text;                                      // 非JSON回执保持原文
    try { body = JSON.parse(text); } catch {}                       // 这是HTTP格式边界，合法纯文本不是错误
    return { status: response.status, body, text, headers: response.headers }; // 不把cookie或支付签名写测试输出
  }

  async register(label: string): Promise<Actor> {
    const email = `${label}-${randomUUID()}@test.invalid`;           // 同轮以外不会碰撞真实用户
    this.addresses.add(email);                                    // 限流键也精确清理
    const response = await this.request('POST', '/auth/register', { body: { email, password, name: label } }); // 必须经过真实密码哈希与会话流程
    expect(response, 201);                                         // 不直接造登录token
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('yunzou_session=')); // 只使用HttpOnly会话
    assert.ok(cookie?.includes('HttpOnly') && cookie.includes('SameSite=Lax'), '会话应包含HttpOnly和SameSite'); // 浏览器会话属性也参加验收
    return { id: response.body.id, email, cookie: cookie!.split(';')[0] }; // 身份以服务返回的账号为准
  }

  async product(admin: Actor, stock: number | null = 5, priceCents = '1099') {
    const response = await this.request('POST', '/admin/products', { actor: admin, body: { name: `验收商品-${randomUUID()}`, description: '只在专用测试库存在', priceCents, currency: 'CNY', stock, provider: 'manual', active: true } }); // 正常后台入口创建报价
    expect(response, 201);                                         // 商品创建必须确实提交
    return response.body;                                          // 后续下单不自行提交价格
  }

  async order(actor: Actor, productId: string, key = randomUUID()) {
    return this.request('POST', '/orders', { actor, key, body: { productId, period: 'month' } }); // 共用同一购买入口
  }

  callback(invoiceId: string, amountCents: string, transactionId = `test-${randomUUID()}`, changes: Record<string, string> = {}) {
    const amount = BigInt(amountCents);                            // 参考签名金额也不经过浮点
    const fields: Record<string, string> = { pid: this.merchant, out_trade_no: invoiceId.replaceAll('-', ''), trade_no: transactionId,
      name: '狐岚云集成验收', money: `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`, trade_status: 'TRADE_SUCCESS', ...changes }; // 机构通知使用真实V1字段
    const canonical = Object.keys(fields).sort().filter(name => !['sign', 'sign_type'].includes(name) && fields[name] !== '').map(name => `${name}=${fields[name]}`).join('&'); // 独立实现协议参考，不调用被测签名函数
    fields.sign = createHash('md5').update(canonical + this.paymentKey).digest('hex'); // 测试密钥只属于临时商户
    fields.sign_type = 'MD5';                                      // 不接受算法降级或不同版本混用
    return new URLSearchParams(fields).toString();                  // URL编码在签名之后进行
  }

  async notify(query: string) {
    return this.request('GET', `/payments/epay/notify?${query}`, { origin: null }); // 支付机构回调无浏览器会话和Origin
  }

  async checkout(actor: Actor, invoiceId: string) {
    const response = await this.request('POST', `/invoices/${invoiceId}/checkout`, { actor, body: { gateway: 'epay' } }); // 下单前先登记支付渠道
    expect(response, 201);                                         // 本通道只返回URL，不访问网络
    return response;                                               // 调用方继续核对签名和金额
  }

  async stop(process_: ChildProcess) {
    if (process_.exitCode !== null || process_.signalCode !== null) return; // 已停止的进程不重新发送信号
    const exited = new Promise<void>(resolveExit => process_.once('exit', () => resolveExit())); // 先监听，避免错过快速退出
    if (process_.pid) { try { process.kill(-process_.pid, 'SIGTERM'); } catch {} } // 只终止本轮的独立进程组
    await Promise.race([exited, delay(4000, undefined, { ref: false })]);                       // 正常清理给出有限时间
    if (process_.exitCode === null && process_.signalCode === null && process_.pid) {
      try { process.kill(-process_.pid, 'SIGKILL'); } catch {}       // 异常进程也不能留在后台影响下一轮
      await exited;                                               // 确认进程确实退出
    }
  }

  async cleanup() {
    for (const process_ of this.processes.reverse()) await this.stop(process_); // 先停止写入者再销毁数据库
    if (this.cache?.isOpen) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex'); // 与认证协议同一键形状
      const keys = [...this.tokens].map(token => `session:${hash(token)}`); // 清理明确记录的本轮会话
      keys.push(...[...this.addresses, '127.0.0.1', '::ffff:127.0.0.1'].map(value => `login:${hash(value)}`)); // 限流仅在专用DB14清理
      if (keys.length) await this.cache.del(keys);                   // 不执行FLUSHDB，也不碰dev逻辑库
      await this.cache.quit();                                    // 释放专用Redis连接
    }
    if (this.database) await this.database.end();                   // 数据库连接必须先关闭才能删除专用库
    if (this.created) await this.admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); // 只删本轮已创建的预留库
    if (this.admin) await this.admin.end();                         // 同时释放测试互斥锁
    if (this.directory) await rm(this.directory, { recursive: true, force: true }); // 不留下临时构建产物
  }
}

function expect(response: Reply, status: number) {
  assert.equal(response.status, status, `预期HTTP ${status}，收到${response.status}：${response.status >= 400 ? response.text : '成功响应'}`); // 不在失败输出中打印会话或签名URL
}

// --- 从真实HTTP操作一直验证到资金表和跨语言审计 ---
test('狐岚云业务集成：账号、订单、支付、交付、续费、工单、审计', { timeout: 240_000 }, async context => {
  const fixture = new Fixture();                                  // 所有资源归同一清理范围
  let alice!: Actor, bob!: Actor, admin!: Actor;                     // 两个客户与管理员保持权限分离
  let paid: any, paidProduct: any;                                 // 主支付与续费场景共享真实业务对象
  try {
    await fixture.start();                                         // 独立API、独立数据库与专用Redis就绪
    await context.test('注册登录、会话属性、权限与请求来源', async () => {
      expect(await fixture.request('POST', '/auth/register', { body: { email: 'bad', password: 'short', name: ' ' } }), 400); // 错误输入在哈希前拒绝
      alice = await fixture.register('alice');                      // 客户A拥有自己的真实会话
      bob = await fixture.register('bob');                          // 客户B用于越权与并发验证
      admin = await fixture.register('admin');                      // 角色只在隔离测试夹具里提升
      await fixture.database.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]); // 不借用dev管理员凭据
      expect(await fixture.request('GET', '/auth/me'), 401);          // 私有入口拒绝匿名
      expect(await fixture.request('GET', '/admin/overview', { actor: alice }), 403); // 普通客户不能访问后台
      expect(await fixture.request('POST', '/admin/products', { actor: admin, origin: 'https://attacker.invalid', body: {} }), 403); // Cookie写操作核对Origin
      expect(await fixture.request('POST', '/auth/login', { body: { email: alice.email, password: `${password}-wrong` } }), 401); // 错密码不签发会话
      const login = await fixture.request('POST', '/auth/login', { body: { email: alice.email.toUpperCase(), password } }); // 邮箱规范化后仍能登录
      expect(login, 201);                                          // 不能把账号不存在暴露成不同错误
      assert.equal(login.body.id, alice.id);                        // 登录指向原账号而非新建账户
      const me = await fixture.request('GET', '/auth/me', { actor: alice }); // 私有数据有缓存边界
      expect(me, 200);                                             // 真实会话可读取自己的资料
      assert.match(me.headers.get('cache-control') ?? '', /private.*no-store/); // 私有响应不能进CDN共享缓存
      const unknownRole = await fixture.request('POST', '/auth/register', { body: { email: 'role@test.invalid', password, name: 'role', role: 'admin' } }); // 注册禁止自报管理员角色
      expect(unknownRole, 400);                                    // 严格输入拒绝特权字段
    });

    await context.test('公开登录核对JSON、来源与Fetch Metadata，允许无Origin的CLI', async () => {
      expect(await fixture.request('POST', '/auth/login', { origin: 'https://attacker.invalid', body: { email: alice.email, password } }), 403); // Public元数据不会绕过来源检查
      expect(await fixture.request('POST', '/auth/login', { origin: null, fetchSite: 'cross-site', body: { email: alice.email, password } }), 403); // 省略Origin不能绕过浏览器跨站声明
      expect(await fixture.request('POST', '/auth/login', { origin: null, contentType: 'application/x-www-form-urlencoded', raw: new URLSearchParams({ email: alice.email, password }).toString() }), 403); // HTML表单不能替人登录
      expect(await fixture.request('POST', '/auth/login', { origin: null, body: { email: alice.email, password } }), 201); // 受控CLI可用JSON请求登录
    });

    await context.test('下单幂等、同键冲突、跨账号隔离与重复取消退库存', async () => {
      const product = await fixture.product(admin, 3);               // 价格和库存均从后台设置
      const other = await fixture.product(admin, 3);                 // 同键不同商品应明确冲突
      const key = randomUUID();                                    // 同一次用户操作共享标识
      const requests = await Promise.all(Array.from({ length: 10 }, () => fixture.order(alice, product.id, key))); // 真正并发重复提交
      for (const response of requests) expect(response, 201);         // 所有合法重试返回同一业务结果
      const order = requests[0].body;                              // 后续核对真实订单关系
      assert.equal(new Set(requests.map(response => response.body.id)).size, 1); // 不生成第二个订单
      assert.equal((await fixture.database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, 2); // 同键只预占一次库存
      assert.equal(order.amountCents, '1099');                      // 客户不能影响固定成交价
      expect(await fixture.order(alice, other.id, key), 409);         // 幂等键不能换商品复用
      expect(await fixture.request('GET', `/invoices/${order.invoiceId}`, { actor: bob }), 404); // 不能探测别人账单
      expect(await fixture.request('POST', `/invoices/${order.invoiceId}/checkout`, { actor: bob, body: { gateway: 'epay' } }), 404); // 不能替别人创建私有收银台
      expect(await fixture.request('POST', `/orders/${order.id}/cancel`, { actor: bob }), 404); // 不能取消他人订单
      expect(await fixture.request('POST', `/orders/${order.id}/cancel`, { actor: alice, origin: null }), 403); // 缺少来源也不能写Cookie业务
      expect(await fixture.request('POST', `/orders/${order.id}/cancel`, { actor: alice }), 201); // 首次取消释放库存
      expect(await fixture.request('POST', `/orders/${order.id}/cancel`, { actor: alice }), 201); // 重复取消不重复释放
      assert.equal((await fixture.database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, 3); // 库存恢复到原值
      assert.equal((await fixture.request('GET', `/invoices/${order.invoiceId}`, { actor: alice })).body.status, 'cancelled'); // 账单与订单一起取消
      expect(await fixture.request('POST', `/invoices/${order.invoiceId}/checkout`, { actor: alice, body: { gateway: 'epay' } }), 409); // 取消后不能生成新付款链接
    });

    await context.test('不同用户并发购买不会超卖', async () => {
      const product = await fixture.product(admin, 2);               // 供给小于同时到达的请求数
      const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => fixture.order(index % 2 ? alice : bob, product.id))); // 账号不共享幂等键锁
      assert.equal(responses.filter(response => response.status === 201).length, 2); // 只允许两笔订单成交预占
      assert.equal(responses.filter(response => response.status === 409).length, 10); // 其余明确售罄，不返回系统故障
      assert.equal((await fixture.database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, 0); // 库存绝不变成负数
      for (const response of responses.filter(response => response.status === 201)) {
        const owner = (await fixture.database.query('SELECT user_id FROM orders WHERE id=$1', [response.body.id])).rows[0].user_id; // 取消使用对应客户身份
        expect(await fixture.request('POST', `/orders/${response.body.id}/cancel`, { actor: owner === alice.id ? alice : bob }), 201); // 两个预占都可以正确退回
      }
      assert.equal((await fixture.database.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, 2); // 不多退也不少退
    });

    await context.test('真实易支付签名、错误通知与并发重放只入账一次', async () => {
      paidProduct = await fixture.product(admin, 5);                 // 使用隔离人工供应商，不调用云平台
      const created = await fixture.order(alice, paidProduct.id);    // 从正常订单入口取得账单
      expect(created, 201);                                       // 不能直接伪造已支付数据库行
      paid = created.body;                                        // 后续付款、交付和续费共享这条资源
      const checkout = await fixture.checkout(alice, paid.invoiceId); // 只生成HTTPS签名URL，不访问外部网关
      const url = new URL(checkout.body.url);                      // 独立核对订单下单字段
      assert.equal(url.origin, 'https://pay.example.invalid');      // 测试不会触达真实收款商户
      assert.equal(url.searchParams.get('money'), '10.99');          // 原价以整数分准确转换
      assert.equal(url.searchParams.get('out_trade_no'), paid.invoiceId.replaceAll('-', '')); // 外部单号固定可回溯
      assert.equal(url.searchParams.get('notify_url'), `${origin}/api/v1/payments/epay/notify`); // 客户不能自行指定回调地址
      const signed = Object.fromEntries(url.searchParams);          // 核对签名前字段的排序规则
      const canonical = Object.keys(signed).sort().filter(name => !['sign', 'sign_type'].includes(name) && signed[name] !== '').map(name => `${name}=${signed[name]}`).join('&'); // 不调用被测实现
      assert.equal(signed.sign, createHash('md5').update(canonical + fixture.paymentKey).digest('hex')); // URL签名符合V1协议
      const query = fixture.callback(paid.invoiceId, paid.amountCents, 'main-fixture-transaction'); // 协议真实签名，不开放模拟付款端点
      expect(await fixture.notify(query.replace(/sign=[^&]+/, `sign=${'0'.repeat(32)}`)), 400); // 错签名不入账
      expect(await fixture.notify(`${query}&money=10.99`), 400);       // 重复字段不能覆盖验签金额
      expect(await fixture.notify(fixture.callback(paid.invoiceId, '1')), 400); // 正确签名也不能改变应付金额
      expect(await fixture.notify(fixture.callback(paid.invoiceId, paid.amountCents, 'wrong-merchant', { pid: 'another-merchant' })), 400); // 商户身份独立核对
      expect(await fixture.notify(fixture.callback(paid.invoiceId, paid.amountCents, 'not-paid', { trade_status: 'WAIT_BUYER_PAY' })), 400); // 非成功交易不产生分录
      expect(await fixture.request('POST', '/payments/epay/notify', { origin: null, raw: `${query}&money=10.99`, contentType: 'application/x-www-form-urlencoded' }), 400); // 原始POST表单同样拒绝重复字段
      assert.equal((await fixture.database.query('SELECT count(*)::int AS count FROM payment_receipts')).rows[0].count, 0); // 错误输入全部在资金写入前失败
      const repeated = await Promise.all(Array.from({ length: 12 }, () => fixture.notify(query))); // 机构可并发重复投递同一通知
      for (const response of repeated) { expect(response, 200); assert.equal(response.text, 'success'); } // 只有事务提交后返回渠道成功回执
      const postReplay = await fixture.request('POST', '/payments/epay/notify', { origin: null, raw: query, contentType: 'application/x-www-form-urlencoded' }); // 原始POST表单也通过真实验签
      expect(postReplay, 200); assert.equal(postReplay.text, 'success'); // 更换投递方式不能重复入账
      const counts = await fixture.database.query('SELECT (SELECT count(*)::int FROM payment_receipts WHERE invoice_id=$1) AS receipts,(SELECT count(*)::int FROM jobs WHERE service_id=$2) AS jobs', [paid.invoiceId, paid.serviceId]); // 入账和outbox一起核对
      assert.deepEqual(counts.rows[0], { receipts: 1, jobs: 1 });     // 正好一笔收款与一条开通任务
      const entries = await fixture.database.query('SELECT count(*)::int AS count,sum(e.amount_cents)::text AS total FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id JOIN payment_receipts r ON r.id=t.receipt_id WHERE r.invoice_id=$1', [paid.invoiceId]); // 真正检查数据库双分录
      assert.deepEqual(entries.rows[0], { count: 2, total: '0' });    // 没有浮点残差和单边入账
      await assert.rejects(fixture.database.query("UPDATE payment_receipts SET amount_cents=1 WHERE invoice_id=$1", [paid.invoiceId]), /只能追加/); // 资金事实不可改写
      await assert.rejects(fixture.database.query("UPDATE ledger_entries SET amount_cents=1"), /只能追加/); // 分录不可改写
      await assert.rejects(fixture.database.query("INSERT INTO ledger_entries(transaction_id,account,amount_cents) SELECT id,'unbalanced-test',1 FROM ledger_transactions LIMIT 1"), /借贷不平衡/); // 数据库延迟约束守住不平衡写入
      expect(await fixture.notify(fixture.callback(paid.invoiceId, paid.amountCents, 'another-real-transaction')), 409); // 第二笔不同交易不能结清同账单
      expect(await fixture.request('POST', `/orders/${paid.id}/cancel`, { actor: alice }), 409); // 付款后取消不能释放已售库存
      expect(await fixture.request('POST', `/invoices/${paid.invoiceId}/checkout`, { actor: alice, body: { gateway: 'epay' } }), 409); // 已结清账单不重复下单
      const spareProduct = await fixture.product(admin, 1);       // 独立账单检验渠道发起和交易号的绑定
      const spare = await fixture.order(bob, spareProduct.id);      // 仍走正常下单，不能伪造invoice关系
      expect(spare, 201);                                        // 新账单尚无收银台发起记录
      expect(await fixture.notify(fixture.callback(spare.body.invoiceId, spare.body.amountCents, 'never-started')), 400); // 未发起渠道交易不能认账
      await fixture.checkout(bob, spare.body.invoiceId);           // 登记本账单实际使用的通道
      expect(await fixture.notify(fixture.callback(spare.body.invoiceId, spare.body.amountCents, 'main-fixture-transaction')), 409); // 机构同交易号不能重用到另一账单
      assert.equal((await fixture.database.query('SELECT count(*)::int AS count FROM payment_receipts WHERE invoice_id=$1', [spare.body.invoiceId])).rows[0].count, 0); // 冲突不产生收款或账本
      expect(await fixture.request('POST', `/orders/${spare.body.id}/cancel`, { actor: bob }), 201); // 失败交易不会阻止正常取消
    });

    await context.test('取消和支付争用保持订单、库存、收款与开通一致', async () => {
      for (let round = 0; round < 5; round++) {                     // 重复覆盖两种合法竞争结局
        const product = await fixture.product(admin, 1);           // 每轮独立资源和库存
        const created = await fixture.order(bob, product.id);      // 先正常预占库存
        expect(created, 201);                                     // 竞态不能绕过下单
        const order = created.body;                               // 每轮用新账单避免跨轮重放
        await fixture.checkout(bob, order.invoiceId);              // 渠道必须已登记
        const [cancelled, notified] = await Promise.all([
          fixture.request('POST', `/orders/${order.id}/cancel`, { actor: bob }), fixture.notify(fixture.callback(order.invoiceId, order.amountCents)),
        ]);                                                       // 两个入口真实争用同一数据库订单锁
        assert.ok((cancelled.status === 201 && notified.status === 409) || (cancelled.status === 409 && notified.status === 200), `取消/付款结果异常：${cancelled.status}/${notified.status}`); // 不允许两个都成功或死锁500
        const facts = (await fixture.database.query('SELECT o.status,p.stock,(SELECT count(*)::int FROM payment_receipts WHERE invoice_id=$2) AS receipts,(SELECT count(*)::int FROM jobs WHERE service_id=$3) AS jobs FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=$1', [order.id, order.invoiceId, order.serviceId])).rows[0]; // 用持久状态判断最终效果
        assert.deepEqual(facts, notified.status === 200 ? { status: 'paid', stock: 0, receipts: 1, jobs: 1 } : { status: 'cancelled', stock: 1, receipts: 0, jobs: 0 }); // 副作用必须跟赢家一致
      }
    });

    await context.test('管理员人工交付与续费付款重放不会重复延长期限', async () => {
      const job = (await fixture.database.query('SELECT id FROM jobs WHERE service_id=$1', [paid.serviceId])).rows[0]; // 从真实支付outbox取得任务
      expect(await fixture.request('POST', `/admin/jobs/${job.id}/complete`, { actor: alice, body: { externalId: 'test-resource' } }), 403); // 客户不能代管理员确认交付
      expect(await fixture.request('POST', `/admin/jobs/${job.id}/complete`, { actor: admin, body: {} }), 400); // 不填写真实交付标识不能激活服务
      expect(await fixture.request('POST', `/admin/jobs/${job.id}/complete`, { actor: admin, body: { externalId: 'isolated-fixture-resource' } }), 201); // 只在测试库模拟管理员人工确认
      const active = await fixture.request('GET', `/services/${paid.serviceId}`, { actor: alice }); // 客户页面读取同一业务状态
      expect(active, 200);                                       // 交付后服务可查询
      assert.equal(active.body.status, 'active');                 // 支付本身不会在人工交付前激活资源
      assert.equal(active.body.externalId, 'isolated-fixture-resource'); // 管理员确认的标识确实保存
      expect(await fixture.request('POST', `/admin/jobs/${job.id}/complete`, { actor: admin, body: { externalId: 'different-duplicate' } }), 201); // 重复确认不改原交付结果
      assert.equal((await fixture.request('GET', `/services/${paid.serviceId}`, { actor: alice })).body.externalId, 'isolated-fixture-resource'); // 重放不能换资源
      const oldDue = active.body.dueAt;                           // HTTP日期用于核对付款前页面没有提前延长
      const preciseDue = (await fixture.database.query('SELECT due_at::text AS due FROM services WHERE id=$1', [paid.serviceId])).rows[0].due; // PostgreSQL微秒精度不能从JS毫秒日期反推
      const key = randomUUID();                                  // 同一次续费只生成一张账单
      const renewals = await Promise.all(Array.from({ length: 6 }, () => fixture.request('POST', `/services/${paid.serviceId}/renew`, { actor: alice, key, body: { period: 'month' } }))); // 续费同样需要幂等
      for (const response of renewals) expect(response, 201);        // 合法重试均返回原订单
      assert.equal(new Set(renewals.map(response => response.body.id)).size, 1); // 不生成重复续费订单
      const renewal = renewals[0].body;                           // 付款前到期时间不能变化
      assert.equal((await fixture.request('GET', `/services/${paid.serviceId}`, { actor: alice })).body.dueAt, oldDue); // 未付款不延长
      await fixture.checkout(alice, renewal.invoiceId);            // 复用同一个真实收银流程
      const query = fixture.callback(renewal.invoiceId, renewal.amountCents, 'renewal-fixture-transaction'); // 续费独立渠道交易号
      const receipts = await Promise.all(Array.from({ length: 8 }, () => fixture.notify(query))); // 付款通知可能重复
      for (const response of receipts) expect(response, 200);         // 重复付款确认不能变成系统故障
      const checked = (await fixture.database.query("SELECT due_at=($2::timestamptz+interval '1 month') AS once,(SELECT count(*)::int FROM jobs WHERE service_id=$1) AS jobs FROM services WHERE id=$1", [paid.serviceId, preciseDue])).rows[0]; // 用完整数据库精度核对日历月规则
      assert.deepEqual(checked, { once: true, jobs: 1 });           // 只延长一次，不重复开通或投递首次任务
      assert.equal((await fixture.database.query('SELECT stock FROM products WHERE id=$1', [paidProduct.id])).rows[0].stock, 4); // 续费不额外占库存
    });

    await context.test('工单归属、纯文本、客服回复、关闭与错误输入', async () => {
      expect(await fixture.request('POST', '/tickets', { actor: alice, body: { subject: '  ', message: '  ' } }), 400); // 去空格后检查正文和标题
      const created = await fixture.request('POST', '/tickets', { actor: alice, body: { subject: '隔离验收工单', message: '<script>文本不能被当HTML执行</script>', priority: 'normal' } }); // API保存的是用户纯文本
      expect(created, 201);                                       // 主单和首条说明一起提交
      const id = created.body.id;                                 // 后续所有操作用真实工单ID
      expect(await fixture.request('GET', `/tickets/${id}`, { actor: bob }), 404); // 他人不能读工单正文
      expect(await fixture.request('POST', `/tickets/${id}/replies`, { actor: bob, body: { message: '越权回复' } }), 404); // 他人不能追加回复
      expect(await fixture.request('POST', `/tickets/${id}/close`, { actor: bob }), 404); // 他人不能关单
      expect(await fixture.request('POST', `/tickets/${id}/replies`, { actor: alice, body: { message: '  ' } }), 400); // 空回复不能落库
      const original = await fixture.request('GET', `/tickets/${id}`, { actor: alice }); // 首条说明按原文返回
      assert.equal(original.body.replies[0].message, '<script>文本不能被当HTML执行</script>'); // 不在服务端拼成HTML页面
      expect(await fixture.request('POST', `/tickets/${id}/replies`, { actor: alice, body: { message: '客户补充' } }), 201); // 客户追加后为待处理
      expect(await fixture.request('POST', `/tickets/${id}/replies`, { actor: admin, body: { message: '管理员已答复' } }), 201); // 客服身份由数据库角色决定
      assert.equal((await fixture.request('GET', `/tickets/${id}`, { actor: alice })).body.status, 'answered'); // 客服答复状态可见
      expect(await fixture.request('POST', `/tickets/${id}/close`, { actor: alice }), 201); // 所有者能正常关闭
      const before = (await fixture.database.query('SELECT count(*)::int AS count FROM ticket_replies WHERE ticket_id=$1', [id])).rows[0].count; // 关闭后不能偷偷追加正文
      expect(await fixture.request('POST', `/tickets/${id}/replies`, { actor: admin, body: { message: '关闭后回复' } }), 409); // 客服也遵守关闭边界
      assert.equal((await fixture.database.query('SELECT count(*)::int AS count FROM ticket_replies WHERE ticket_id=$1', [id])).rows[0].count, before); // 拒绝操作没有副作用
      expect(await fixture.request('GET', '/tickets/not-a-uuid', { actor: alice }), 400); // 无效ID属于输入错误
    });

    await context.test('Go消费人工任务、优雅退出和TS/Go共同审计链', async () => {
      const created = await fixture.order(alice, paidProduct.id);    // 再创建一个待人工处理的真实支付任务
      expect(created, 201);                                       // 不在数据库直接塞假的开通成功
      await fixture.checkout(alice, created.body.invoiceId);        // 对应账单先通过真实通道发起
      expect(await fixture.notify(fixture.callback(created.body.invoiceId, created.body.amountCents)), 200); // 形成事务内outbox
      const binary = join(fixture.directory, 'yunzou-agent');        // 构建产物只在临时目录
      await execute('go', ['build', '-o', binary, '.'], { cwd: join(root, 'agent'), timeout: 90_000 }); // 验证实际Go入口而非只调用队列方法
      const consumer = fixture.launch(binary, ['--plugins', join(root, 'agent/plugins'), '--concurrency', '2', '--poll', '100ms']); // 人工插件不访问真实供应商
      await fixture.wait(async () => Boolean((await fixture.database.query("SELECT result->>'manualRequired' AS waiting FROM jobs WHERE service_id=$1", [created.body.serviceId])).rows[0]?.waiting), 'Go未处理人工等待任务'); // 等待实际持久化结果
      await fixture.stop(consumer);                               // 发SIGTERM验证真实进程优雅退出
      assert.equal(consumer.exitCode, 0);                          // 不能靠强杀冒充优雅退出
      const service = (await fixture.database.query('SELECT status FROM services WHERE id=$1', [created.body.serviceId])).rows[0]; // 人工任务不会伪造激活
      assert.equal(service.status, 'provisioning');                // 仍等待管理员交付
      const goAudit = await fixture.database.query("SELECT count(*)::int AS count FROM audit WHERE actor='agent' AND action='job.manual_required'"); // 系统动作也必须入链
      assert.ok(goAudit.rows[0].count >= 1);                        // 日志打印不能代替持久审计
      const result = await verifyAudit(fixture.database, fixture.auditKey); // Node按Go保存的原文字节验HMAC
      assert.ok(result.count > 20 && result.historicalCount === 0);  // 覆盖整轮并发业务产生的完整审计
      const listed = await fixture.request('GET', '/admin/audit', { actor: admin }); // 管理列表按真实数值ID倒序展示
      expect(listed, 200);                                       // 审计查询同样需要管理员身份
      assert.equal(listed.body[0].id, result.lastId);              // 最新一笔应在最前，不按文本9、8、...排序
      for (let index = 1; index < listed.body.length; index++) assert.ok(BigInt(listed.body[index - 1].id) > BigInt(listed.body[index].id)); // 序号超过十也保持正确时间顺序
      const script = await execute(process.execPath, ['--import', 'tsx', join(root, 'scripts/verify-audit.ts')], { cwd: root, env: fixture.environment, timeout: 20_000 }); // 用户可直接运行的CLI也要通过
      assert.equal(JSON.parse(script.stdout).count, result.count);  // CLI不能漏读Go或并发TS记录
      await assert.rejects(verifyAudit(fixture.database, fixture.auditKey, 'f'.repeat(64)), /独立保管的锚点/); // 错尾部锚点不能通过
    });

    await context.test('验链拒绝HMAC原文或查询元数据被篡改', async () => {
      const original = (await fixture.database.query('SELECT id::text,actor,action,target,details,previous_hash,hash,canonical_body FROM audit ORDER BY audit.id LIMIT 1')).rows[0]; // 取真实链首节点做只读扰动
      const copy = (row: unknown) => ({ query: async () => ({ rowCount: 1, rows: [row] }) }) as unknown as pg.Pool; // 不修改受不可变约束保护的真实历史
      await assert.rejects(verifyAudit(copy({ ...original, canonical_body: `${original.canonical_body} ` }), fixture.auditKey), /HMAC无效|HMAC 无效/); // 原文多一个字节也会失效
      await assert.rejects(verifyAudit(copy({ ...original, action: 'forged.action' }), fixture.auditKey), /字段与签名原文不一致/); // 旧签名不能替换查询元数据
    });

    await context.test('退出撤销服务端会话，停用账号即时失效', async () => {
      expect(await fixture.request('POST', '/auth/logout', { actor: bob }), 201); // 客户主动结束会话
      expect(await fixture.request('GET', '/auth/me', { actor: bob }), 401); // Redis令牌即时失效
      await fixture.database.query('UPDATE users SET disabled=true WHERE id=$1', [alice.id]); // 隔离夹具模拟管理员停用
      expect(await fixture.request('GET', '/auth/me', { actor: alice }), 401); // 不用等cookie过期才生效
    });

    await context.test('历史审计无原文时明确报告JSONB排序限制', async () => {
      const initial = (await fixture.database.query('SELECT hash FROM audit ORDER BY id DESC LIMIT 1')).rows[0].hash; // 保留本轮真实链尾
      const stable = JSON.stringify({ actor: 'legacy-fixture', action: 'legacy.stable', target: 'test-only', details: {}, previousHash: initial }); // 空details不受JSONB键排序影响
      const stableHash = createHmac('sha256', fixture.auditKey).update(stable).digest('hex'); // 确实可恢复的历史记录应能验证
      await fixture.database.query('INSERT INTO audit(actor,action,target,details,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6)', ['legacy-fixture', 'legacy.stable', 'test-only', {}, initial, stableHash]); // 模拟未保存canonical_body的旧节点
      assert.equal((await verifyAudit(fixture.database, fixture.auditKey)).historicalCount, 1); // 恢复五字段成功时明确统计历史格式
      const previous = stableHash;                               // 不可恢复样本继续接在合法链尾
      const details = { zzz: 'first-in-old-json', a: 'second-in-old-json' }; // JSONB会改变这个原始插入顺序
      const body = JSON.stringify({ actor: 'legacy-fixture', action: 'legacy.import', target: 'test-only', details, previousHash: previous }); // 模拟003迁移之前签署的五字段原文
      const signature = createHmac('sha256', fixture.auditKey).update(body).digest('hex'); // 原签名本身正确，但原文没有存下
      await fixture.database.query('INSERT INTO audit(actor,action,target,details,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6)', ['legacy-fixture', 'legacy.import', 'test-only', details, previous, signature]); // 仅专用测试库中的边界夹具
      await assert.rejects(verifyAudit(fixture.database, fixture.auditKey), /历史审计记录.*JSONB/); // 不把无法复原的历史字节顺序报告成验证通过
    });
  } finally {
    if (process.env.YUNZOU_TEST_DIAGNOSTICS==='1') context.diagnostic(fixture.logs.split('\n').filter(line=>line.includes('"error":')).join('\n')); // 诊断只显示已脱敏的服务错误
    await fixture.cleanup();                                       // 任一断言失败仍终止进程并删除专用测试资源
  }
});
