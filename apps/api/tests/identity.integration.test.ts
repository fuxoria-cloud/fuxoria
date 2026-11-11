/* 身份真实HTTP回归：随机PostgreSQL库、真实Redis、生产API入口与一次性测试身份。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/identity.integration.test.ts。
 * 只清理本轮随机库与本轮会话/限流键，不操作开发业务数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import { hash, argon2id } from 'argon2';
import { createClient } from 'redis';

test(
  '联系人、角色与Bearer密钥通过真实HTTP保持身份边界',
  { timeout: 120000 },
  async (context) => {
    const source = process.env.DATABASE_URL;
    assert.ok(source, '请提供本机PostgreSQL连接');
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source).hostname),
    );
    const name = `yunzou_identity_${randomUUID().replaceAll('-', '')}`;
    const master = new pg.Client({ connectionString: source });
    const address = new URL(source);
    address.pathname = `/${name}`;
    const database = new pg.Client({ connectionString: address.href });
    const redis = createClient({ url: process.env.REDIS_URL });
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const users: string[] = [],
      emails: string[] = [],
      tokens: string[] = [],
      keyIds: string[] = [];
    const ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    let created = false,
      server: ChildProcess | undefined,
      output = '';
    try {
      await master.connect();
      await master.query(`CREATE DATABASE ${name}`);
      created = true;
      await database.connect();
      await database.query(
        'CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL)',
      );
      const directory = new URL(
        '../../../database/migrations/',
        import.meta.url,
      );
      const files = (await readdir(directory))
        .filter(
          (file) =>
            file.endsWith('.sql') || /^0(17|18|19|20|21|32|33|34)_.*\.draft$/.test(file),
        )
        .sort();
      for (const file of files) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await database.query('BEGIN');
        await database.query(sql);
        await database.query(
          'INSERT INTO migrations(name,hash) VALUES($1,$2)',
          [file, digest(sql)],
        );
        await database.query('COMMIT');
      }
      await redis.connect();
      const listener = createServer();
      await new Promise<void>((resolve) =>
        listener.listen(0, '127.0.0.1', resolve),
      );
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`,
        base = `${origin}/api/v1`;
      server = spawn(
        process.execPath,
        ['--import', 'tsx', 'apps/api/src/main.ts'],
        {
          cwd: new URL('../../../', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: address.href,
            AUDIT_KEY: randomBytes(32).toString('hex'),
            TOTP_KEY: randomBytes(32).toString('hex'),
            PUBLIC_ORIGIN: origin,
            PORT: String(port),
            HOST: '127.0.0.1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      server.stdout?.on('data', (value) => {
        output += String(value);
      });
      server.stderr?.on('data', (value) => {
        output += String(value);
      });
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          ready = (await fetch(`${base}/health`)).ok;
        } catch {}
        if (ready) break;
        if (server.exitCode !== null)
          throw new Error(`身份测试API启动失败：${output.slice(-2000)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, `身份测试API未启动：${output.slice(-2000)}`);
      type Identity = { id: string; email: string; cookie: string };
      const password = 'identity-fixture-password-2026';
      const savedPassword = await hash(password, { type: argon2id });
      async function call(
        path: string,
        options: {
          method?: string;
          body?: unknown;
          cookie?: string;
          bearer?: string;
          origin?: string | null;
        } = {},
      ) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
        };
        if (options.cookie) headers.cookie = options.cookie;
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
        if (options.origin !== null) headers.origin = options.origin ?? origin;
        const reply = await fetch(base + path, {
          method: options.method ?? 'GET',
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        });
        const body = await reply.json();
        return {
          status: reply.status,
          body,
          cookie: reply.headers.get('set-cookie')?.split(';')[0] ?? '',
        };
      }
      async function login(email: string) {
        const reply = await call('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        tokens.push(reply.cookie.split('=')[1]!);
        return reply.cookie;
      }
      async function fixture(role = 'customer'): Promise<Identity> {
        const id = randomUUID(),
          email = `${randomUUID()}@identity.invalid`;
        users.push(id);
        emails.push(email);
        await database.query(
          'INSERT INTO users(id,email,name,password,role) VALUES($1,$2,$3,$4,$5)',
          [id, email, '身份HTTP验收', savedPassword, role],
        );
        return { id, email, cookie: await login(email) };
      }
      const owner = await fixture('admin'),
        customer = await fixture(),
        another = await fixture();
      const product = randomUUID(),
        ownedService = randomUUID(),
        foreignService = randomUUID();
      await database.query(
        "INSERT INTO products(id,name,price_cents,provider) VALUES($1,'身份范围测试商品',100,'manual')",
        [product],
      );
      for (const [userId, serviceId] of [
        [customer.id, ownedService],
        [another.id, foreignService],
      ]) {
        const order = randomUUID();
        await database.query(
          "INSERT INTO orders(id,user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1::uuid,$2,$3,($1::uuid)::text,'identity-scope',100)",
          [order, userId, product],
        );
        await database.query(
          "INSERT INTO services(id,user_id,product_id,order_id,name) VALUES($1,$2,$3,$4,'范围验收服务')",
          [serviceId, userId, product, order],
        );
      }
      let groupId = '',
        roleId = '',
        delegated: Identity,
        childContact = '',
        key = '',
        apiKeyId = '',
        limited: Identity;
      await context.test(
        '客户分组、折扣与备注持久化，停用撤销旧登录',
        async () => {
          const group = await call('/admin/client-groups', {
            method: 'POST',
            cookie: owner.cookie,
            body: {
              name: '身份验收组',
              discountPercent: 15,
              suspendExempt: true,
              separateInvoices: true,
              password,
            },
          });
          assert.equal(group.status, 201, JSON.stringify(group.body));
          groupId = group.body.id;
          assert.equal(group.body.discountPercent, 15);
          const update = await call(`/admin/clients/${customer.id}`, {
            method: 'PUT',
            cookie: owner.cookie,
            body: {
              name: '客户新名字',
              groupId,
              disabled: true,
              notes: '仅管理员可见的真实备注',
              password,
            },
          });
          assert.equal(update.status, 200, JSON.stringify(update.body));
          assert.equal(
            (await call('/auth/me', { cookie: customer.cookie })).status,
            401,
          );
          assert.equal(
            (
              await call(`/admin/client-groups/${groupId}`, {
                method: 'DELETE',
                cookie: owner.cookie,
                body: { password },
              })
            ).status,
            409,
          );
          await call(`/admin/clients/${customer.id}`, {
            method: 'PUT',
            cookie: owner.cookie,
            body: {
              name: '客户新名字',
              groupId,
              disabled: false,
              notes: '仅管理员可见的真实备注',
              password,
            },
          });
          customer.cookie = await login(customer.email);
          const publicProfile = await call('/auth/profile', {
            cookie: customer.cookie,
          });
          assert.ok(!('notes' in publicProfile.body));
          assert.ok(!('admin_notes' in publicProfile.body));
          const clients = await call(
            '/admin/clients?keyword=' + encodeURIComponent(customer.email),
            { cookie: owner.cookie },
          );
          assert.equal(clients.body.items.length, 1);
          assert.equal(clients.body.items[0].notes, '仅管理员可见的真实备注');
          assert.equal(
            (
              await call(`/admin/clients/${owner.id}`, {
                method: 'PUT',
                cookie: owner.cookie,
                body: {
                  name: '错误',
                  groupId: null,
                  disabled: true,
                  notes: '',
                  password,
                },
              })
            ).status,
            404,
          );
        },
      );
      await context.test(
        'Cookie写请求必须同源；不存在的权限不能授予',
        async () => {
          assert.equal(
            (
              await call('/contacts', {
                method: 'POST',
                cookie: customer.cookie,
                origin: null,
                body: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call('/contacts', {
                method: 'POST',
                cookie: customer.cookie,
                origin: 'https://other.invalid',
                body: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call('/admin/roles', {
                method: 'POST',
                cookie: owner.cookie,
                body: {
                  name: '伪造权限',
                  permissions: ['GET /api/v1/does-not-exist'],
                  password,
                },
              })
            ).status,
            409,
          );
        },
      );
      await context.test(
        '角色可复制，受限管理员无法自提权或操作最高管理员',
        async () => {
          const catalog = await call('/admin/permissions', {
            cookie: owner.cookie,
          });
          assert.equal(catalog.status, 200);
          assert.ok(
            catalog.body.some(
              (item: any) => item.key === 'GET /api/v1/services/:id',
            ),
          );
          const permissions = [
            'GET /api/v1/admin/overview',
            'POST /api/v1/admin/roles',
            'PUT /api/v1/admin/roles/:id',
            'PUT /api/v1/admin/administrators/:id',
            'GET /api/v1/api-keys',
            'GET /api/v1/api-keys/permissions',
            'POST /api/v1/api-keys',
            'DELETE /api/v1/api-keys/:id',
          ];
          const role = await call('/admin/roles', {
            method: 'POST',
            cookie: owner.cookie,
            body: { name: '受限运营', permissions, password },
          });
          assert.equal(role.status, 201, JSON.stringify(role.body));
          roleId = role.body.id;
          const copy = await call(`/admin/roles/${roleId}/copy`, {
            method: 'POST',
            cookie: owner.cookie,
            body: { name: '受限运营副本', password },
          });
          assert.equal(copy.status, 201);
          assert.deepEqual(copy.body.permissions, permissions);
          assert.equal(
            (
              await call(`/admin/roles/${copy.body.id}`, {
                method: 'DELETE',
                cookie: owner.cookie,
                body: { password },
              })
            ).status,
            200,
          );
          const member = await call('/admin/administrators', {
            method: 'POST',
            cookie: owner.cookie,
            body: {
              name: '受限管理',
              email: `${randomUUID()}@identity.invalid`,
              newPassword: password,
              roleId,
              password,
            },
          });
          assert.equal(member.status, 201, JSON.stringify(member.body));
          users.push(member.body.id);
          emails.push(member.body.email);
          limited = { ...member.body, cookie: await login(member.body.email) };
          assert.equal(
            (await call('/auth/me', { cookie: limited.cookie })).status,
            200,
          );
          assert.equal(
            (await call('/admin/overview', { cookie: limited.cookie })).status,
            200,
          );
          assert.equal(
            (await call('/admin/clients', { cookie: limited.cookie })).status,
            403,
          );
          assert.equal(
            (
              await call('/admin/roles', {
                method: 'POST',
                cookie: limited.cookie,
                body: {
                  name: '试图扩权',
                  permissions: ['GET /api/v1/admin/clients'],
                  password,
                },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/admin/roles/${roleId}`, {
                method: 'PUT',
                cookie: limited.cookie,
                body: { name: '自改角色', permissions, password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/admin/administrators/${owner.id}`, {
                method: 'PUT',
                cookie: limited.cookie,
                body: { roleId: null, disabled: true, password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/admin/administrators/${owner.id}`, {
                method: 'PUT',
                cookie: owner.cookie,
                body: { roleId: null, disabled: true, password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/admin/roles/${roleId}`, {
                method: 'DELETE',
                cookie: owner.cookie,
                body: { password },
              })
            ).status,
            409,
          );
        },
      );
      await context.test(
        '子账号独立登录，数据映射主账号且审计保留实际执行者',
        async () => {
          const email = `${randomUUID()}@identity.invalid`;
          emails.push(email);
          const result = await call('/contacts', {
            method: 'POST',
            cookie: customer.cookie,
            body: {
              name: '委托伙伴',
              email,
              phone: '+86 13800000000',
              company: '伙伴公司',
              address: '伙伴地址',
              notifications: ['invoice', 'support'],
              loginEnabled: true,
              newPassword: password,
              permissions: ['GET /api/v1/services', 'GET /api/v1/services/:id'],
              password,
            },
          });
          assert.equal(result.status, 201, JSON.stringify(result.body));
          childContact = result.body.id;
          users.push(result.body.childUserId);
          delegated = {
            id: result.body.childUserId,
            email,
            cookie: await login(email),
          };
          const me = await call('/auth/me', { cookie: delegated.cookie });
          assert.equal(me.body.id, customer.id);
          assert.equal(me.body.actorId, delegated.id);
          assert.equal(me.body.delegated, true);
          assert.equal(me.body.role, 'customer');
          const scoped = await call('/services', { cookie: delegated.cookie });
          assert.equal(scoped.status, 200);
          assert.deepEqual(
            scoped.body.map((item: any) => item.id),
            [ownedService],
          );
          assert.equal(
            (
              await call(`/services/${foreignService}`, {
                cookie: delegated.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/services/${ownedService}`, {
                cookie: delegated.cookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (await call('/invoices', { cookie: delegated.cookie })).status,
            403,
          );
          for (const path of [
            '/contacts',
            '/api-keys',
            '/admin/clients',
            '/auth/profile',
          ])
            assert.equal(
              (await call(path, { cookie: delegated.cookie })).status,
              403,
              path,
            );
          for (const path of [
            `/services/${randomUUID()}/transfer`,
            `/services/${randomUUID()}/auto-renew`,
            `/service-transfers/${randomUUID()}/accept`,
            `/contracts/${randomUUID()}/sign`,
            '/auth/password',
          ])
            assert.equal(
              (
                await call(path, {
                  method: 'POST',
                  cookie: delegated.cookie,
                  body: {},
                })
              ).status,
              403,
              path,
            );
          const audit = await database.query(
            "SELECT details FROM audit WHERE action='access.authorized' AND actor=$1 ORDER BY id DESC LIMIT 1",
            [`contact:${delegated.id}`],
          );
          assert.ok(audit.rowCount);
          assert.equal(audit.rows[0].details.actorId, delegated.id);
          assert.equal(
            (
              await call('/contacts', {
                method: 'POST',
                cookie: customer.cookie,
                body: {
                  name: '不能接管',
                  email: another.email,
                  loginEnabled: true,
                  newPassword: password,
                  password,
                },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(`/contacts/${childContact}`, {
                cookie: another.cookie,
                method: 'PUT',
                body: { name: '越权', email, password },
              })
            ).status,
            404,
          );
        },
      );
      await context.test(
        '密钥只显示一次，摘要保存，精确范围、到期、撤销与账号版本均有效',
        async () => {
          const result = await call('/api-keys', {
            method: 'POST',
            cookie: customer.cookie,
            body: {
              name: '只读服务',
              permissions: ['GET /api/v1/services', 'GET /api/v1/services/:id'],
              expiresDays: 7,
              password,
            },
          });
          assert.equal(result.status, 201, JSON.stringify(result.body));
          key = result.body.token;
          apiKeyId = result.body.id;
          keyIds.push(apiKeyId);
          assert.match(key, /^yz_[A-Za-z0-9_-]{43}$/);
          const stored = (
            await database.query('SELECT * FROM api_keys WHERE id=$1', [
              apiKeyId,
            ])
          ).rows[0];
          assert.equal(stored.token_hash, digest(key));
          assert.ok(!JSON.stringify(stored).includes(key));
          const list = await call('/api-keys', { cookie: customer.cookie });
          assert.ok(!JSON.stringify(list.body).includes(key));
          assert.equal(
            (await call('/services', { bearer: key, origin: null })).status,
            200,
          );
          assert.equal(
            (await call('/invoices', { bearer: key, origin: null })).status,
            403,
          );
          assert.equal(
            (await call('/services', { bearer: key, cookie: customer.cookie }))
              .status,
            401,
          );
          for (const permission of [
            'POST /api/v1/api-keys',
            'POST /api/v1/services/:id/transfer',
            'POST /api/v1/services/:id/auto-renew',
            'POST /api/v1/contracts/:id/sign',
          ])
            assert.equal(
              (
                await call('/api-keys', {
                  method: 'POST',
                  cookie: customer.cookie,
                  body: {
                    name: '越权密钥',
                    permissions: [permission],
                    password,
                  },
                })
              ).status,
              403,
            );
          await database.query(
            "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1",
            [apiKeyId],
          );
          assert.equal((await call('/services', { bearer: key })).status, 401);
          await database.query(
            "UPDATE api_keys SET expires_at=now()+interval '1 day' WHERE id=$1",
            [apiKeyId],
          );
          assert.equal(
            (
              await call(`/api-keys/${apiKeyId}`, {
                method: 'DELETE',
                cookie: another.cookie,
                body: { password },
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/api-keys/${apiKeyId}`, {
                method: 'DELETE',
                cookie: customer.cookie,
                body: { password: 'wrong' },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await call(`/api-keys/${apiKeyId}`, {
                method: 'DELETE',
                cookie: customer.cookie,
                body: { password },
              })
            ).status,
            200,
          );
          assert.equal((await call('/services', { bearer: key })).status, 401);
        },
      );
      await context.test('密钥与管理角色取交集，撤销角色即时生效', async () => {
        const createdKey = await call('/api-keys', {
          method: 'POST',
          cookie: limited.cookie,
          body: {
            name: '角色内读取',
            permissions: ['GET /api/v1/admin/overview'],
            password,
          },
        });
        assert.equal(createdKey.status, 201, JSON.stringify(createdKey.body));
        keyIds.push(createdKey.body.id);
        assert.equal(
          (await call('/admin/overview', { bearer: createdKey.body.token }))
            .status,
          200,
        );
        const roles = (await call('/admin/roles', { cookie: owner.cookie }))
          .body;
        const prior = roles.find((item: any) => item.id === roleId);
        const update = await call(`/admin/roles/${roleId}`, {
          method: 'PUT',
          cookie: owner.cookie,
          body: {
            name: prior.name,
            description: '',
            permissions: prior.permissions.filter(
              (item: string) => item !== 'GET /api/v1/admin/overview',
            ),
            password,
          },
        });
        assert.equal(update.status, 200);
        assert.equal(
          (await call('/admin/overview', { bearer: createdKey.body.token }))
            .status,
          403,
        );
      });
      await context.test('停用管理角色令身份读取401，退出仍能撤销Cookie且保持Origin校验', async () => {
        const prior = (await call('/admin/roles', { cookie: owner.cookie })).body.find((item: any) => item.id === roleId);
        const disabled = await call(`/admin/roles/${roleId}`, { method: 'PUT', cookie: owner.cookie, body: { name: prior.name, description: prior.description, permissions: prior.permissions, disabled: true, password } });
        assert.equal(disabled.status, 200);
        assert.equal((await call('/auth/me', { cookie: limited.cookie })).status, 401);
        assert.equal((await call('/auth/logout', { method: 'POST', cookie: limited.cookie, origin: 'https://other.invalid' })).status, 403);
        assert.equal((await call('/auth/logout', { method: 'POST', cookie: limited.cookie })).status, 201);
        assert.equal(await redis.get(`session:${digest(limited.cookie.split('=')[1]!)}`), null);
      });
      await context.test(
        '敏感身份操作必须当前密码和第二因素，恢复码不可重复消费',
        async () => {
          const setup = await call('/auth/mfa/setup', {
            method: 'POST',
            cookie: another.cookie,
            body: { password },
          });
          assert.equal(setup.status, 201, JSON.stringify(setup.body));
          const { totp } = await import('../src/utils/otp.js');
          const confirmed = await call('/auth/mfa/confirm', {
            method: 'POST',
            cookie: another.cookie,
            body: { code: totp(setup.body.secret) },
          });
          assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
          another.cookie = confirmed.cookie;
          tokens.push(confirmed.cookie.split('=')[1]!);
          const body = {
            name: 'MFA保护密钥',
            permissions: ['GET /api/v1/services'],
            password,
          };
          assert.equal(
            (
              await call('/api-keys', {
                method: 'POST',
                cookie: another.cookie,
                body,
              })
            ).status,
            401,
          );
          const proof = {
            ...body,
            recoveryCode: confirmed.body.recoveryCodes[0],
          };
          const first = await call('/api-keys', {
            method: 'POST',
            cookie: another.cookie,
            body: proof,
          });
          assert.equal(first.status, 201, JSON.stringify(first.body));
          keyIds.push(first.body.id);
          assert.equal(
            (
              await call('/api-keys', {
                method: 'POST',
                cookie: another.cookie,
                body: proof,
              })
            ).status,
            401,
          );
        },
      );
      await context.test(
        '停用联系人和主账号都撤销委托，删除保留审计',
        async () => {
          const contacts = await call('/contacts', { cookie: customer.cookie });
          const prior = contacts.body.find(
            (item: any) => item.id === childContact,
          );
          assert.equal(
            (
              await call(`/contacts/${childContact}`, {
                method: 'PUT',
                cookie: customer.cookie,
                body: {
                  name: prior.name,
                  email: prior.email,
                  permissions: prior.permissions,
                  loginEnabled: false,
                  password,
                },
              })
            ).status,
            200,
          );
          assert.equal(
            (await call('/auth/me', { cookie: delegated.cookie })).status,
            401,
          );
          assert.equal(
            (
              await call(`/contacts/${childContact}`, {
                method: 'DELETE',
                cookie: customer.cookie,
                body: { password },
              })
            ).status,
            200,
          );
          assert.ok(
            (
              await database.query(
                "SELECT 1 FROM audit WHERE action='contact.delete' AND target=$1",
                [childContact],
              )
            ).rowCount,
          );
          const fresh = await call('/api-keys', {
            method: 'POST',
            cookie: customer.cookie,
            body: {
              name: '版本撤销',
              permissions: ['GET /api/v1/services'],
              password,
            },
          });
          keyIds.push(fresh.body.id);
          await database.query(
            'UPDATE users SET session_version=session_version+1 WHERE id=$1',
            [customer.id],
          );
          assert.equal(
            (await call('/services', { bearer: fresh.body.token })).status,
            401,
          );
        },
      );
    } finally {
      if (server && server.exitCode === null) {
        server.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          server!.once('exit', () => resolve());
          setTimeout(() => {
            server!.kill('SIGKILL');
            resolve();
          }, 5000).unref();
        });
      }
      if (redis.isOpen) {
        const keys = [
          ...users.flatMap((id) => [
            `account-proof:user:${id}`,
            `account-factor:${id}`,
          ]),
          ...emails.map((email) => `login:${digest(email)}`),
          `login:${digest(ip)}`,
          `account-proof:ip:${digest(ip)}`,
          ...tokens.map((token) => `session:${digest(token)}`),
          ...keyIds.map((id) => `api-rate:${id}`),
        ];
        if (keys.length) await redis.del(keys);
        await redis.quit();
      }
      await database.end();
      if (created) await master.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await master.end();
    }
  },
);
