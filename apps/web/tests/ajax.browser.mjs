/*
AJAX导航验收：用真实生产Nuxt路由检查页面与表单只更新当前区域，不重载浏览器文档。
调用：先构建并启动前端，再执行 node --test apps/web/tests/ajax.browser.mjs。
WEB_TEST_ORIGIN默认http://127.0.0.1:3300，仅允许本机；PLAYWRIGHT_CHROMIUM_EXECUTABLE可复用已有浏览器。
全部/api/和站外请求严格拦截；测试身份、账单、工单与付款入口只存在于隔离浏览器，不接业务数据库或支付机构。
*/
import test from 'node:test'; // 每个行为拥有独立浏览器和请求记录
import assert from 'node:assert/strict'; // 从真实URL、文档装载次数与可见内容核对结果
import { chromium } from '@playwright/test'; // 使用项目已有浏览器依赖，不下载或修改运行环境

const origin = new URL(process.env.WEB_TEST_ORIGIN || 'http://127.0.0.1:3300');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  throw new Error('AJAX验收只允许本机前端'); // 测试拦截不能误指向正式站点
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const administrator = { id: 'ajax-owner-a', name: 'AJAX甲', email: 'ajax-a@example.invalid', role: 'admin' };
const customer = { id: 'ajax-owner-b', name: 'AJAX乙', email: 'ajax-b@example.invalid', role: 'customer' };
const products = [{ id: 'ajax-product', name: 'AJAX目录项目', description: '仅供拦截式导航验收', priceCents: '2900', currency: 'CNY', stock: 9, active: true, provider: 'manual' }];
const articles = [
  { id: 'ajax-help-a', slug: 'ajax-help-a', kind: 'help', title: 'AJAX帮助甲', content: '第一篇帮助正文', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'ajax-help-b', slug: 'ajax-help-b', kind: 'help', title: 'AJAX帮助乙', content: '第二篇帮助正文', updatedAt: '2026-01-02T00:00:00Z' },
  { id: 'ajax-news', slug: 'ajax-news', kind: 'news', title: 'AJAX最新动态', content: '动态正文', updatedAt: '2026-01-03T00:00:00Z' },
]; // 公开内容也由本次浏览器拦截，不写真实文章
const invoices = ['a', 'b'].map((id, index) => ({ id: `ajax-invoice-${id}`, orderId: `ajax-order-${id}`, number: `AJAX-${index + 1}`, status: 'unpaid', amountCents: index ? '6900' : '2900', currency: 'CNY', productName: `账单产品${index ? '乙' : '甲'}`, createdAt: '2026-01-01T00:00:00Z', dueAt: '2026-02-01T00:00:00Z', payable: true, items: [] }));
const tickets = ['a', 'b'].map((id, index) => ({ id: `ajax-ticket-${id}`, subject: `AJAX工单${index ? '乙' : '甲'}`, status: 'open', createdAt: '2026-01-01T00:00:00Z', replies: [] }));
const reply = (route, json, status = 200) => route.fulfill({ status, json }); // HTTP状态与JSON正文一起进入真实客户端

