/*
交互状态验收：确认提交重试、购物车修订与服务付款入口都保留原业务含义。
调用：先构建并启动本机前端，再运行 node --test apps/web/tests/ui-state.browser.mjs。
浏览器未安装默认版本时，用 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指向已有 Chromium；
测试站点可由 WEB_TEST_ORIGIN 指定，默认 http://127.0.0.1:3300，仅允许本机。
全部 /api/ 请求都被测试拦截，不连接业务数据库、真实资金接口或支付机构。
*/
import test from 'node:test'; // 每条场景各自打开浏览器上下文
import assert from 'node:assert/strict'; // 只核对用户可观察的状态与提交
import { chromium } from '@playwright/test'; // 使用项目已有的浏览器依赖

const origin = new URL(process.env.WEB_TEST_ORIGIN || 'http://127.0.0.1:3300'); // 默认只测本机预览
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  throw new Error('交互状态验收只允许连接本机前端'); // 防止误把测试拦截用到正式站点
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE; // 本机可复用已安装的浏览器

async function withPage(api, check, init) {
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  }); // 不改依赖或安装浏览器
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  }); // 不让worker绕过路由拦截
  const unexpected = []; // 未预期接口也必须留在测试边界内
  const pageErrors = []; // 浏览器运行错误不能被当成成功
  await context.route('**/*', async (route) => {
    const address = new URL(route.request().url()); // 路径在唯一拦截入口核对
    if (address.origin !== origin.origin) {
      unexpected.push(`站外请求 ${address.origin}`);
      await route.abort(); // 不连接任何站外服务
      return;
    }
    if (!address.pathname.startsWith('/api/')) return route.continue(); // 只允许本机HTML和构建资源正常读取
    if (address.pathname === '/api/v1/currencies') return route.fulfill({json:[{code:'CNY',name:'人民币',symbol:'¥',decimals:2,active:true,isDefault:true}]}); // 公共币种元数据，不访问真实API
    if (address.pathname === '/api/v1/auth/me') {
      await route.fulfill({
        json: { id: 'review-user', email: 'review@example.test', name: '交互验收', role: 'admin' },
      });
      return; // 测试身份只有拦截响应，不创建真实会话
    }
    if (address.pathname === '/api/v1/payments') {
      await route.fulfill({ json: [] });
      return; // 不提供任何真实付款渠道
    }
    if (await api(route, address)) return; // 场景明确列出的接口才有测试响应
    unexpected.push(`${route.request().method()} ${address.pathname}`);
    await route.fulfill({ status: 599, json: { message: '未预期的测试接口已拦截' } }); // 绝不放行到真实API
  });
  if (init) await context.addInitScript(init); // 只在本次隔离浏览器保存测试意图
  const page = await context.newPage();
  page.setDefaultTimeout(10000); // 错误状态在有限等待后明确失败，不把验收挂起
  page.on('pageerror', (error) => pageErrors.push(error.message)); // 不忽略渲染或交互异常
  try {
    await check(page);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(pageErrors, []); // 全部业务请求都必须由场景处理
  } finally {
    await browser.close(); // 不保留测试会话或页面存储
  }
}

