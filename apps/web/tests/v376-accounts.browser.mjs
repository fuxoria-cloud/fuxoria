/* 3.7.6身份、文档和资金页面浏览器验收：真实Nuxt/KIMA与严格API拦截。
 * 执行：WEB_TEST_ORIGIN=http://127.0.0.1:3400 node --test apps/web/tests/v376-accounts.browser.mjs。
 * 本机HTML/JS/CSS正常读取，全部业务API及站外请求拦截；不写开发数据库，不调用支付机构。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const origin = new URL(process.env.WEB_TEST_ORIGIN || 'http://127.0.0.1:3300');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  throw new Error('浏览器验收仅允许本机');
const uid = '30000000-0000-4000-8000-000000000001',
  scope = { key: 'GET /api/v1/services', subject: 'service' },
  password = 'browser-fixture-only';
const time = '2026-11-11T00:00:00Z',
  artifacts = new URL('../../../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
async function withPage(
  run,
  {
    role = 'customer',
    viewport = { width: 1440, height: 1000 },
    handle = async () => false,
    fixtures = {},
  } = {},
) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
      viewport,
      serviceWorkers: 'block',
    }),
    page = await context.newPage(),
    unknown = [],
    errors = [],
    calls = [],
    documents = [];
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' && /Invalid prop:/.test(message.text()))
      errors.push(message.text());
  });
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(r.url());
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin.origin) {
      unknown.push(`external ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.slice('/api/v1'.length),
      method = route.request().method(),
      body = () => JSON.parse(route.request().postData() || '{}'),
      reply = (data, status = 200) => route.fulfill({ status, json: data });
    calls.push({ path, method, body: route.request().postDataJSON() });
    if (await handle({ route, url, path, method, body, reply, calls })) return;
    if (path === '/auth/me')
      return reply({
        id: uid,
        actorId: uid,
        email: 'browser@example.invalid',
        name: '浏览器验收客户',
        role,
      });
    if (method === 'GET' && Object.hasOwn(fixtures, path))
      return reply(
        typeof fixtures[path] === 'function'
          ? fixtures[path]()
          : fixtures[path],
      );
    if (path === '/overview')
      return reply({
        serviceCount: 1,
        unpaidCount: 2,
        ticketCount: 0,
        balanceCents: '10000',
        recentInvoices: [],
        recentServices: [],
      });
    if (path === '/admin/overview')
      return reply({
        userCount: 1,
        serviceCount: 1,
        orderCount: 1,
        failedJobCount: 0,
        revenueCents: '10000',
        ticketCount: 0,
      });
    if (path === '/wallet')
      return reply({
        balanceCents: '10000',
        heldCents: '0',
        availableCents: '10000',
        currency: 'CNY',
      });
    if (path === '/currencies')
      return reply([
        {
          code: 'CNY',
          name: '人民币',
          symbol: '¥',
          decimals: 2,
          active: true,
          isDefault: true,
        },
      ]);
    if (
      [
        '/payments',
        '/admin/products',
        '/notifications',
        '/services',
        '/api-keys',
        '/contacts',
        '/admin/roles',
        '/admin/administrators',
        '/admin/client-groups',
        '/contracts',
        '/tax-profiles',
        '/tax-requests',
        '/tax-eligible-invoices',
        '/affiliate-withdrawals',
        '/affiliates/commissions',
        '/affiliates/withdrawals',
        '/combined-invoices',
        '/combined-invoices/eligible',
      ].includes(path) &&
      method === 'GET'
    )
      return reply([]);
    if (
      [
        '/contacts/permissions',
        '/api-keys/permissions',
        '/admin/permissions',
      ].includes(path)
    )
      return reply([scope]);
    unknown.push(`${method} ${path}`);
    return reply({ message: '未预期接口已拦截' }, 599);
  });
  try {
    await run(page, { calls, documents });
    assert.deepEqual(unknown, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (process.env.V376_BROWSER_DEBUG)
      console.error(
        JSON.stringify({
          url: page.url(),
          body: (await page.locator('body').innerText()).slice(0, 6500),
          calls: calls.map((c) => ({ path: c.path, method: c.method })),
          errors,
          unknown,
        }),
      );
    throw error;
  } finally {
    await browser.close();
  }
}
async function mark(page) {
  return page.evaluate(() => {
    window.__v376Identity = crypto.randomUUID();
    return window.__v376Identity;
  });
}
async function navigate(page, path) {
  await page.evaluate(
    (path) =>
      document
        .querySelector('#__nuxt')
        .__vue_app__.config.globalProperties.$router.push(path),
    path,
  );
  await page.waitForURL(origin.origin + path);
}
async function same(page, state, marker) {
  assert.equal(await page.evaluate(() => window.__v376Identity), marker);
  assert.equal(state.documents.length, 1);
}
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    `${name}整页溢出`,
  );
  await page.screenshot({
    path: new URL(name + '.png', artifacts).pathname,
    fullPage: page.viewportSize().width > 767,
    animations: 'disabled',
  });
}
async function choose(page, label, name) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function selectScope(page) {
  await page.locator('.scope-list summary').first().click();
  await page.getByRole('checkbox', { name: scope.key, exact: true }).check();
}

test(
  '联系人编辑只提交白名单字段，密钥一次显示，身份页连续导航保留同一文档',
  { timeout: 60000 },
  async () => {
    const contacts = [
        {
          id: 'contact-browser',
          name: '浏览器联系人',
          email: 'contact@example.invalid',
          phone: '13800000000',
          company: '浏览器验收',
          address: '验收地址',
          notifications: ['invoice'],
          permissions: [scope.key],
          active: true,
          loginEnabled: true,
          childUserId: 'child-browser',
          createdAt: time,
          updatedAt: time,
        },
      ],
      keys = [],
      token = 'yz_' + 'q'.repeat(43);
    await withPage(
      async (page, state) => {
        await page.goto(origin.origin + '/console/contacts', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page.getByRole('button', { name: '编辑', exact: true }).click();
        await page.getByLabel('姓名', { exact: true }).fill('已保存的伙伴');
        await page.getByLabel('主账号当前密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '保存联系人', exact: true })
          .click();
        await page
          .getByRole('heading', { name: '已保存的伙伴', exact: true })
          .waitFor();
        await screenshot(page, 'v376-contacts-browser-desktop');
        await navigate(page, '/console/developer');
        await page
          .getByRole('button', { name: '创建密钥', exact: true })
          .click();
        await page
          .getByLabel('用途名称', { exact: true })
          .fill('浏览器只读集成');
        await selectScope(page);
        await page.getByLabel('当前密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '创建并显示密钥', exact: true })
          .click();
        await page.getByText(token, { exact: true }).waitFor();
        await page
          .getByRole('button', { name: '已保存，隐藏密钥', exact: true })
          .click();
        assert.equal(await page.getByText(token, { exact: true }).count(), 0);
        await navigate(page, '/console/contacts');
        await navigate(page, '/console/developer');
        await page
          .getByRole('heading', { name: '浏览器只读集成', exact: true })
          .waitFor();
        assert.equal(await page.getByText(token, { exact: true }).count(), 0);
        await same(page, state, marker);
      },
      {
        fixtures: { '/contacts': () => contacts, '/api-keys': () => keys },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/contacts/contact-browser' && method === 'PUT') {
            const b = body();
            assert.deepEqual(
              Object.keys(b).sort(),
              [
                'active',
                'address',
                'company',
                'email',
                'loginEnabled',
                'name',
                'notifications',
                'password',
                'permissions',
                'phone',
              ].sort(),
            );
            assert.equal(b.password, password);
            contacts[0] = { ...contacts[0], ...b };
            await reply(contacts[0]);
            return true;
          }
          if (path === '/api-keys' && method === 'POST') {
            const b = body();
            assert.deepEqual(b.permissions, [scope.key]);
            keys.push({
              id: 'key-browser',
              name: b.name,
              prefix: token.slice(0, 11),
              permissions: b.permissions,
              expiresAt: '2027-02-01T00:00:00Z',
              createdAt: time,
            });
            await reply({ ...keys[0], token }, 201);
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '管理员创建客户和角色，授信表单提交元到分转换与本人证明',
  { timeout: 60000 },
  async () => {
    const clients = [],
      roles = [],
      credit = [];
    await withPage(
      async (page, state) => {
        await page.goto(origin.origin + '/admin/clients', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '添加客户', exact: true })
          .click();
        await page.getByLabel('客户姓名', { exact: true }).fill('浏览器新客户');
        await page
          .getByLabel('客户邮箱', { exact: true })
          .fill('new@example.invalid');
        await page
          .getByLabel('客户初始密码', { exact: true })
          .fill('new-browser-password');
        await page.getByLabel('管理员当前密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await page
          .getByRole('heading', { name: '浏览器新客户', exact: true })
          .waitFor();
        await navigate(page, '/admin/roles');
        await page
          .getByRole('button', { name: '创建角色', exact: true })
          .click();
        await page
          .getByLabel('角色名称', { exact: true })
          .fill('浏览器只读角色');
        await selectScope(page);
        await page.getByLabel('管理员当前密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await page
          .getByRole('heading', { name: '浏览器只读角色', exact: true })
          .waitFor();
        await navigate(page, '/admin/credit');
        await choose(page, '客户主账号', '浏览器客户@example.invalid');
        await page.getByLabel('额度（CNY）', { exact: true }).fill('123.45');
        await page.getByLabel('说明', { exact: true }).fill('浏览器额度验收');
        await page.getByLabel('当前密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '保存授信', exact: true })
          .click();
        await page.getByText('授信设置已保存。', { exact: true }).waitFor();
        await screenshot(page, 'v376-credit-browser-desktop');
        await same(page, state, marker);
      },
      {
        role: 'admin',
        fixtures: {
          '/admin/clients': () => ({ items: clients, total: clients.length }),
          '/admin/roles': () => roles,
          '/admin/users': [{ id: uid, email: '浏览器客户@example.invalid' }],
          '/admin/credit': () => credit,
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/admin/clients' && method === 'POST') {
            const b = body();
            assert.equal(b.newPassword, 'new-browser-password');
            clients.push({
              id: uid,
              ...b,
              notes: '',
              groupName: null,
              disabled: false,
            });
            await reply(clients[0], 201);
            return true;
          }
          if (path === '/admin/roles' && method === 'POST') {
            const b = body();
            assert.deepEqual(b.permissions, [scope.key]);
            roles.push({ id: 'role-browser', ...b, memberCount: 0 });
            await reply(roles[0], 201);
            return true;
          }
          if (path === '/admin/credit/' + uid && method === 'PUT') {
            const b = body();
            assert.equal(b.limitCents, '12345');
            assert.equal(b.password, password);
            credit.push({
              userId: uid,
              email: '浏览器客户@example.invalid',
              ...b,
              usedCents: '0',
            });
            await reply({ ok: true });
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '手机合同本人签署和发票申请采用当前快照与明确选择',
  { timeout: 60000 },
  async () => {
    const contracts = [
        {
          id: 'contract-browser',
          number: '801',
          snapshot: {
            title: '浏览器服务合同',
            content: '这份文字仅用于浏览器表单验收。\n请核对签约人和约定。',
            party: {
              name: '浏览器验收客户',
              company: '',
              address: '验收地址',
              phone: '13800000000',
              email: 'browser@example.invalid',
            },
            service: null,
          },
          snapshotHash: 'a'.repeat(64),
          status: 'pending',
          createdAt: time,
        },
      ],
      profiles = [
        {
          id: 'profile-browser',
          title: '浏览器企业抬头',
          type: 'company',
          taxNumber: 'SYNTHETIC-TAX-ONLY',
          invoiceType: 'ordinary',
          bank: '',
          bankAccount: '',
          address: '',
          phone: '',
          email: 'browser@example.invalid',
          shippingAddress: '',
        },
      ],
      requests = [];
    await withPage(
      async (page, state) => {
        await page.goto(origin.origin + '/console/contracts', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '查看全文', exact: true })
          .click();
        await page
          .getByRole('checkbox', {
            name: '我已阅读全文，确认资料无误并同意签署。',
            exact: true,
          })
          .check();
        await page.getByLabel('签署确认密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '确认签署', exact: true })
          .click();
        await page
          .getByText('合同已签署，文本与签署记录已保存。', { exact: true })
          .waitFor();
        await screenshot(page, 'v376-contract-browser-mobile');
        await navigate(page, '/console/vouchers');
        await page
          .getByRole('button', { name: '申请开票', exact: true })
          .click();
        await choose(page, '开票抬头', '浏览器企业抬头 · 普通发票');
        await page.getByRole('checkbox', { name: /账单 #901/ }).check();
        await page
          .getByRole('button', { name: '提交申请', exact: true })
          .click();
        await page
          .getByText('开票申请已提交，可在记录中查看处理结果。', {
            exact: true,
          })
          .waitFor();
        await screenshot(page, 'v376-voucher-browser-mobile');
        await same(page, state, marker);
      },
      {
        viewport: { width: 390, height: 844 },
        fixtures: {
          '/contracts': () => contracts,
          '/contract-templates': [],
          '/tax-profiles': profiles,
          '/tax-requests': () => requests,
          '/tax-eligible-invoices': () =>
            requests.length
              ? []
              : [
                  {
                    id: 'invoice-tax-browser',
                    number: '901',
                    amountCents: '12345',
                    paidAt: time,
                  },
                ],
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/contracts/contract-browser/sign') {
            const b = body();
            assert.equal(b.snapshotHash, contracts[0].snapshotHash);
            assert.equal(b.signer, contracts[0].snapshot.party.name);
            assert.equal(b.accept, true);
            contracts[0] = {
              ...contracts[0],
              status: 'signed',
              signedAt: time,
              signer: b.signer,
            };
            await reply({ ok: true }, 201);
            return true;
          }
          if (path === '/tax-requests' && method === 'POST') {
            const b = body();
            assert.equal(b.profileId, profiles[0].id);
            assert.deepEqual(b.invoiceIds, ['invoice-tax-browser']);
            requests.push({
              id: 'tax-browser',
              number: '902',
              profile: profiles[0],
              amountCents: '12345',
              status: 'pending',
              createdAt: time,
            });
            await reply({ id: 'tax-browser' }, 201);
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '联盟设置保留本人密码，提现处理必须明确实际凭据',
  { timeout: 60000 },
  async () => {
    const settings = {
        enabled: true,
        initialRule: { kind: 'percent', value: '1000' },
        renewalRule: { kind: 'fixed', value: '100' },
        reorderRule: { kind: 'percent', value: '500' },
        holdDays: 7,
        minimumWithdrawCents: '1000',
      },
      withdrawals = [
        {
          id: 'withdraw-browser',
          email: 'browser@example.invalid',
          amountCents: '12345',
          status: 'pending',
          payee: {
            method: 'bank',
            name: '浏览器收款人',
            account: 'SYNTHETIC-ACCOUNT-ONLY',
          },
          createdAt: time,
        },
      ];
    await withPage(
      async (page, state) => {
        await page.goto(origin.origin + '/admin/affiliates?tab=settings', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page.getByLabel('规则确认密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '保存规则', exact: true })
          .click();
        await page
          .getByText('联盟规则已保存，仅作用于后续付款。', { exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: '提现申请', exact: true })
          .click();
        await page
          .getByRole('button', { name: '核对并处理', exact: true })
          .click();
        await page
          .getByLabel('实际打款凭据', { exact: true })
          .fill('SYNTHETIC-PAYOUT-ONLY');
        await page
          .getByRole('checkbox', {
            name: '我已核对收款人、金额与实际打款凭据。',
            exact: true,
          })
          .check();
        await page.getByLabel('提现确认密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '保存处理结果', exact: true })
          .click();
        await page.getByText('提现处理结果已保存。', { exact: true }).waitFor();
        await same(page, state, marker);
      },
      {
        role: 'admin',
        fixtures: {
          '/admin/affiliates/settings': () => settings,
          '/admin/affiliates': [],
          '/admin/affiliate-withdrawals': () => withdrawals,
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/admin/affiliates/settings' && method === 'PUT') {
            assert.equal(body().password, password);
            assert.equal(body().initialRule.value, '1000');
            await reply({ ok: true });
            return true;
          }
          if (
            path === '/admin/affiliate-withdrawals/withdraw-browser/process'
          ) {
            const b = body();
            assert.equal(b.action, 'pay');
            assert.equal(b.reference, 'SYNTHETIC-PAYOUT-ONLY');
            assert.ok(b.paidAt);
            assert.equal(b.password, password);
            withdrawals[0] = {
              ...withdrawals[0],
              status: 'paid',
              reference: b.reference,
            };
            await reply({ ok: true, status: 'paid' }, 201);
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '手机联盟收益与合并支付按整数金额提交，并通过AJAX进入原收银台',
  { timeout: 60000 },
  async () => {
    const eligible = [
        {
          id: 'bill-one',
          number: '1001',
          amountCents: '12345',
          currency: 'CNY',
          productName: '浏览器云服务甲',
          kind: 'new',
        },
        {
          id: 'bill-two',
          number: '1002',
          amountCents: '101',
          currency: 'CNY',
          productName: '浏览器云服务乙',
          kind: 'renew',
        },
      ],
      groups = [];
    await withPage(
      async (page, state) => {
        await page.goto(origin.origin + '/console/affiliates', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '转入账户余额', exact: true })
          .click();
        await page
          .getByLabel('收益转出金额（元）', { exact: true })
          .fill('12.34');
        await page
          .getByLabel('收益转出确认密码', { exact: true })
          .fill(password);
        await page
          .getByRole('button', { name: '确认转入', exact: true })
          .click();
        await page.getByText('佣金已转入账户余额。', { exact: true }).waitFor();
        await screenshot(page, 'v376-affiliates-browser-mobile');
        await navigate(page, '/console/combined');
        await page.getByRole('checkbox', { name: /浏览器云服务甲/ }).check();
        await page.getByRole('checkbox', { name: /浏览器云服务乙/ }).check();
        const hotArea = await page
          .getByRole('checkbox', { name: /浏览器云服务甲/ })
          .evaluate((input) => ({
            display: getComputedStyle(input.closest('label')).display,
            height: input.closest('label').getBoundingClientRect().height,
          }));
        assert.equal(hotArea.display, 'flex');
        assert.ok(hotArea.height >= 44);
        await screenshot(page, 'v376-combined-browser-mobile');
        await page
          .getByRole('button', { name: '合并并前往付款', exact: true })
          .click();
        await page.waitForURL(
          origin.origin + '/console/invoices/combined-browser',
        );
        await page
          .getByRole('heading', { name: '账单详情', exact: true })
          .waitFor();
        await same(page, state, marker);
      },
      {
        viewport: { width: 390, height: 844 },
        fixtures: {
          '/affiliates': {
            profile: { code: 'x'.repeat(22), enabled: true },
            settings: {
              enabled: true,
              holdDays: 7,
              minimumWithdrawCents: '1000',
              initialRule: { kind: 'percent', value: '1000' },
              renewalRule: { kind: 'percent', value: '500' },
              reorderRule: { kind: 'fixed', value: '100' },
            },
            availableCents: '12345',
            balanceCents: '12345',
            reservedCents: '0',
            pendingCents: '1000',
            refundPending: false,
            referralCount: 2,
          },
          '/combined-invoices/eligible': () => eligible,
          '/combined-invoices': () => groups,
          '/invoices/combined-browser': {
            id: 'combined-browser',
            number: '1003',
            orderId: 'order-combined',
            kind: 'combined',
            amountCents: '12446',
            currency: 'CNY',
            status: 'unpaid',
            payable: true,
            productName: '合并支付',
            items: [],
            combinedCount: 2,
            combinedParentId: null,
            createdAt: time,
            combinedItems: eligible.map((item) => ({
              ...item,
              status: 'unpaid',
            })),
          },
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/affiliates/transfers') {
            const b = body();
            assert.equal(b.amountCents, '1234');
            assert.equal(b.password, password);
            await reply({ ok: true, id: 'transfer-browser' }, 201);
            return true;
          }
          if (path === '/combined-invoices' && method === 'POST') {
            assert.deepEqual(body().invoiceIds, ['bill-one', 'bill-two']);
            groups.push({
              id: 'combined-browser',
              number: '1003',
              amountCents: '12446',
              itemCount: 2,
              status: 'pending',
              cancellable: true,
              createdAt: time,
            });
            await reply(
              { invoiceId: 'combined-browser', amountCents: '12446' },
              201,
            );
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '销售组和同币种阶梯通过真实KIMA表单保存，零小数币种正确转最小单位',
  { timeout: 60000 },
  async () => {
    const state = {
      groups: [],
      tiers: [],
      people: [],
      assignments: [],
      withdrawals: [],
      clients: [],
      staff: [],
      products: [],
    };
    await withPage(
      async (page, network) => {
        await page.goto(origin.origin + '/admin/sales?tab=groups', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '新建销售组', exact: true })
          .click();
        await page
          .getByLabel('销售组名称', { exact: true })
          .fill('浏览器销售组');
        await page.getByLabel('销售新购比例', { exact: true }).fill('12.5');
        await page
          .getByLabel('销售管理确认密码', { exact: true })
          .fill(password);
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await page
          .getByRole('heading', { name: '浏览器销售组 · 启用', exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: '月业绩阶梯', exact: true })
          .click();
        await page
          .getByRole('button', { name: '设置阶梯', exact: true })
          .click();
        await choose(page, '阶梯销售组', '浏览器销售组');
        await choose(page, '阶梯币种', '日元 · JPY');
        await page.getByLabel('销售阶梯门槛', { exact: true }).fill('1000');
        await page.getByLabel('销售阶梯比例', { exact: true }).fill('20');
        await page
          .getByLabel('销售管理确认密码', { exact: true })
          .fill(password);
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await page
          .getByText('销售设置与处理结果已保存。', { exact: true })
          .waitFor();
        await screenshot(page, 'v376-sales-browser-desktop');
        await same(page, network, marker);
      },
      {
        role: 'admin',
        fixtures: {
          '/admin/sales': () => state,
          '/currencies': [
            { code: 'CNY', name: '人民币', decimals: 2 },
            { code: 'JPY', name: '日元', decimals: 0 },
          ],
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/admin/sales/groups' && method === 'POST') {
            const b = body();
            assert.equal(b.newBps, 1250);
            assert.equal(b.password, password);
            state.groups.push({
              id: 'sales-group-browser',
              name: b.name,
              productIds: [],
              ...b,
            });
            await reply({ id: 'sales-group-browser' }, 201);
            return true;
          }
          if (path === '/admin/sales/tiers' && method === 'POST') {
            const b = body();
            assert.equal(b.currency, 'JPY');
            assert.equal(b.thresholdCents, '1000');
            assert.equal(b.rateBps, 2000);
            state.tiers.push({ id: 'sales-tier-browser', ...b });
            await reply({ id: 'sales-tier-browser' }, 201);
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '员工手机兑现按本人币种提交，经营报表筛选后仍保持同一文档',
  { timeout: 60000 },
  async () => {
    const rates = [
        { code: 'CNY', name: '人民币', decimals: 2 },
        { code: 'JPY', name: '日元', decimals: 0 },
      ],
      withdrawals = [];
    await withPage(
      async (page, network) => {
        await page.goto(origin.origin + '/console/sales', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '申请兑现 JPY', exact: true })
          .click();
        await page.getByLabel('销售提成兑现金额', { exact: true }).fill('20');
        await page
          .getByLabel('销售收款人姓名', { exact: true })
          .fill('浏览器员工');
        await page
          .getByLabel('销售收款账号', { exact: true })
          .fill('SYNTHETIC-STAFF-ONLY');
        await page
          .getByLabel('销售兑现确认密码', { exact: true })
          .fill(password);
        await page
          .getByRole('button', { name: '提交申请', exact: true })
          .click();
        await page
          .getByText('兑现申请已提交，金额已预留。', { exact: true })
          .waitFor();
        await screenshot(page, 'v376-sales-browser-mobile');
        await same(page, network, marker);
      },
      {
        role: 'support',
        viewport: { width: 390, height: 844 },
        fixtures: {
          '/currencies': rates,
          '/sales': {
            profile: { groupName: '浏览器销售组' },
            balances: [
              {
                currency: 'JPY',
                balanceCents: '1000',
                availableCents: '1000',
                pendingCents: '0',
                reservedCents: '0',
                refundPending: false,
              },
            ],
          },
          '/sales/customers': [
            {
              id: 'sales-client-browser',
              name: '浏览器归属客户',
              email: 'client@example.invalid',
              company: '',
            },
          ],
          '/sales/commissions': [],
          '/sales/withdrawals': () => withdrawals,
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/sales/withdrawals' && method === 'POST') {
            const b = body();
            assert.equal(b.currency, 'JPY');
            assert.equal(b.amountCents, '20');
            withdrawals.push({
              id: 'sales-withdraw-browser',
              currency: b.currency,
              amountCents: b.amountCents,
              status: 'pending',
              payee: b.payee,
              createdAt: time,
            });
            await reply({ id: 'sales-withdraw-browser' }, 201);
            return true;
          }
          return false;
        },
      },
    );
    await withPage(
      async (page, network) => {
        await page.goto(origin.origin + '/admin/reports', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page.getByRole('heading', { name: 'CNY', exact: true }).waitFor();
        await page.getByRole('heading', { name: 'JPY', exact: true }).waitFor();
        await choose(page, '报表币种', '日元 · JPY');
        await page.getByRole('button', { name: '查询', exact: true }).click();
        await page.getByRole('heading', { name: 'JPY', exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll('h2')).some(
              (e) => e.textContent.trim() === 'CNY',
            ),
        );
        await screenshot(page, 'v376-reports-browser-mobile');
        await same(page, network, marker);
      },
      {
        role: 'admin',
        viewport: { width: 390, height: 844 },
        fixtures: { '/currencies': rates },
        handle: async ({ path, url, reply }) => {
          if (path === '/admin/reports') {
            const row = (code) => ({
              currency: code,
              cashInCents: '1000',
              cashOutCents: '100',
              incomeNetCents: '900',
              walletChangeCents: '0',
              receivableChangeCents: '0',
            });
            await reply({
              summary: url.searchParams.get('currency')
                ? [row('JPY')]
                : [row('CNY'), row('JPY')],
              timeline: [],
              newCustomers: [],
              customers: [],
              products: [],
            });
            return true;
          }
          if (path === '/admin/reports/operations') {
            await reply({ states: [], trend: [], recent: [] });
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '红冲保留原票据，开票切币种清空旧勾选以避免混开',
  { timeout: 60000 },
  async () => {
    const profile = {
      id: 'red-profile-browser',
      title: '浏览器原票据抬头',
      type: 'company',
      taxNumber: 'SYNTHETIC-TAX-ONLY',
      invoiceType: 'ordinary',
      bank: '',
      bankAccount: '',
      address: '',
      phone: '',
      email: 'browser@example.invalid',
      shippingAddress: '',
    };
    const records = [
        {
          id: 'red-tax-browser',
          number: '991',
          profile,
          amountCents: '1234',
          currency: 'USD',
          status: 'issued',
          invoiceNumber: 'SYNTHETIC-ORIGINAL-001',
          documentUrl: 'https://documents.invalid/original.pdf',
          note: '',
          email: 'browser@example.invalid',
          createdAt: time,
          redDocument: null,
        },
      ],
      eligible = [
        {
          id: 'tax-cny-browser',
          number: '992',
          currency: 'CNY',
          amountCents: '10000',
          paidAt: time,
        },
        {
          id: 'tax-usd-browser',
          number: '993',
          currency: 'USD',
          amountCents: '1234',
          paidAt: time,
        },
      ];
    await withPage(
      async (page, network) => {
        await page.goto(origin.origin + '/admin/documents', {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page
          .getByRole('button', { name: '查看记录', exact: true })
          .click();
        await page
          .getByLabel('实际红字发票号码', { exact: true })
          .fill('SYNTHETIC-RED-001');
        await page
          .getByLabel('发票交付链接', { exact: true })
          .fill('https://documents.invalid/red.pdf');
        await page
          .getByLabel('开票处理说明', { exact: true })
          .fill('浏览器核对实际全额红字票据');
        await page.getByLabel('开票确认密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '保存处理结果', exact: true })
          .click();
        await page
          .getByText('红冲登记已保存，原始票据保留。退款需另行核对办理。', {
            exact: true,
          })
          .waitFor();
        await page
          .getByRole('button', { name: '查看记录', exact: true })
          .click();
        await page.getByText('已登记全额红冲', { exact: true }).waitFor();
        await screenshot(page, 'v376-tax-red-browser-desktop');
        await navigate(page, '/console/vouchers');
        await page
          .getByText('发票号码：SYNTHETIC-ORIGINAL-001', { exact: true })
          .waitFor();
        await page
          .getByText('已全额红冲 · 红字票号 SYNTHETIC-RED-001', { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('link', { name: '查看红字发票', exact: true })
            .getAttribute('href'),
          'https://documents.invalid/red.pdf',
        );
        await page
          .getByRole('button', { name: '申请开票', exact: true })
          .click();
        await choose(page, '开票抬头', '浏览器原票据抬头 · 普通发票');
        await page.getByRole('checkbox', { name: /账单 #992/ }).check();
        await choose(page, '开票币种', 'USD');
        assert.equal(
          await page.getByRole('checkbox', { name: /账单 #992/ }).count(),
          0,
        );
        assert.equal(
          await page.getByRole('checkbox', { name: /账单 #993/ }).isChecked(),
          false,
        );
        await page.getByRole('checkbox', { name: /账单 #993/ }).check();
        await page
          .getByRole('button', { name: '提交申请', exact: true })
          .click();
        await page
          .getByText('开票申请已提交，可在记录中查看处理结果。', {
            exact: true,
          })
          .waitFor();
        assert.equal(
          network.calls.filter((c) => c.path.includes('refund')).length,
          0,
        );
        await same(page, network, marker);
      },
      {
        role: 'admin',
        fixtures: {
          '/admin/contract-templates': [],
          '/admin/contracts': [],
          '/admin/tax-requests': () => records,
          '/tax-profiles': [profile],
          '/tax-requests': () => records,
          '/tax-eligible-invoices': () => eligible,
        },
        handle: async ({ path, method, body, reply }) => {
          if (path === '/admin/tax-requests/red-tax-browser/red-letter') {
            const b = body();
            assert.equal(b.invoiceNumber, 'SYNTHETIC-RED-001');
            assert.equal(b.password, password);
            records[0] = {
              ...records[0],
              redDocument: {
                invoiceNumber: b.invoiceNumber,
                documentUrl: b.documentUrl,
                reason: b.reason,
                createdAt: time,
              },
            };
            await reply({ ok: true }, 201);
            return true;
          }
          if (path === '/tax-requests' && method === 'POST') {
            const b = body();
            assert.deepEqual(b.invoiceIds, ['tax-usd-browser']);
            assert.equal(b.profileId, profile.id);
            records.push({
              id: 'tax-new-browser',
              number: '994',
              profile,
              amountCents: '1234',
              currency: 'USD',
              status: 'pending',
              createdAt: time,
            });
            eligible.splice(
              eligible.findIndex((i) => i.id === 'tax-usd-browser'),
              1,
            );
            await reply({ id: 'tax-new-browser' }, 201);
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '资源控制在手机上核验敏感动作与私有结果，监控只渲染结构化数据',
  { timeout: 60000 },
  async () => {
    const service = '30000000-0000-4000-8000-000000000038',
      jobs = [
        {
          id: 'inspect-browser',
          state: 'succeeded',
          operation: 'inspect',
          actionId: '',
          createdAt: time,
          result: { data: { fields: { status: 'running', ip: '192.0.2.38' } } },
        },
        {
          id: 'metric-browser',
          state: 'succeeded',
          operation: 'metrics',
          actionId: '',
          createdAt: time,
          result: {
            data: {
              metrics: {
                traffic: [
                  { at: time, value: 1.25 },
                  { at: '2026-11-11T00:01:00Z', value: 2.5 },
                ],
              },
            },
          },
        },
      ];
    const capability = {
      clientActions: [
        { id: 'reboot', label: '重启', destructive: true },
        {
          id: 'resetPassword',
          label: '修改资源密码',
          fields: [
            {
              key: 'password',
              label: '新资源密码',
              secret: true,
              required: true,
            },
          ],
        },
      ],
      inspect: [
        { key: 'status', label: '状态' },
        { key: 'ip', label: '地址' },
      ],
      metrics: [{ key: 'traffic', label: '流量', unit: 'Mbps' }],
      consoleOrigins: ['https://console.resource.invalid'],
      credentialFields: [
        { key: 'username', label: '用户名' },
        { key: 'password', label: '密码' },
      ],
    };
    await withPage(
      async (page, network) => {
        await page.goto(origin.origin + `/console/resources/${service}`, {
          waitUntil: 'networkidle',
        });
        const marker = await mark(page);
        await page.getByText('running', { exact: true }).waitFor();
        assert.equal(
          await page.locator('svg[aria-label="流量趋势"] polyline').count(),
          1,
        );
        await screenshot(page, 'v376-resource-overview-browser-mobile');
        await page
          .getByRole('button', { name: '修改资源密码', exact: true })
          .click();
        await page
          .getByLabel('新资源密码', { exact: true })
          .fill('BROWSER-RESOURCE-SECRET');
        await page.getByLabel('当前密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '确认提交', exact: true })
          .click();
        await page
          .getByText('操作已排队，供应商确认后会自动更新。', { exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: '获取登录凭据', exact: true })
          .click();
        await page.getByLabel('当前密码', { exact: true }).fill(password);
        await page
          .getByRole('button', { name: '确认提交', exact: true })
          .click();
        await page
          .getByRole('button', { name: '验证并读取', exact: true })
          .click();
        await page.getByLabel('当前密码', { exact: true }).fill(password);
        await page
          .locator('form')
          .getByRole('button', { name: '验证并读取', exact: true })
          .click();
        await page
          .getByText('BROWSER-PRIVATE-PASSWORD', { exact: true })
          .waitFor();
        await screenshot(page, 'v376-resource-browser-mobile');
        await page
          .getByRole('button', { name: '隐藏结果', exact: true })
          .click();
        assert.equal(
          await page
            .getByText('BROWSER-PRIVATE-PASSWORD', { exact: true })
            .count(),
          0,
        );
        await navigate(page, '/console/activity');
        await page
          .getByRole('heading', { name: '活动记录', exact: true })
          .waitFor();
        await page
          .getByRole('heading', { name: '提交资源操作', exact: true })
          .waitFor();
        await screenshot(page, 'v376-activity-browser-mobile');
        await same(page, network, marker);
      },
      {
        viewport: { width: 390, height: 844 },
        fixtures: {
          [`/services/${service}/resource`]: () => ({
            service: { id: service, name: '云狐测试云主机', status: 'active' },
            capability,
            jobs,
          }),
          '/activity': {
            items: [
              {
                id: '38',
                action: 'resource.requested',
                label: '提交资源操作',
                target: service,
                createdAt: time,
                bySelf: true,
              },
            ],
            next: null,
            actions: [{ value: 'resource.requested', label: '提交资源操作' }],
          },
        },
        handle: async ({ path, method, body, reply }) => {
          if (
            path === `/services/${service}/resource/jobs` &&
            method === 'POST'
          ) {
            const b = body();
            assert.equal(b.password, password);
            if (b.operation === 'action') {
              assert.equal(b.actionId, 'resetPassword');
              assert.equal(b.input.password, 'BROWSER-RESOURCE-SECRET');
            } else {
              assert.equal(b.operation, 'credentials');
              jobs.unshift({
                id: 'private-browser',
                state: 'succeeded',
                operation: 'credentials',
                actionId: '',
                createdAt: time,
                result: {
                  data: {
                    privateAvailable: true,
                    expiresAt: new Date(Date.now() + 120000).toISOString(),
                  },
                },
              });
            }
            await reply(
              {
                id:
                  b.operation === 'action'
                    ? 'action-browser'
                    : 'private-browser',
              },
              201,
            );
            return true;
          }
          if (
            path === '/resource-jobs/private-browser/private' &&
            method === 'POST'
          ) {
            assert.equal(body().password, password);
            await reply(
              {
                credentials: {
                  username: 'root',
                  password: 'BROWSER-PRIVATE-PASSWORD',
                },
              },
              201,
            );
            return true;
          }
          return false;
        },
      },
    );
  },
);

test(
  '资源模块缺少在线声明时不出现供应商操作按钮',
  { timeout: 45000 },
  async () => {
    const service = '30000000-0000-4000-8000-000000000039';
    await withPage(
      async (page) => {
        await page.goto(origin.origin + `/console/resources/${service}`, {
          waitUntil: 'networkidle',
        });
        await page
          .getByRole('heading', {
            name: '供应商当前未开放在线控制',
            exact: true,
          })
          .waitFor();
        for (const name of [
          '重启',
          '刷新状态',
          '刷新监控',
          '打开控制台',
          '获取登录凭据',
        ])
          assert.equal(
            await page.getByRole('button', { name, exact: true }).count(),
            0,
          );
        await screenshot(page, 'v376-resource-offline-browser-desktop');
      },
      {
        fixtures: {
          [`/services/${service}/resource`]: {
            service: { id: service, name: '离线能力验收', status: 'active' },
            capability: null,
            jobs: [],
          },
        },
      },
    );
  },
);