async function withPage(check, api = async () => false, options = {}) {
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
  const calls = [], unexpected = [], pageErrors = [], outbound = [];
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message))); // 弹出的新标签也不能带未处理异常
  await context.route('**/*', async route => {
    const address = new URL(route.request().url());
    if (address.origin !== origin.origin) {
      if (options.external === address.href) outbound.push(address.href);
      else unexpected.push(`站外请求 ${address.origin}`);
      await route.abort(); // 即使付款链接测试打开了新标签，也不访问机构
      return;
    }
    if (!address.pathname.startsWith('/api/')) return route.continue(); // 仅允许读取本机真实HTML、JS、CSS与图片
    if (address.pathname === '/api/v1/currencies') return route.fulfill({json:[{code:'CNY',name:'人民币',symbol:'¥',decimals:2,active:true,isDefault:true}]}); // 公共币种元数据，不访问真实API
    calls.push({ method: route.request().method(), path: address.pathname, search: address.search });
    if (await api(route, address, calls)) return; // 当前场景的明确边界优先于通用只读夹具
    const path = address.pathname.slice('/api/v1'.length);
    if (path === '/auth/me') return reply(route, administrator);
    if (path === '/products') return reply(route, products);
    if (path === '/catalogue') return reply(route, {groups:[],periods:[{period:'month',months:1,label:'月付'}]});
    if (path === '/fields/ticket') return reply(route, {definitions:[]});
    if (path === '/support/departments') return reply(route, [{id:'ajax-department',name:'客户支持'}]);
    if (['/payments','/oauth/providers','/admin/support/replies'].includes(path)) return reply(route, []);
    if (path === '/wallet') return reply(route, { balanceCents: '0', currency: 'CNY' });
    if (path === '/content') return reply(route, articles.filter(item => item.kind === address.searchParams.get('kind')));
    if (path.startsWith('/content/')) {
      const article = articles.find(item => item.slug === decodeURIComponent(path.slice('/content/'.length)));
      return reply(route, article || { message: '文章不存在' }, article ? 200 : 404);
    }
    if (path === '/overview') return reply(route, { serviceCount: 0, unpaidCount: 2, ticketCount: 2, balanceCents: '0', recentInvoices: invoices, recentServices: [] });
    if (path === '/services') return reply(route, []);
    if (path === '/invoices') return reply(route, invoices);
    if (path.startsWith('/invoices/') && route.request().method() === 'GET') {
      const invoice = invoices.find(item => item.id === path.slice('/invoices/'.length));
      if (invoice) return reply(route, invoice);
    }
    if (path === '/tickets') return reply(route, tickets);
    if (path.startsWith('/tickets/') && route.request().method() === 'GET') {
      const ticket = tickets.find(item => item.id === path.slice('/tickets/'.length));
      if (ticket) return reply(route, ticket);
    }
    if (path === '/admin/overview') return reply(route, { userCount: 2, serviceCount: 0, orderCount: 0, failedJobCount: 0, revenueCents: '0', ticketCount: 0 });
    if (path === '/admin/products') return reply(route, products);
    if (path === '/admin/users') return reply(route, [administrator]);
    if (path === '/admin/receipts' || path === '/admin/refunds') return reply(route, { items: [], total: path.endsWith('/receipts') ? 101 : 0, page: Number(address.searchParams.get('page') || 1), limit: 50 });
    unexpected.push(`${route.request().method()} ${address.pathname}`);
    return reply(route, { message: '未预期的接口已拦截' }, 599); // 绝不让未知业务接口穿过测试边界
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const documents = [];
  page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
  const state = { calls, documents, outbound, context };
  try {
    await check(page, state);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    if (process.env.AJAX_QA_DEBUG) console.error(JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 7000), calls, documents, account: await account(page), processingMiddleware: await page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt._processingMiddleware) })); // 仅调试隔离夹具，无真实身份或凭据
    throw error;
  } finally { await browser.close(); } // 无论成功失败，销毁本轮身份和页面存储
}

async function mark(page) {
  return page.evaluate(() => { window.__yunzouAjaxMarker = crypto.randomUUID(); return window.__yunzouAjaxMarker; });
} // 文档重载会丢失此值，独立于Nuxt组件的挂载与缓存
async function sameDocument(page, state, marker) {
  assert.equal(await page.evaluate(() => window.__yunzouAjaxMarker), marker);
  assert.equal(state.documents.length, 1, `意外装载新文档：${state.documents.join(', ')}`);
}
async function routeTo(page, path) {
  await page.evaluate(path => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push(path), path);
} // 使用生产Vue Router原入口，验证动态params换页而非测试组件替身
async function account(page) {
  return page.evaluate(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.payload.state['$saccount'] ?? null);
} // 只读取既有公开账户状态，不依赖代次、请求序号等修复实现
function gate() {
  let release, start;
  const waiting = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { start = resolve; });
  return { waiting, begun, release, start };
} // 人为延迟响应，重现真实网络先后次序