test('关闭退款确认不取消提交，也不能切换到另一份待确认退款', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  }); // 人为保留一份尚未结束的HTTP请求
  let announce;
  const started = new Promise((resolve) => {
    announce = resolve;
  }); // 确认点击确实发出了测试请求
  const rows = ['A', 'B'].map((name) => ({
    id: `refund-${name}`,
    invoiceId: `invoice-${name}`,
    amountCents: '100',
    reason: `退款${name}原因`,
    status: 'requested',
    createdAt: '2026-01-01T00:00:00Z',
  })); // 仅存在于本次拦截中的两份申请
  try {
    await withPage(
      async (route, address) => {
        if (address.pathname === '/api/v1/admin/refunds') {
          await route.fulfill({ json: { items: rows, total: 2, page: 1, limit: 50 } });
          return true; // 清单只用于观察原目标与后续目标
        }
        if (address.pathname === '/api/v1/admin/refunds/refund-A/approve') {
          announce();
          await gate; // 关闭抽屉时，原请求仍在处理
          await route.fulfill({
            status: 503,
            json: { message: '测试中的原请求尚未完成，请核对后重试' },
          });
          return true; // 返回失败，验证关闭后仍能读到错误
        }
        return false;
      },
      async (page) => {
        await page.goto(`${origin.origin}/admin?tab=refunds`);
        await page
          .getByRole('row')
          .filter({ hasText: '退款A原因' })
          .getByRole('button', { name: '批准退款', exact: true })
          .click();
        const dialog = page.getByRole('dialog', { name: '确认批准退款', exact: true });
        await dialog.getByLabel('当前管理员密码', { exact: true }).fill('Only-test-input'); // 固定测试文本，不读取真实凭据
        const response = page.waitForResponse((item) => item.url().endsWith('/refund-A/approve'));
        await dialog.getByRole('button', { name: '确认批准', exact: true }).click();
        await started;
        await dialog.getByRole('button', { name: '关闭', exact: true }).click(); // 尊重KIMA原有关闭行为
        await dialog.waitFor({ state: 'hidden' });
        await page.getByText('正在核对本次操作结果，请稍等。', { exact: true }).waitFor();
        for (const button of await page
          .getByRole('button', { name: '批准退款', exact: true })
          .all())
          assert.equal(await button.isDisabled(), true); // 原请求结束前不能换目标或重复提交
        release();
        await response;
        await page
          .getByText('测试中的原请求尚未完成，请核对后重试', { exact: true })
          .first()
          .waitFor();
        assert.equal(await dialog.isVisible(), false); // 结果显示在主区域，不强行重开对话框
        await page
          .getByRole('row')
          .filter({ hasText: '退款B原因' })
          .getByRole('button', { name: '批准退款', exact: true })
          .click();
        await dialog.getByText('申请原因：退款B原因', { exact: true }).waitFor(); // 原请求已结束后才允许确认下一份申请
      },
    );
  } finally {
    release(); // 断言失败时也释放正在等待的测试请求
  }
});

test('恢复旧购物车提交时，原金额待核对且不借用当前购物车报价', async () => {
  const sent = [];
  const original = { key: 'review-key-original', revision: 'revision-old' }; // 模拟中断前已经固定的意图
  await withPage(
    async (route, address) => {
      if (address.pathname === '/api/v1/cart') {
        await route.fulfill({
          json: {
            revision: 'revision-new',
            items: [
              {
                productId: 'product-current',
                productName: '新购物车商品',
                quantity: 2,
                period: 'month',
                unitPriceCents: '2900',
                amountCents: '5800',
                available: true,
                stock: 10,
              },
            ],
            amountCents: '5800',
            currency: 'CNY',
            canCheckout: true,
          },
        });
        return true; // 新修订仅代表当前购物车，不能代替原订单
      }
      if (address.pathname === '/api/v1/cart/checkout') {
        sent.push({
          key: route.request().headers()['idempotency-key'],
          body: route.request().postDataJSON(),
        });
        if (sent.length === 1)
          await route.fulfill({ status: 503, json: { message: '测试网络中断，请继续核对原提交' } }); // 第一次仍未确认原订单
        else
          await route.fulfill({
            json: {
              id: 'order-old',
              invoiceId: 'invoice-old',
              status: 'unpaid',
              orderConfirmed: true,
              cartCleared: false,
              amountCents: '2900',
              currency: 'CNY',
              items: [{ quantity: 1 }],
              message: '原订单已确认，购物车同步待重试',
            },
          }); // 第二次才有真实确认的原金额
        return true;
      }
      return false;
    },
    async (page) => {
      await page.goto(`${origin.origin}/console/cart`);
      const summary = page.locator('.cart-summary');
      await summary.getByRole('heading', { name: '先前提交核对', exact: true }).waitFor();
      await summary.getByText('原订单数量待核对', { exact: true }).waitFor();
      assert.equal((await summary.innerText()).includes('¥58.00'), false); // 确认区不会显示新购物车的金额
      await page.getByRole('heading', { name: '当前购物车', exact: true }).waitFor();
      await page
        .getByText(
          '重试只会核对先前提交的订单。下方保留的是当前购物车，内容可能已经变化，不会随这次重试再次购买。',
          { exact: true },
        )
        .waitFor();
      await page.locator('.cart-items').getByText('¥58.00', { exact: true }).waitFor(); // 当前报价依然可读，且有独立标题
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      ); // 手机确认区域不撑开整页
      for (const button of await page.getByRole('button', { name: '增加数量', exact: true }).all())
        assert.equal(await button.isDisabled(), true); // 原提交未核对前不改当前购物车
      await page.getByRole('button', { name: '重试确认本次订单', exact: true }).click();
      await page.getByText('测试网络中断，请继续核对原提交', { exact: true }).waitFor();
      await page.getByRole('button', { name: '重试确认本次订单', exact: true }).click();
      await page.getByText('原订单已确认，购物车同步待重试', { exact: true }).waitFor();
      await summary.getByText('¥29.00', { exact: true }).waitFor(); // 只在响应确认后显示原金额
      assert.equal((await summary.innerText()).includes('¥58.00'), false);
      assert.deepEqual(sent, [
        { key: original.key, body: { revision: original.revision } },
        { key: original.key, body: { revision: original.revision } },
      ]); // 失败后继续同一修订和幂等键
      assert.deepEqual(
        await page.evaluate(() =>
          JSON.parse(sessionStorage.getItem('yunzou:cart-checkout:review-user')),
        ),
        original,
      ); // Redis同步未确认时不清除原意图
    },
    () => {
      sessionStorage.setItem(
        'yunzou:cart-checkout:review-user',
        JSON.stringify({ key: 'review-key-original', revision: 'revision-old' }),
      ); // 测试只在隔离上下文保存非敏感标识
    },
  );
});

