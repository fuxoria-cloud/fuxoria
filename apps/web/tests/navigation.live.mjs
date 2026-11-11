/* 真实公开页面的AJAX验收：只读首页与产品，不登录、不下单、不替换API。
 * 调用：启动本机前端后 node apps/web/tests/navigation.live.mjs。
 * 可通过PLAYWRIGHT_CHROMIUM_EXECUTABLE复用浏览器；输出截图和无凭据的网络统计到artifacts。
 */
import assert from 'node:assert/strict'; // URL变化不足以证明AJAX，还要确认同一文档与窗口状态
import { randomUUID } from 'node:crypto'; // 重新加载文档会丢失本轮窗口标记
import { mkdir, writeFile } from 'node:fs/promises'; // 只写项目验收产物
import { chromium } from '@playwright/test'; // 不在测试中下载浏览器或改动依赖

const origin = new URL(process.env.WEB_TEST_ORIGIN || 'http://127.0.0.1:3300');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('公开导航验收只允许本机');
const artifacts = new URL('../../../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const documents = [], api = [], errors = [];
  page.on('request', request => {
    if (request.resourceType() === 'document') documents.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin.href, { waitUntil: 'networkidle' });
  const marker = randomUUID();
  await page.evaluate(value => { window.__yunzouAjaxCheck = value; }, marker);
  await page.locator('.public-header nav').getByRole('link', { name: '云产品', exact: true }).click();
  await page.waitForURL(new URL('/products', origin).href);
  await page.getByRole('heading', { name: '找到适合你的云。' }).waitFor();
  await page.getByRole('heading', { level: 2 }).first().waitFor(); // 等实际产品API返回，不拍加载骨架
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
  });
  assert.equal(await page.evaluate(() => window.__yunzouAjaxCheck), marker);
  assert.equal(documents.length, 1);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: new URL('ajax-products-desktop.png', artifacts).pathname, fullPage: true, animations: 'disabled' });
  await page.goBack();
  await page.waitForURL(origin.href);
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(await page.evaluate(() => window.__yunzouAjaxCheck), marker);
  assert.equal(documents.length, 1);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}); // 手机重新排版后核对真实字标和48px操作区
  const header = await page.locator('.public-header').evaluate(element=>{
    const brand=element.querySelector('.brand-link'), word=element.querySelector('.brand-en');
    const bounds=element.getBoundingClientRect(), link=brand.getBoundingClientRect(), label=word.getBoundingClientRect();
    return {text:word.textContent,brandRight:link.right,wordRight:label.right,actionsRight:element.querySelector('.public-actions').getBoundingClientRect().right,headerRight:bounds.right,viewport:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...element.querySelectorAll('.public-actions button')].filter(node=>node.checkVisibility()).map(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))};
  });
  assert.equal(header.text,'FUXORIA CLOUD');
  assert.ok(header.wordRight<=header.brandRight+1,'英文品牌不能被链接边界裁切');
  assert.ok(header.actionsRight<=header.headerRight+1,'手机操作区应留在页面边距内');
  assert.ok(header.scroll<=header.viewport,'手机页面不得横向溢出');
  assert.ok(header.controls.every(item=>item.width>=44&&item.height>=44),'手机可见按钮保留至少44px热区');
  await page.screenshot({path:new URL('kima-home-mobile.png',artifacts).pathname,fullPage:true,animations:'disabled'});
  assert.deepEqual(errors, []);
  const result = { checkedAt: new Date().toISOString(), routes: ['/', '/products', 'history.back → /'], documents: documents.length, windowPreserved: true, api, pageErrors: errors, mobileHeader: header, mutations: 0 };
  await writeFile(new URL('ajax-live-check.json', artifacts), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close(); // 不保留用户会话或浏览器后台进程
}