test('公开站内链接、文章与前进后退只装载一次文档', { timeout: 60000 }, async () => {
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
    await navigation.getByRole('link', { name: '云产品', exact: true }).click();
    await page.getByRole('heading', { name: '找到适合你的云。', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'AJAX目录项目', exact: true }).waitFor();
    await navigation.getByRole('link', { name: '使用帮助', exact: true }).click();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await page.getByRole('button', { name: 'AJAX帮助甲', exact: true }).click();
    await page.getByRole('heading', { name: 'AJAX帮助甲', exact: true, level: 1 }).waitFor();
    await routeTo(page, '/help/ajax-help-b');
    await page.getByRole('heading', { name: 'AJAX帮助乙', exact: true, level: 1 }).waitFor();
    await page.getByRole('link', { name: '返回使用帮助', exact: true }).click();
    await navigation.getByRole('link', { name: '最新动态', exact: true }).click();
    await page.getByRole('heading', { name: '最新动态', exact: true, level: 1 }).waitFor();
    await page.getByRole('button', { name: 'AJAX最新动态', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await page.goForward();
    await page.getByRole('heading', { name: '最新动态', exact: true, level: 1 }).waitFor();
    await routeTo(page, '/help/ajax-absent');
    await page.getByRole('heading', { name: '这页暂时不在这里。', exact: true }).waitFor();
    await page.getByRole('link', { name: '查看使用帮助', exact: true }).click();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await sameDocument(page, state, marker);
  });
});

test('侧栏、动态账单与工单回复通过AJAX更新当前区域', { timeout: 60000 }, async () => {
  const updated = { ...tickets[0], replies: [] };
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    const navigation = page.getByRole('navigation', { name: '工作台导航', exact: true });
    await navigation.getByRole('link', { name: '账单', exact: true }).click();
    await page.getByRole('button', { name: '去付款', exact: true }).first().click();
    await page.getByRole('heading', { name: 'AJAX-1', exact: true, level: 2 }).waitFor(); // 不能误命中上一个列表中同样的编号
    await routeTo(page, '/console/invoices/ajax-invoice-b');
    await page.getByRole('heading', { name: 'AJAX-2', exact: true, level: 2 }).waitFor();
    assert.equal(await page.getByText('AJAX-1', { exact: true }).count(), 0);
    await navigation.getByRole('link', { name: '支持工单', exact: true }).click();
    await page.getByRole('row').filter({ hasText: 'AJAX工单甲' }).getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('heading', { name: 'AJAX工单甲', exact: true }).waitFor();
    await page.getByLabel('补充回复', { exact: true }).fill('AJAX补充说明');
    await page.getByRole('button', { name: '发送回复', exact: true }).click();
    await page.getByText('AJAX补充说明', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('补充回复', { exact: true }).inputValue(), '');
    await routeTo(page, '/console/tickets/ajax-ticket-b');
    await page.getByRole('heading', { name: 'AJAX工单乙', exact: true }).waitFor();
    assert.equal(await page.getByText('AJAX补充说明', { exact: true }).count(), 0);
    await sameDocument(page, state, marker);
  }, async (route, address) => {
    if (address.pathname === '/api/v1/tickets/ajax-ticket-a/replies') {
      assert.deepEqual(route.request().postDataJSON(), { message: 'AJAX补充说明', internal:false, attachmentIds:[] });
      updated.replies.push({ id: 'ajax-reply', message: 'AJAX补充说明', content: 'AJAX补充说明', role: 'customer', authorName: administrator.name, createdAt: '2026-01-02T00:00:00Z' });
      await reply(route, { ok: true }); return true;
    }
    if (address.pathname === '/api/v1/tickets/ajax-ticket-a') { await reply(route, updated); return true; }
    return false;
  });
});

