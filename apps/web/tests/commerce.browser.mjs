/*
本机真实商务验收：创建标记明确的免费manual商品与测试账号，核对购物车、账单与资源全生命周期。
调用：加载本机.env并启动API/Go/前端后，node apps/web/tests/commerce.browser.mjs。
PLAYWRIGHT_CHROMIUM_EXECUTABLE可复用已有浏览器；只允许127.0.0.1:3300，不接真实支付机构。
测试产品结束后下架，订单、服务、人工验收记录保留审计；不会修改管理员的MFA或密码。
*/
import assert from 'node:assert/strict'; // 成交事实均通过真实API核对
import { mkdir } from 'node:fs/promises'; // 截图留在项目验收目录
import { fileURLToPath } from 'node:url'; // 不依赖启动时的工作目录
import { chromium } from '@playwright/test'; // 浏览器不注入商品或交易演示数据

process.loadEnvFile(new URL('../../../.env', import.meta.url)); // 管理员凭据只在测试进程内使用
const origin = 'http://127.0.0.1:3300'; // 本文件只为本机联调设计
const artifacts = fileURLToPath(new URL('../../../artifacts/', import.meta.url)); // 所有截图可供人工复核
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const administrator = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const customer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const admin = await administrator.newPage();
const page = await customer.newPage(); // 客户与管理员使用完全独立的cookie
const pageErrors = [];
for (const target of [admin, page]) target.on('pageerror', error => pageErrors.push(error.message)); // 浏览器异常不能算验收成功
let product;
let productName = `本地验收·云上练习-${Date.now()}`; // 不把验收商品当作正式资源出售

async function api(target, path, options = {}) {
  const response = await target.request.fetch(`${origin}/api/v1${path}`, { ...options, headers: { Origin: origin, ...options.headers } }); // 同源CSRF检查与真实浏览器一致
  const body = await response.json();
  assert.ok(response.ok(), `${path}: ${response.status()} ${body.message || ''}`); // 错误中不打印密码和会话
  return body;
}