test('待开通服务区分待付款与已付款，并打开原账单', async () => {
  let requestedInvoice = ''; // 只记录实际打开的测试账单标识
  await withPage(
    async (route, address) => {
      if (address.pathname === '/api/v1/services') {
        await route.fulfill({
          json: [
            {
              id: 'service-unpaid',
              name: '初始服务甲',
              status: 'pending',
              orderStatus: 'unpaid',
              invoiceId: 'invoice-original',
              createdAt: '2026-01-01T00:00:00Z',
            },
            {
              id: 'service-paid',
              name: '初始服务乙',
              status: 'pending',
              orderStatus: 'paid',
              invoiceId: 'invoice-paid',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        });
        return true; // 同样的pending资源，必须保留不同的付款事实
      }
      if (address.pathname === '/api/v1/invoices/invoice-original') {
        requestedInvoice = 'invoice-original';
        await route.fulfill({
          json: {
            id: 'invoice-original',
            number: 'INV-TEST-ORIGINAL',
            status: 'unpaid',
            amountCents: '2900',
            createdAt: '2026-01-01T00:00:00Z',
          },
        });
        return true; // 只能核对已有账单，不允许再发起一份购买
      }
      if (address.pathname === '/api/v1/wallet') {
        await route.fulfill({ json: { balanceCents: '0', currency: 'CNY' } });
        return true; // 账单页面只读测试余额，不提供任何可扣资金
      }
      return false;
    },
    async (page) => {
      await page.goto(`${origin.origin}/console/services`);
      const unpaid = page.getByRole('row').filter({ hasText: '初始服务甲' });
      const paid = page.getByRole('row').filter({ hasText: '初始服务乙' });
      await unpaid.getByText('待付款', { exact: true }).waitFor();
      await paid.getByText('待开通', { exact: true }).waitFor();
      assert.equal(await paid.getByText('处理中', { exact: true }).count(), 0); // 不以泛化状态隐藏付款已经完成
      await unpaid
        .locator('button, a')
        .filter({ hasText: /付款|账单/ })
        .click();
      await page.waitForURL(`${origin.origin}/console/invoices/invoice-original`);
      await page.getByText('INV-TEST-ORIGINAL', { exact: true }).first().waitFor();
      assert.equal(requestedInvoice, 'invoice-original'); // 跳转与API读取都指向原账单
    },
  );
});

test('核实未暂停只取消原待办，关闭确认后仍等待同一请求', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  }); // 第一份取消请求保持处理中
  let announce;
  const started = new Promise((resolve) => {
    announce = resolve;
  }); // 确认浏览器确实提交了这一待办
  const sent = [];
  const rows = ['A', 'B'].map((name) => ({
    id: `job-skip-${name}`,
    serviceId: `service-skip-${name}`,
    serviceName: `核实服务${name}`,
    serviceStatus: 'active',
    provider: 'manual',
    action: 'suspend',
    state: 'queued',
    scheduledReason: 'overdue',
    result: {},
    manualRequired: true,
    skipAvailable: true,
    createdAt: '2026-01-01T00:00:00Z',
  })); // 待办状态与真实服务运行状态分开保存于测试响应
  try {
    await withPage(
      async (route, address) => {
        if (address.pathname === '/api/v1/admin/jobs') {
          await route.fulfill({ json: rows });
          return true; // 每次刷新都以待办清单的响应为准
        }
        if (address.pathname === '/api/v1/admin/jobs/job-skip-A/skip') {
          sent.push(route.request().postDataJSON());
          if (sent.length === 1) {
            announce();
            await gate; // 允许关闭查看区域，但不能把原请求切给待办B
            await route.fulfill({
              status: 503,
              json: { message: '测试待办核对失败，请核对原请求' },
            });
          } else {
            rows[0].state = 'succeeded';
            rows[0].result = { skipped: true, reason: 'manual_not_executed' };
            rows[0].manualRequired = false;
            rows[0].skipAvailable = false; // 只取消待办，保留serviceStatus为active
            await route.fulfill({ json: { ok: true, skipped: true } });
          }
          return true; // 未列出的服务动作和人工完成接口会被通用拦截器拒绝
        }
        return false;
      },
      async (page) => {
        await page.goto(`${origin.origin}/admin?tab=jobs`);
        const rowA = page.getByRole('row').filter({ hasText: 'job-skip-A' });
        const rowB = page.getByRole('row').filter({ hasText: 'job-skip-B' });
        await rowA.getByRole('button', { name: '已核实未执行暂停', exact: true }).click();
        const dialog = page.getByRole('alertdialog', { name: '确认尚未执行暂停？', exact: true });
        await dialog
          .getByLabel('核实说明', { exact: true })
          .fill('已向实际处理者核实，本次尚未执行暂停。');
        await dialog.getByLabel('当前管理员密码', { exact: true }).fill('Only-test-input');
        await dialog
          .getByRole('button', { name: '已启用双因素认证？填写安全验证', exact: true })
          .click();
        await dialog.getByLabel('6位验证码', { exact: true }).fill('123456'); // 仅检查UI合同，不调用真实认证器
        const response = page.waitForResponse((item) => item.url().endsWith('/job-skip-A/skip'));
        await dialog.getByRole('button', { name: '我已核实未执行暂停', exact: true }).click();
        await started;
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByText('正在核对本次操作结果，请稍等。', { exact: true }).waitFor();
        for (const button of await page
          .getByRole('button', { name: '已核实未执行暂停', exact: true })
          .all())
          assert.equal(await button.isDisabled(), true); // 原请求结束前不能改选待办B
        release();
        await response;
        await page.getByText('测试待办核对失败，请核对原请求', { exact: true }).first().waitFor();
        assert.equal(await dialog.isVisible(), false); // 原请求错误在主区可读
        await rowA.getByRole('button', { name: '已核实未执行暂停', exact: true }).click();
        await dialog
          .getByLabel('核实说明', { exact: true })
          .fill('已向实际处理者核实，本次尚未执行暂停。');
        await dialog.getByLabel('当前管理员密码', { exact: true }).fill('Only-test-input');
        await dialog
          .getByRole('button', { name: '已启用双因素认证？填写安全验证', exact: true })
          .click();
        await dialog.getByLabel('6位验证码', { exact: true }).fill('123456');
        await dialog.getByRole('button', { name: '我已核实未执行暂停', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await rowA.getByText('已跳过 / 未执行', { exact: true }).waitFor();
        assert.equal(
          await rowA.getByRole('button', { name: '已核实未执行暂停', exact: true }).count(),
          0,
        ); // 已跳过待办不再出现可提交入口
        assert.equal(
          await rowA.getByRole('button', { name: '确认服务已暂停', exact: true }).count(),
          0,
        ); // 跳过事实不能再次被人工标记成实际暂停完成
        await rowA.getByText('运行中', { exact: true }).waitFor(); // 界面翻译状态，但仍保留响应中的实际运行事实
        assert.deepEqual(sent, [
          {
            reason: '已向实际处理者核实，本次尚未执行暂停。',
            password: 'Only-test-input',
            totp: '123456',
          },
          {
            reason: '已向实际处理者核实，本次尚未执行暂停。',
            password: 'Only-test-input',
            totp: '123456',
          },
        ]); // 只向原skip入口发送说明、当前密码和一种第二因素
        await page.setViewportSize({ width: 390, height: 844 });
        await rowB.getByRole('button', { name: '已核实未执行暂停', exact: true }).click();
        await dialog.getByText('任务：job-skip-B', { exact: true }).waitFor(); // 原请求完成后才允许核对另一待办
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        ); // 手机核实抽屉不撑开整页
        await page.waitForFunction(() => {
          const button = document.querySelector('dialog[open] button[form="skip-job-form"]');
          if (!button) return false;
          const bounds = button.getBoundingClientRect();
          return (
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight
          );
        }); // 等待抽屉进入动效结束后的实际位置，不滚动页面掩盖越界
        const submit = await dialog
          .getByRole('button', { name: '我已核实未执行暂停', exact: true })
          .boundingBox();
        assert.ok(
          submit &&
            submit.x >= 0 &&
            submit.y >= 0 &&
            submit.x + submit.width <= 390 &&
            submit.y + submit.height <= 844,
          JSON.stringify(submit),
        ); // 抽屉底部提交动作在手机视口内可见
      },
    );
  } finally {
    release(); // 失败时也释放本机的延迟测试响应
  }
});