test('后台AJAX切tab回到第一页，旧清单慢回包不能覆盖当前tab', { timeout: 60000 }, async () => {
  const slow = gate();
  try {
    await withPage(async (page, state) => {
      await page.goto(origin.origin + '/admin?tab=receipts', { waitUntil: 'networkidle' });
      const marker = await mark(page);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByText('共 101 条 · 第 2 页', { exact: true }).waitFor();
      const navigation = page.getByRole('navigation', { name: '管理功能', exact: true });
      await navigation.getByRole('link', { name: '退款', exact: true }).click();
      await page.getByText('共 0 条 · 第 1 页', { exact: true }).waitFor();
      assert.equal(state.calls.filter(call => call.path === '/api/v1/admin/refunds').every(call => new URLSearchParams(call.search).get('page') === '1'), true);
      await navigation.getByRole('link', { name: '产品', exact: true }).click();
      await slow.begun;
      await navigation.getByRole('link', { name: '客户', exact: true }).click();
      await page.getByRole('row').filter({ hasText: administrator.email }).waitFor();
      slow.release();
      await page.waitForTimeout(100);
      assert.equal(await page.getByText('AJAX慢产品回包', { exact: true }).count(), 0);
      await sameDocument(page, state, marker);
    }, async (route, address) => {
      if (address.pathname === '/api/v1/admin/products') {
        slow.start(); await slow.waiting;
        await reply(route, [{ ...products[0], name: 'AJAX慢产品回包' }]); return true;
      }
      return false;
    });
  } finally { slow.release(); }
});

test('手机公共菜单与工作台抽屉在AJAX换页和同页点击后关闭', { timeout: 60000 }, async () => {
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '云上导航', exact: true });
    if (!await dialog.count()) dialog = page.getByRole('dialog').filter({ has: page.getByRole('navigation', { name: '手机主导航', exact: true }) });
    await dialog.getByRole('link', { name: '使用帮助', exact: true }).click();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: '使用帮助', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '控制台', exact: true }).click();
    await page.getByRole('heading', { name: /./, level: 1 }).waitFor();
    await page.getByRole('button', { name: '更多导航', exact: true }).click();
    const workspace = page.getByRole('dialog', { name: '我的空间', exact: true });
    await workspace.getByRole('link', { name: '使用帮助', exact: true }).click();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await workspace.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await sameDocument(page, state, marker);
  }, undefined, { viewport: { width: 390, height: 844 } });
});

test('Ctrl和中键仍按真实href打开新标签，付款链接保留站外新窗口语义', { timeout: 60000 }, async () => {
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    const link = page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '云产品', exact: true });
    assert.equal(await link.getAttribute('href'), '/products');
    for (const click of [{ modifiers: ['ControlOrMeta'] }, { button: 'middle' }]) {
      const opened = state.context.waitForEvent('page'); // Ctrl/中键的浏览器新标签可能没有window.opener，不只等待脚本popup
      await link.click(click);
      const popup = await opened;
      await popup.waitForURL(origin.origin + '/products');
      assert.equal(page.url(), origin.origin + '/');
      await popup.close();
    }
    await sameDocument(page, state, marker);
  });
  const external = 'https://ajax-gateway.example.invalid/checkout';
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/console/invoices/ajax-invoice-a', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    await page.getByRole('button', { name: '确认金额，去付款', exact: true }).click();
    const payment = page.getByRole('link', { name: '打开付款页面', exact: true });
    await payment.waitFor();
    assert.equal(await payment.getAttribute('target'), '_blank');
    assert.match(await payment.getAttribute('rel'), /noopener/);
    const opened = state.context.waitForEvent('page');
    await payment.click();
    const popup = await opened;
    await page.waitForTimeout(100);
    assert.deepEqual(state.outbound, [external]); // 只记录请求并阻断，没有向机构出站
    await popup.close();
    await sameDocument(page, state, marker);
  }, async (route, address) => {
    if (address.pathname === '/api/v1/payments') { await reply(route, [{ id: 'ajax-gateway', name: 'AJAX测试渠道', enabled: true, configured: true }]); return true; }
    if (address.pathname === '/api/v1/invoices/ajax-invoice-a/checkout') { assert.deepEqual(route.request().postDataJSON(), { gateway: 'ajax-gateway' }); await reply(route, { url: external }); return true; }
    return false;
  }, { external });
});