async function screenshot(name) {
  await page.waitForLoadState('networkidle'); // 等真实API与本地字体稳定
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode()))); // async解码的云狐也必须真正准备好才留图
  await page.mouse.move(0, 0); // 截图不保留鼠标悬停状态
  await page.waitForTimeout(1100); // KIMA主题插值结束后再留图，不能把中间色当最终配色
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}整页横向溢出`);
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: name.includes('home') || page.viewportSize().width > 767, animations: 'disabled' }); // 手机业务页保留真实视口与固定底栏，首页可看完整布局
}

async function complete(job, externalId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = (await api(admin, '/admin/jobs')).find(item => item.id === job.id); // 等Go让出manual任务租约
    if (current.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await admin.goto(`${origin}/admin?tab=jobs`);
  const row = admin.getByRole('row').filter({ hasText: job.id }); // 对准当前任务而不是同名产品
  await row.getByLabel(job.action === 'provision' ? '已交付的资源标识' : '实际处理说明', { exact: true }).fill(job.action === 'provision' ? externalId : '本地manual验收资源已完成此动作；不连接外部供应商。');
  const response = admin.waitForResponse(r => r.url().endsWith(`/jobs/${job.id}/complete`) && r.request().method() === 'POST');
  await row.getByRole('button', { name: ({ provision: '确认服务已开通', suspend: '确认服务已暂停', resume: '确认服务已恢复', terminate: '确认服务已终止' })[job.action], exact: true }).click();
  assert.ok((await response).ok()); // 人工验收有明确本地事实说明
  await row.getByText('已完成', { exact: true }).waitFor();
}

try {
  await admin.goto(`${origin}/login`);
  await admin.getByLabel('邮箱', { exact: true }).fill(process.env.BOOTSTRAP_EMAIL);
  await admin.getByLabel('密码', { exact: true }).fill(process.env.BOOTSTRAP_PASSWORD);
  await admin.getByRole('button', { name: '登录', exact: true }).click();
  await admin.waitForURL('**/console'); // 管理员只用于本地验收，不启用MFA
  await admin.goto(`${origin}/admin?tab=products`);
  await admin.getByRole('button', { name: '创建产品', exact: true }).click();
  await admin.getByLabel('产品名称', { exact: true }).fill(productName);
  await admin.getByLabel('月付价格（CNY）', { exact: true }).fill('0.00'); // 实测普通人按元创建免费方案
  await admin.getByLabel('库存数量', { exact: true }).fill('8');
  await admin.getByLabel('产品说明', { exact: true }).fill('本地界面验收专用，人工记录的测试资源；不连接真实供应商。');
  await admin.getByRole('button', { name: '保存产品', exact: true }).click();
  await admin.getByRole('dialog', { name: '创建产品', exact: true }).waitFor({ state: 'hidden' });
  product = (await api(admin, '/admin/products')).find(item => item.name === productName);
  assert.equal(product.priceCents, '0');
  const paidProduct = (await api(admin, '/products')).find(item => item.priceCents !== '0' && item.stock !== 0);
  assert.ok(paidProduct, '验收需要一个已有的付费商品，只创建未付款账单，不实际付钱');

  await page.goto(`${origin}/register`);
  await page.getByLabel('怎么称呼你', { exact: true }).fill('验收旅人');
  await page.getByLabel('邮箱', { exact: true }).fill(`commerce-${Date.now()}@example.test`);
  await page.getByLabel('设置密码', { exact: true }).fill(`Local-test-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: '创建账户', exact: true }).click();
  await page.waitForURL('**/console');
  await page.goto(`${origin}/products`);
  await page.locator('.product-card').filter({ hasText: productName }).getByRole('button', { name: '加入购物车', exact: true }).click();
  await page.waitForURL('**/console/cart');
  const quantityUpdated = page.waitForResponse(r => r.url().endsWith('/api/v1/cart') && r.request().method() === 'GET');
  await page.getByRole('button', { name: '增加数量', exact: true }).click();
  await quantityUpdated;
  await page.goto(`${origin}/products`);
  await page.locator('.product-card').filter({ hasText: paidProduct.name }).getByRole('button', { name: '加入购物车', exact: true }).click();
  await page.waitForURL('**/console/cart');
  await page.getByRole('heading', { name: '核对订单', exact: true }).waitFor();
  const cart = await api(page, '/cart');
  assert.equal(cart.items.length, 2);
  assert.equal(cart.items.find(item => item.productId === product.id).quantity, 2);
  assert.equal(cart.amountCents, paidProduct.priceCents);
  await screenshot('kima-cart-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('kima-cart-mobile');
  await page.getByRole('button', { name: '确认，创建订单', exact: true }).click();
  await page.waitForURL('**/console/invoices/**');
  const invoiceId = page.url().split('/').at(-1);
  const invoice = await api(page, `/invoices/${invoiceId}`);
  assert.equal(invoice.items.length, 2);
  assert.equal(invoice.itemCount, 3);
  assert.equal(invoice.status, 'unpaid');
  await page.getByRole('heading', { name: '购买明细', exact: true }).waitFor();
  await screenshot('kima-invoice-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot('kima-invoice-desktop');

  await page.goto(`${origin}/products`);
  await page.locator('.product-card').filter({ hasText: productName }).getByRole('button', { name: '加入购物车', exact: true }).click();
  await page.waitForURL('**/console/cart');
  const freeQuantityUpdated = page.waitForResponse(r => r.url().endsWith('/api/v1/cart') && r.request().method() === 'GET');
  await page.getByRole('button', { name: '增加数量', exact: true }).click();
  await freeQuantityUpdated;
  const freeCheckout = page.waitForResponse(r => r.url().endsWith('/api/v1/cart/checkout') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '确认，创建订单', exact: true }).click();
  await page.waitForURL('**/console/services'); // 免费订单真实paid，不生成现金收款
  const freeOrder = await (await freeCheckout).json();
  assert.equal(freeOrder.status, 'paid');
  assert.equal(freeOrder.amountCents, '0');
  const services = (await api(page, '/services')).filter(item => freeOrder.serviceIds.includes(item.id)); // 待付款订单也有待交付记录，只验收本次免费订单的资源
  assert.equal(services.length, 2);
  for (const service of services) {
    const job = (await api(admin, '/admin/jobs')).find(item => item.serviceId === service.id && item.action === 'provision');
    assert.ok(job);
    await complete(job, `local-ui-qa-${service.id}`);
  }
  const selected = services[0];
  for (const action of ['suspend', 'resume', 'terminate']) {
    const label = ({ suspend: '暂停服务', resume: '恢复服务', terminate: '终止服务' })[action];
    await admin.goto(`${origin}/admin?tab=services`);
    const row = admin.getByRole('row').filter({ hasText: selected.id.slice(0, 8) });
    await row.getByRole('button', { name: label, exact: true }).click();
    const dialog = admin.getByRole('alertdialog', { name: `确认${label}？`, exact: true });
    await dialog.getByLabel('操作原因', { exact: true }).fill('本地界面全生命周期验收，仅操作本次创建的manual测试资源。');
    await dialog.getByLabel('当前管理员密码', { exact: true }).fill(process.env.BOOTSTRAP_PASSWORD);
    const response = admin.waitForResponse(r => r.url().endsWith(`/services/${selected.id}/actions`) && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: `确认${label}`, exact: true }).click();
    const result = await (await response).json();
    assert.ok(result.id);
    await dialog.waitFor({ state: 'hidden' });
    if (action === 'terminate') {
      await page.goto(`${origin}/console/services`);
      assert.equal(await page.getByRole('row').filter({ hasText: selected.id.slice(0, 8) }).getByRole('button', { name: '续费', exact: true }).count(), 0); // 终止意图已禁用新续费
    }
    await complete({ id: result.id, action }, '');
  }
  const finalServices = await api(page, '/services');
  assert.equal(finalServices.find(item => item.id === selected.id).status, 'cancelled');
  assert.equal(finalServices.filter(item => item.status === 'active').length, 1);
  await page.goto(`${origin}/console/services`);
  await page.getByText('已终止', { exact: true }).filter({visible:true}).waitFor();
  await screenshot('kima-services-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('kima-services-mobile');
  await page.getByRole('button', { name: '切换到浅色主题', exact: true }).click();
  await screenshot('kima-services-light-mobile');
  await api(admin, `/admin/products/${product.id}`, { method: 'PUT', data: { name: productName, description: product.description, priceCents: '0', currency: 'CNY', stock: product.stock, provider: 'manual', active: false } });
  product.active = false; // 公共首页截图前先下架验收商品，既有服务和审计照常保留
  await page.goto(`${origin}/`);
  await screenshot('kima-home-light-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot('kima-home-light-desktop');
  await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
  await screenshot('kima-home-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('kima-home-mobile');
  await admin.goto(`${origin}/admin?tab=billing-reviews`);
  await admin.getByText(/共 \d+ 条 · 第 1 页/).waitFor();
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ productCreatedAtZeroYuan: true, realCartItems: 2, invoiceItemCount: 3, invoiceAmountMatchesServer: true, freeServices: 2, lifecycle: ['active', 'suspended', 'active', 'cancelled'], terminationPreventsRenewal: true, screenshotCount: 11, pageErrors }, null, 2)); // 不输出邮箱、口令、cookie和恢复码
} catch (failure) {
  let message = String(failure.message || failure);
  for (const secret of [process.env.BOOTSTRAP_EMAIL, process.env.BOOTSTRAP_PASSWORD]) if (secret) message = message.replaceAll(secret, '[redacted]'); // 失败日志同样不泄露输入凭据
  console.log(JSON.stringify({ failed: message, pageErrors }));
  process.exitCode = 1;
} finally {
  if (product && product.active !== false) await api(admin, `/admin/products/${product.id}`, { method: 'PUT', data: { name: productName, description: product.description, priceCents: '0', currency: 'CNY', stock: product.stock, provider: 'manual', active: false } }); // 留下交易与审计，只停止测试商品继续出售
  await browser.close(); // 测试身份不保存到磁盘
}