test('手机服务卡保留完整名称、原账单入口与真实续费目标', async () => {
  const longName = '狐岚云开发环境・华东节点・长期项目数据与构建任务专用资源'; // 长名称不能被手机卡片截去关键部分
  const renewals = [];
  await withPage(
    async (route, address) => {
      if (address.pathname === '/api/v1/services') {
        await route.fulfill({
          json: [
            {
              id: 'phone-service-unpaid',
              name: longName,
              status: 'pending',
              orderStatus: 'unpaid',
              invoiceId: 'phone-original-invoice',
              createdAt: '2026-01-02T12:00:00Z',
            },
            {
              id: 'phone-service-active',
              name: '已交付的手机续费验收资源',
              status: 'active',
              dueAt: '2027-01-02T12:00:00Z',
              externalId: 'resource-actual-phone',
              createdAt: '2026-01-02T12:00:00Z',
            },
          ],
        });
        return true; // 一份待付款，一份已交付服务，分别核对可用动作
      }
      if (address.pathname === '/api/v1/services/phone-service-active/renew') {
        renewals.push({
          method: route.request().method(),
          body: route.request().postDataJSON(),
          key: route.request().headers()['idempotency-key'],
        });
        await route.fulfill({ json: { invoiceId: 'phone-renew-invoice' } });
        return true; // 续费响应只提供新账单，不在浏览器假改到期日
      }
      if (
        [
          '/api/v1/invoices/phone-original-invoice',
          '/api/v1/invoices/phone-renew-invoice',
        ].includes(address.pathname)
      ) {
        const id = address.pathname.split('/').at(-1);
        await route.fulfill({
          json: {
            id,
            number: `INV-${id}`,
            status: 'unpaid',
            amountCents: '2900',
            createdAt: '2026-01-02T12:00:00Z',
            items: [
              {
                id: 'item-one',
                orderId: 'order-phone',
                productId: 'product-phone',
                productName: `${longName}・购买明细`,
                quantity: 2,
                period: 'month',
                unitPriceCents: '1450',
                amountCents: '2900',
                serviceIds: [],
              },
            ],
          },
        });
        return true; // 原购买与续费目标可清楚区分
      }
      if (address.pathname === '/api/v1/wallet') {
        await route.fulfill({ json: { balanceCents: '0', currency: 'CNY' } });
        return true; // 只读测试余额，不提供扣款条件
      }
      return false;
    },
    async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin.origin}/console/services`);
      const unpaid = page.locator('[data-service-id="phone-service-unpaid"]');
      const active = page.locator('[data-service-id="phone-service-active"]');
      const name = unpaid.getByText(longName, { exact: true });
      await name.waitFor();
      assert.equal(
        await name.evaluate((element) => getComputedStyle(element).textOverflow === 'ellipsis'),
        false,
      ); // 名称使用真实换行，不以省略号隐藏尾部
      await unpaid.getByText('待付款', { exact: true }).waitFor();
      assert.equal(await page.getByRole('table').count(), 0); // 手机读取卡片，不要求横向寻找表格动作
      const invoiceButton = unpaid.getByRole('button', { name: '查看账单', exact: true });
      const target = await invoiceButton.boundingBox();
      assert.ok(target && target.width >= 44 && target.height >= 44); // 手机点击热区保持可操作尺寸
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await invoiceButton.click();
      await page.waitForURL(`${origin.origin}/console/invoices/phone-original-invoice`);
      await page.getByText('INV-phone-original-invoice', { exact: true }).first().waitFor();
      const item = page.locator('[data-order-item-id="item-one"]');
      await item.getByText(`${longName}・购买明细`, { exact: true }).waitFor();
      await item.getByText('2 × ¥14.50 · 月付', { exact: true }).waitFor();
      await item.getByText('¥29.00', { exact: true }).waitFor();
      assert.equal(await page.getByRole('table').count(), 0); // 手机购买明细同样无需横向滚动表格
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.goto(`${origin.origin}/console/services`);
      await active.getByRole('button', { name: '续费', exact: true }).click();
      await page.waitForURL(`${origin.origin}/console/invoices/phone-renew-invoice`);
      await page.getByText('INV-phone-renew-invoice', { exact: true }).first().waitFor();
      assert.equal(renewals.length, 1);
      assert.equal(renewals[0].method, 'POST');
      assert.deepEqual(renewals[0].body, { period: 'month' });
      assert.match(renewals[0].key, /^[a-zA-Z0-9_-]{8,100}$/); // 续费动作保留唯一提交标识
    },
  );
});

test('手机账单卡同时显示编号、状态、日期、金额并打开原账单', async () => {
  const number = 'INV-20261110-000001-CUSTOMER-ORIGINAL'; // 长账单号同样不能撑开手机
  await withPage(
    async (route, address) => {
      if (address.pathname === '/api/v1/invoices') {
        await route.fulfill({
          json: [
            {
              id: 'phone-invoice-unpaid',
              number,
              status: 'unpaid',
              amountCents: '123456789012',
              createdAt: '2026-01-02T12:00:00Z',
            },
            {
              id: 'phone-invoice-paid',
              number: 'INV-PAID-PHONE',
              status: 'paid',
              amountCents: '5800',
              createdAt: '2026-01-03T12:00:00Z',
            },
          ],
        });
        return true; // 账单状态与金额都来自本次明确的测试响应
      }
      if (address.pathname === '/api/v1/invoices/phone-invoice-unpaid') {
        await route.fulfill({
          json: {
            id: 'phone-invoice-unpaid',
            number,
            status: 'unpaid',
            amountCents: '123456789012',
            createdAt: '2026-01-02T12:00:00Z',
            items: [
              {
                id: 'item-large',
                orderId: 'order-large',
                productId: 'product-large',
                productName: '长期运行项目・多实例资源与完整购买明细名称验收',
                quantity: 2,
                period: 'month',
                unitPriceCents: '61728394506',
                amountCents: '123456789012',
                serviceIds: [],
              },
            ],
          },
        });
        return true; // 详情保持与卡片相同的账单身份
      }
      if (address.pathname === '/api/v1/wallet') {
        await route.fulfill({ json: { balanceCents: '0', currency: 'CNY' } });
        return true;
      }
      return false;
    },
    async (page) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin.origin}/console/invoices`);
      const unpaid = page.locator('[data-invoice-id="phone-invoice-unpaid"]');
      const paid = page.locator('[data-invoice-id="phone-invoice-paid"]');
      await unpaid.getByText(number, { exact: true }).waitFor();
      await unpaid.getByText('待付款', { exact: true }).waitFor();
      await unpaid.getByText('2026/01/02', { exact: true }).waitFor();
      await unpaid.getByText('¥1,234,567,890.12', { exact: true }).waitFor(); // 金额保留每一分，不经过浮点
      await paid.getByText('已付款', { exact: true }).waitFor();
      await paid.getByText('¥58.00', { exact: true }).waitFor();
      assert.equal(await page.getByRole('table').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const button = unpaid.getByRole('button', { name: '查看账单', exact: true });
      const target = await button.boundingBox();
      assert.ok(target && target.width >= 44 && target.height >= 44); // 查看动作保留手机热区
      await button.click();
      await page.waitForURL(`${origin.origin}/console/invoices/phone-invoice-unpaid`);
      await page.getByRole('heading', { name: '账单详情', exact: true }).waitFor();
      const item = page.locator('[data-order-item-id="item-large"]');
      await item
        .getByText('长期运行项目・多实例资源与完整购买明细名称验收', { exact: true })
        .waitFor();
      await item.getByText('2 × ¥617,283,945.06 · 月付', { exact: true }).waitFor();
      await item.getByText('¥1,234,567,890.12', { exact: true }).waitFor();
      assert.equal(await page.getByRole('table').count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      ); // 大金额明细在手机独立卡片中仍完整可读
    },
  );
});