test('旧身份读取晚于注销返回，不能让已退出的账户重新出现', { timeout: 60000 }, async () => {
  const old = gate(); let reads = 0;
  try {
    await withPage(async (page, state) => {
      await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
      const marker = await mark(page);
      assert.equal((await account(page))?.id, administrator.id); // 先证明观察到真实身份，不把缺少state键误当成功注销
      await page.evaluate(() => { document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/console/services'); });
      await old.begun;
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.waitForURL(origin.origin + '/');
      assert.equal(await account(page), null);
      old.release();
      await page.waitForTimeout(100);
      assert.equal(await account(page), null);
      assert.equal(page.url(), origin.origin + '/');
      await sameDocument(page, state, marker);
    }, async (route, address) => {
      if (address.pathname === '/api/v1/auth/me') { if (++reads === 2) { old.start(); await old.waiting; } await reply(route, administrator); return true; }
      if (address.pathname === '/api/v1/auth/logout') { await reply(route, { ok: true }); return true; }
      return false;
    });
  } finally { old.release(); }
});

test('旧身份晚于新注册返回时，仍保留新账户与同一浏览器文档', { timeout: 60000 }, async () => {
  const old = gate(); let reads = 0, registered = false;
  try {
    await withPage(async (page, state) => {
      await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
      const marker = await mark(page);
      assert.equal((await account(page))?.id, administrator.id);
      await page.evaluate(() => { document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/console/services'); });
      await old.begun;
      await routeTo(page, '/register');
      await page.getByLabel('怎么称呼你', { exact: true }).fill(customer.name);
      await page.getByLabel('邮箱', { exact: true }).fill(customer.email);
      await page.getByLabel('设置密码', { exact: true }).fill('AJAX-only-password');
      await page.getByRole('button', { name: '创建账户', exact: true }).click();
      await page.waitForURL(origin.origin + '/console');
      await page.getByText(customer.name, { exact: true }).waitFor();
      old.release();
      await page.waitForTimeout(100);
      assert.equal((await account(page))?.id, customer.id);
      assert.equal(page.url(), origin.origin + '/console');
      await sameDocument(page, state, marker);
    }, async (route, address) => {
      if (address.pathname === '/api/v1/auth/me') {
        if (++reads === 2) { old.start(); await old.waiting; await reply(route, administrator); }
        else await reply(route, registered ? customer : administrator);
        return true;
      }
      if (address.pathname === '/api/v1/auth/register') {
        assert.deepEqual(route.request().postDataJSON(), { name: customer.name, email: customer.email, password: 'AJAX-only-password' });
        registered = true; await reply(route, { ok: true }); return true;
      }
      return false;
    });
  } finally { old.release(); }
});

test('旧401晚于新登录返回，不能清空新账户或跳回登录页', { timeout: 60000 }, async () => {
  const old = gate(); let reads = 0, signedIn = false;
  try {
    await withPage(async (page, state) => {
      await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
      const marker = await mark(page);
      await page.evaluate(() => { document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$router.push('/console/services'); });
      await old.begun;
      await routeTo(page, '/login');
      await page.getByLabel('邮箱', { exact: true }).fill(customer.email);
      await page.getByLabel('密码', { exact: true }).fill('AJAX-only-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL(origin.origin + '/console');
      await page.getByText(customer.name, { exact: true }).waitFor();
      old.release();
      await page.waitForTimeout(100);
      assert.equal((await account(page))?.id, customer.id);
      assert.equal(page.url(), origin.origin + '/console');
      await sameDocument(page, state, marker);
    }, async (route, address) => {
      if (address.pathname === '/api/v1/auth/me') {
        if (++reads === 2) { old.start(); await old.waiting; await reply(route, { message: '旧会话已过期' }, 401); }
        else await reply(route, signedIn ? customer : administrator);
        return true;
      }
      if (address.pathname === '/api/v1/auth/login') { signedIn = true; await reply(route, { ok: true }); return true; }
      return false;
    });
  } finally { old.release(); }
});

test('最新身份401清理当前账户，网络故障仍保留已知身份和注销失败信息', { timeout: 60000 }, async () => {
  let reads = 0;
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    await routeTo(page, '/console/services');
    await page.waitForURL(/\/login\?next=/);
    assert.equal(await account(page), null);
    await sameDocument(page, state, marker);
  }, async (route, address) => {
    if (address.pathname === '/api/v1/auth/me') { await reply(route, ++reads === 1 ? administrator : { message: '会话已过期' }, reads === 1 ? 200 : 401); return true; }
    return false;
  });
  reads = 0;
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/console', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    await routeTo(page, '/console/services');
    await page.getByRole('heading', { name: '我的服务', exact: true }).waitFor();
    assert.equal((await account(page))?.id, administrator.id);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByText('本次网络故障', { exact: true }).waitFor();
    assert.equal((await account(page))?.id, administrator.id);
    assert.equal(page.url(), origin.origin + '/console/services');
    await sameDocument(page, state, marker);
  }, async (route, address) => {
    if (address.pathname === '/api/v1/auth/me') { await reply(route, ++reads === 1 ? administrator : { message: '本次网络故障' }, reads === 1 ? 200 : 503); return true; }
    if (address.pathname === '/api/v1/auth/logout') { await reply(route, { message: '本次网络故障' }, 503); return true; }
    return false;
  });
});

test('浏览器后退恢复原滚动，长工单AJAX回复不卸载正文或跳回顶部', { timeout: 60000 }, async () => {
  await withPage(async (page, state) => {
    await page.goto(origin.origin + '/products', { waitUntil: 'networkidle' });
    const marker = await mark(page);
    const link = page.locator('footer').getByRole('link', { name: '使用帮助', exact: true });
    await link.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    assert.ok(before > 300, `长页面没有形成有效滚动：${before}`);
    await page.waitForTimeout(50); // 让浏览器把当前位置记入history状态
    await link.click();
    await page.getByRole('heading', { name: '使用帮助', exact: true, level: 1 }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: '找到适合你的云。', exact: true }).waitFor();
    await page.waitForFunction(before => Math.abs(scrollY - before) < 4, before);
    await sameDocument(page, state, marker);
  }, async (route, address) => {
    if (address.pathname === '/api/v1/products') { await reply(route, Array.from({ length: 8 }, (_, index) => ({ ...products[0], id: `ajax-long-product-${index}`, name: `AJAX长目录${index}` }))); return true; }
    return false;
  });
  const refresh = gate(); let reads = 0;
  const ticket = { ...tickets[0], replies: Array.from({ length: 8 }, (_, index) => ({ id: `ajax-history-${index}`, role: 'customer', authorName: administrator.name, message: Array.from({ length: 12 }, (_, line) => `历史上下文${index + 1}・第${line + 1}行，用于实际滚动验收。`).join('\n'), createdAt: '2026-01-01T00:00:00Z' })) };
  try {
    await withPage(async (page, state) => {
      await page.goto(origin.origin + '/console/tickets/ajax-ticket-a', { waitUntil: 'networkidle' });
      const marker = await mark(page);
      await page.getByLabel('补充回复', { exact: true }).fill('长工单AJAX补充');
      const button = page.getByRole('button', { name: '发送回复', exact: true });
      await button.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      assert.ok(before > 500);
      const response = page.waitForResponse(item => item.url().endsWith('/tickets/ajax-ticket-a') && item.request().method() === 'GET');
      try {
        await button.click();
        await refresh.begun;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); // pending应已经进入实际布局
        const during = await page.evaluate(() => scrollY);
        const headings = await page.getByRole('heading', { name: 'AJAX工单甲', exact: true }).count();
        if (process.env.AJAX_QA_DEBUG) console.error(JSON.stringify({ phase: 'long-ticket-refresh', before, during, headings }));
        assert.equal(headings, 1, '同工单刷新卸载了已有正文');
        assert.ok(during >= before - 80, `同工单刷新把滚动位置从${before}夹回${during}`);
      } finally { refresh.release(); await response.catch(() => undefined); }
      await page.getByText('长工单AJAX补充', { exact: true }).waitFor();
      assert.ok(await page.evaluate(() => scrollY) >= before - 80);
      await sameDocument(page, state, marker);
    }, async (route, address) => {
      if (address.pathname === '/api/v1/tickets/ajax-ticket-a/replies') { ticket.replies.push({ id: 'ajax-history-last', message: '长工单AJAX补充', role: 'customer', createdAt: '2026-01-02T00:00:00Z' }); await reply(route, { ok: true }); return true; }
      if (address.pathname === '/api/v1/tickets/ajax-ticket-a') { if (++reads > 1) { refresh.start(); await refresh.waiting; } await reply(route, ticket); return true; }
      return false;
    });
  } finally { refresh.release(); }
});
