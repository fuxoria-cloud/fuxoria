/* 资源真实HTTP/Go回归：随机PostgreSQL库、真实Redis、生产API入口与一次性测试身份。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/resource.integration.test.ts。
 * 只清理本轮随机库与本轮会话/限流键，不操作开发业务数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import {
  readdir,
  readFile,
  mkdtemp,
  writeFile,
  rm,
  chmod,
} from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totp } from '../src/utils/otp.js';
import { hash, argon2id } from 'argon2';
import { createClient } from 'redis';

test(
  '资源模块经过真实HTTP、独立PostgreSQL、Go执行程序和签名回调',
  { timeout: 180000 },
  async (context) => {
    const source = process.env.DATABASE_URL;
    assert.ok(source, '请提供本机PostgreSQL连接');
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source).hostname),
    );
    const name = `yunzou_resource_${randomUUID().replaceAll('-', '')}`;
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
    let agent: ChildProcess | undefined;
    let fixtureDirectory = '';
    const resourceKey = randomBytes(32).toString('hex'),
      sharedAuditKey = randomBytes(32).toString('hex'),
      callbackKey = randomBytes(32).toString('hex');
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
            file.endsWith('.sql') ||
            /^0(17|18|19|20|21|32|33|34|38)_.*\.draft$/.test(file),
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
            AUDIT_KEY: sharedAuditKey,
            RESOURCE_KEY: resourceKey,
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
          key?: string;
        } = {},
      ) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-forwarded-for': ip,
        };
        if (options.key) headers['idempotency-key'] = options.key;
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

      const customer = await fixture(),
        another = await fixture(),
        admin = await fixture('admin');
      const product = randomUUID(),
        service = randomUUID(),
        foreignService = randomUUID();
      await database.query(
        "INSERT INTO products(id,name,price_cents,provider) VALUES($1,'资源真实验收',100,'resource-fixture')",
        [product],
      );
      for (const [userId, id] of [
        [customer.id, service],
        [another.id, foreignService],
      ]) {
        const order = randomUUID();
        await database.query(
          "INSERT INTO orders(id,user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1::uuid,$2,$3,($1::uuid)::text,'resource',100)",
          [order, userId, product],
        );
        await database.query(
          "INSERT INTO services(id,user_id,product_id,order_id,name,status,external_id) VALUES($1,$2,$3,$4,'资源验收','active','vm-resource-test')",
          [id, userId, product, order],
        );
      }
      const capability = {
        clientActions: [
          { id: 'reboot', label: '重启', destructive: true },
          {
            id: 'resetPassword',
            label: '修改资源密码',
            fields: [
              {
                key: 'password',
                label: '新密码',
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
      fixtureDirectory = await mkdtemp(join(tmpdir(), 'yunzou-resource-'));
      const program = join(fixtureDirectory, 'resource-fixture.mjs');
      await writeFile(
        program,
        `#!/usr/bin/env node
let raw='';for await(const c of process.stdin)raw+=c;const job=JSON.parse(raw);if(process.env.RESOURCE_KEY||job.payload.encryptedInput||!job.payload.input)process.exit(8);const operation=job.payload.operation;if(operation==='inspect')console.log(JSON.stringify({data:{fields:{status:'running',ip:'192.0.2.38'}}}));else if(operation==='metrics'||operation==='credentials')console.log(JSON.stringify({pending:true,callbackReference:job.callbackReference,data:{credentials:{password:'PENDING-MUST-NOT-BE-STORED'}}}));else if(operation==='console')console.log(JSON.stringify({data:{console:{url:'https://console.resource.invalid/sso?token=PRIVATE-SSO-TOKEN',expiresAt:new Date(Date.now()+120000).toISOString()}}}));else if(operation==='action'){if(job.payload.actionId==='resetPassword'&&job.payload.input.password!=='RESOURCE-INPUT-SECRET')process.exit(9);console.log('{}');}else process.exit(10);
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(fixtureDirectory, 'resource-fixture.json'),
        JSON.stringify({
          mode: 'command',
          executable: program,
          timeoutSeconds: 5,
          actions: ['resource'],
          callback: true,
          resource: capability,
        }),
        { mode: 0o600 },
      );
      const getService = () =>
        call(`/services/${service}/resource`, { cookie: customer.cookie });
      const create = (
        operation: string,
        extra: Record<string, unknown> = {},
        key = randomUUID(),
      ) =>
        call(`/services/${service}/resource/jobs`, {
          method: 'POST',
          cookie: customer.cookie,
          key,
          body: { operation, ...extra },
        });
      const waitJob = async (id: string, state = 'succeeded') => {
        for (let n = 0; n < 200; n++) {
          const row = (
            await database.query('SELECT * FROM jobs WHERE id=$1', [id])
          ).rows[0];
          if (row.state === state) return row;
          if (row.state === 'failed' || row.state === 'manual_review')
            assert.fail(JSON.stringify(row));
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.fail('资源任务未达到目标状态');
      };
      await context.test(
        '未声明或离线能力不显示，所有权与Cookie来源校验生效',
        async () => {
          assert.equal((await getService()).body.capability, null);
          assert.equal((await create('inspect')).status, 409);
          assert.equal(
            (
              await call(`/services/${foreignService}/resource`, {
                cookie: customer.cookie,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/services/${service}/resource/jobs`, {
                method: 'POST',
                cookie: customer.cookie,
                origin: 'https://wrong.invalid',
                key: randomUUID(),
                body: { operation: 'inspect' },
              })
            ).status,
            403,
          );
        },
      );
      // 实际生产Go入口加载受控程序、上报能力并消费本隔离库，不连接任何云服务。
      const listener2 = createServer();
      await new Promise<void>((resolve) =>
        listener2.listen(0, '127.0.0.1', resolve),
      );
      const callbackPort = (listener2.address() as { port: number }).port;
      await new Promise<void>((resolve) => listener2.close(() => resolve()));
      agent = spawn(
        'go',
        [
          'run',
          '.',
          '--plugins',
          fixtureDirectory,
          '--concurrency',
          '1',
          '--lease',
          '30s',
          '--poll',
          '100ms',
          '--callback-listen',
          `127.0.0.1:${callbackPort}`,
          '--callback-origin',
          `http://127.0.0.1:${callbackPort}`,
        ],
        {
          cwd: new URL('../../../agent/', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: address.href,
            AUDIT_KEY: sharedAuditKey,
            RESOURCE_KEY: resourceKey,
            PROVISION_CALLBACK_KEYS_JSON: JSON.stringify({
              'resource-fixture': callbackKey,
            }),
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      // API和Go必须使用同一个审计密钥，测试启动前已记录API密钥在process配置；此处用签名验证可定位差异。
      agent.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      agent.stderr?.on('data', (chunk) => {
        output += String(chunk);
      });
      for (let n = 0; n < 200; n++) {
        if ((await getService()).body.capability) break;
        if (agent.exitCode !== null) assert.fail(output.slice(-3000));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual((await getService()).body.capability, capability);
      let inspectJob = '',
        privateJob = '';
      await context.test(
        '真实程序执行状态查询，幂等只建一条任务，输入加密且公共结果无秘密',
        async () => {
          const key = randomUUID(),
            first = await create('inspect', {}, key);
          assert.equal(first.status, 201, JSON.stringify(first.body));
          inspectJob = first.body.id;
          assert.equal((await create('inspect', {}, key)).body.id, inspectJob);
          assert.equal((await create('metrics', {}, key)).status, 409);
          const job = await waitJob(inspectJob);
          assert.equal(job.result.data.fields.status, 'running');
          assert.equal(
            (
              await database.query('SELECT status FROM services WHERE id=$1', [
                service,
              ])
            ).rows[0].status,
            'active',
          );
          assert.match(job.payload.encryptedInput, /^v1\./);
          assert.ok(!('input' in job.payload));
          assert.equal(
            (
              await call(`/resource-jobs/${inspectJob}`, {
                cookie: another.cookie,
              })
            ).status,
            404,
          );
        },
      );
      await context.test(
        '破坏性动作和敏感输入必须本人密码，未知输入拒绝，实际解密仅交给受控程序',
        async () => {
          assert.equal(
            (await create('action', { actionId: 'reboot' })).status,
            409,
          );
          assert.equal(
            (
              await create('action', {
                actionId: 'reboot',
                password: 'wrong-password',
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await create('action', {
                actionId: 'resetPassword',
                input: { password: 'RESOURCE-INPUT-SECRET', unknown: 'bad' },
                password,
              })
            ).status,
            409,
          );
          const made = await create('action', {
            actionId: 'resetPassword',
            input: { password: 'RESOURCE-INPUT-SECRET' },
            password,
          });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          await waitJob(made.body.id);
          const text = JSON.stringify(
            (await database.query('SELECT payload,result,last_error FROM jobs'))
              .rows,
          );
          assert.ok(!text.includes('RESOURCE-INPUT-SECRET'));
        },
      );
      await context.test(
        '短期SSO真实来源白名单，私有结果单次复核读取，公共结果/任务/审计无令牌',
        async () => {
          const made = await create('console', { password });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          privateJob = made.body.id;
          const job = await waitJob(privateJob);
          assert.ok(job.result.data.privateAvailable);
          assert.ok(!JSON.stringify(job).includes('PRIVATE-SSO-TOKEN'));
          const privateRow = (
            await database.query(
              'SELECT ciphertext FROM resource_private_outputs WHERE job_id=$1',
              [privateJob],
            )
          ).rows[0];
          assert.match(privateRow.ciphertext, /^v1\./);
          assert.equal(
            (
              await call(`/resource-jobs/${privateJob}/private`, {
                method: 'POST',
                cookie: customer.cookie,
                body: { password: 'wrong-password' },
              })
            ).status,
            401,
          );
          const reads = await Promise.all(
            [0, 1].map(() =>
              call(`/resource-jobs/${privateJob}/private`, {
                method: 'POST',
                cookie: customer.cookie,
                body: { password },
              }),
            ),
          );
          assert.deepEqual(reads.map((item) => item.status).sort(), [201, 404]);
          const read = reads.find((item) => item.status === 201)!;
          assert.equal(read.status, 201, JSON.stringify(read.body));
          assert.match(read.body.console.url, /PRIVATE-SSO-TOKEN/);
          assert.equal(
            (
              await call(`/resource-jobs/${privateJob}/private`, {
                method: 'POST',
                cookie: customer.cookie,
                body: { password },
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/resource-jobs/${privateJob}`, {
                cookie: customer.cookie,
              })
            ).body.result.data.privateAvailable,
            false,
          );
        },
      );
      async function callback(
        id: string,
        result: unknown,
        status = 'succeeded',
        error = '',
      ) {
        const job = await waitJob(id, 'waiting'),
          path = `/callbacks/jobs/${id}`,
          timestamp = String(Math.floor(Date.now() / 1000)),
          nonce = randomUUID(),
          raw = JSON.stringify({
            provider: 'resource-fixture',
            jobId: id,
            reference: job.callback_reference,
            status,
            result,
            error,
          });
        const signature = createHmac('sha256', Buffer.from(callbackKey, 'hex'))
          .update(`POST\n${path}\n${timestamp}\n${nonce}\n${raw}\n`)
          .digest('hex');
        const headers = {
          'Content-Type': 'application/json',
          'X-Yunzou-Provider': 'resource-fixture',
          'X-Yunzou-Timestamp': timestamp,
          'X-Yunzou-Nonce': nonce,
          'X-Yunzou-Signature': signature,
        };
        return {
          raw,
          reply: await fetch(`http://127.0.0.1:${callbackPort}${path}`, {
            method: 'POST',
            headers,
            body: raw,
          }),
          again: () =>
            fetch(`http://127.0.0.1:${callbackPort}${path}`, {
              method: 'POST',
              headers,
              body: raw,
            }),
        };
      }
      await context.test(
        '异步凭据签名回调原子加密，等待态丢弃敏感Data，重放只保存一份',
        async () => {
          const made = await create('credentials', { password });
          assert.equal(made.status, 201);
          const pending = await waitJob(made.body.id, 'waiting');
          assert.ok(
            !JSON.stringify(pending).includes('PENDING-MUST-NOT-BE-STORED'),
          );
          const notification = await callback(made.body.id, {
            data: {
              credentials: {
                username: 'root',
                password: 'CALLBACK-PRIVATE-PASSWORD',
              },
            },
          });
          assert.equal(
            notification.reply.status,
            200,
            await notification.reply.text(),
          );
          assert.equal((await notification.again()).status, 200);
          const savedDigest = (
            await database.query(
              'SELECT body_hash FROM resource_callbacks WHERE job_id=$1',
              [made.body.id],
            )
          ).rows[0].body_hash;
          const plainDigest = digest(notification.raw);
          assert.notEqual(savedDigest, plainDigest);
          assert.equal(
            savedDigest,
            createHmac('sha256', Buffer.from(resourceKey, 'hex'))
              .update('resource-callback-body:v1:' + plainDigest)
              .digest('hex'),
          );

          await waitJob(made.body.id);
          assert.equal(
            (
              await database.query(
                'SELECT count(*) FROM resource_private_outputs WHERE job_id=$1',
                [made.body.id],
              )
            ).rows[0].count,
            '1',
          );
          const read = await call(`/resource-jobs/${made.body.id}/private`, {
            method: 'POST',
            cookie: customer.cookie,
            body: { password },
          });
          assert.equal(
            read.body.credentials.password,
            'CALLBACK-PRIVATE-PASSWORD',
          );
        },
      );
      await context.test(
        '监控只接声明字段和真实时间序列，失败回调不复制供应商秘密',
        async () => {
          const made = await create('metrics');
          assert.equal(made.status, 201);
          const notification = await callback(made.body.id, {
            data: {
              metrics: {
                traffic: [
                  {
                    at: new Date(Date.now() - 1000).toISOString(),
                    value: 1.25,
                  },
                  { at: new Date().toISOString(), value: 2.5 },
                ],
              },
            },
          });
          assert.equal(
            notification.reply.status,
            200,
            await notification.reply.text(),
          );
          const job = await waitJob(made.body.id);
          assert.equal(job.result.data.metrics.traffic.length, 2);
          const failed = await create('metrics');
          assert.equal(failed.status, 201);
          assert.equal(
            (
              await callback(
                failed.body.id,
                {},
                'failed',
                'secret-token=NEVER-LOG-THIS',
              )
            ).reply.status,
            200,
          );
          const saved = (
            await database.query('SELECT last_error FROM jobs WHERE id=$1', [
              failed.body.id,
            ])
          ).rows[0];
          assert.ok(!saved.last_error.includes('NEVER-LOG-THIS'));
          await database.query("UPDATE jobs SET state='failed' WHERE id=$1", [
            failed.body.id,
          ]);
        },
      );
      await context.test(
        '未决转移阻止资源操作，客户日志仅含自己实体与公开白名单，不返回details',
        async () => {
          await database.query(
            'INSERT INTO service_transfers(service_id,sender_id,recipient_id) VALUES($1,$2,$3)',
            [service, customer.id, another.id],
          );
          assert.equal((await create('inspect')).status, 409);
          await database.query(
            "UPDATE service_transfers SET status='cancelled',completed_at=now() WHERE service_id=$1",
            [service],
          );
          const own = await call('/activity', { cookie: customer.cookie });
          assert.equal(
            own.status,
            200,
            JSON.stringify(own.body) + output.slice(-1200),
          );
          assert.ok(
            own.body.items.some(
              (item: any) => item.action === 'resource.requested',
            ),
          );
          assert.ok(
            own.body.items.some(
              (item: any) => item.action === 'resource.completed',
            ),
          );
          assert.ok(
            own.body.items.every(
              (item: any) => !('details' in item) && !('actor' in item),
            ),
          );
          const other = await call('/activity', { cookie: another.cookie });
          assert.ok(
            !other.body.items.some(
              (item: any) =>
                item.target === service || item.target === inspectJob,
            ),
          );
        },
      );

      await context.test(
        '子账号按路由读取主账号资源，实际操作人可审计，敏感动作与私有读取不能委托',
        async () => {
          const email = `${randomUUID()}@resource-child.invalid`;
          emails.push(email);
          const made = await call('/contacts', {
            method: 'POST',
            cookie: customer.cookie,
            body: {
              name: '资源委托验收',
              email,
              permissions: [
                'GET /api/v1/services/:id/resource',
                'POST /api/v1/services/:id/resource/jobs',
                'GET /api/v1/resource-jobs/:id',
              ],
              loginEnabled: true,
              newPassword: password,
              password,
            },
          });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          const childId = made.body.childUserId;
          users.push(childId);
          const cookie = await login(email);
          assert.equal(
            (await call(`/services/${service}/resource`, { cookie })).status,
            200,
          );
          const inspect = await call(`/services/${service}/resource/jobs`, {
            method: 'POST',
            cookie,
            key: randomUUID(),
            body: { operation: 'inspect' },
          });
          assert.equal(inspect.status, 201, JSON.stringify(inspect.body));
          await waitJob(inspect.body.id);
          const row = (
            await database.query(
              'SELECT user_id,actor_id FROM resource_requests WHERE job_id=$1',
              [inspect.body.id],
            )
          ).rows[0];
          assert.equal(row.user_id, customer.id);
          assert.equal(row.actor_id, childId);
          assert.equal(
            (
              await call(`/services/${service}/resource/jobs`, {
                method: 'POST',
                cookie,
                key: randomUUID(),
                body: { operation: 'action', actionId: 'reboot', password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/resource-jobs/${privateJob}/private`, {
                method: 'POST',
                cookie,
                body: { password },
              })
            ).status,
            403,
          );
        },
      );
      await context.test(
        'Bearer仅能使用非敏感范围，撤销后不能排队或读取结果',
        async () => {
          const made = await call('/api-keys', {
            method: 'POST',
            cookie: customer.cookie,
            body: {
              name: '资源范围验收',
              permissions: [
                'GET /api/v1/services/:id/resource',
                'POST /api/v1/services/:id/resource/jobs',
                'GET /api/v1/resource-jobs/:id',
              ],
              password,
            },
          });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          keyIds.push(made.body.id);
          const bearer = made.body.token;
          assert.equal(
            (await call(`/services/${service}/resource`, { bearer })).status,
            200,
          );
          assert.equal(
            (
              await call(`/services/${service}/resource/jobs`, {
                method: 'POST',
                bearer,
                key: randomUUID(),
                body: { operation: 'credentials', password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/resource-jobs/${privateJob}/private`, {
                method: 'POST',
                bearer,
                body: { password },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call(`/api-keys/${made.body.id}`, {
                method: 'DELETE',
                cookie: customer.cookie,
                body: { password },
              })
            ).status,
            200,
          );
          assert.equal(
            (await call(`/services/${service}/resource`, { bearer })).status,
            401,
          );
        },
      );
      await context.test(
        '服务真实转移后旧发起人和新主人均不能读取旧私有结果，新主人可重新获取状态',
        async () => {
          const made = await create('console', { password });
          assert.equal(made.status, 201);
          await waitJob(made.body.id);
          await database.query(
            'UPDATE users SET email_verified_at=now() WHERE id=ANY($1::uuid[])',
            [[customer.id, another.id]],
          );
          const transfer = await call(`/services/${service}/transfer`, {
            method: 'POST',
            cookie: customer.cookie,
            body: { email: another.email, password },
          });
          assert.equal(transfer.status, 201, JSON.stringify(transfer.body));
          const accept = await call(
            `/service-transfers/${transfer.body.id}/accept`,
            { method: 'POST', cookie: another.cookie, body: { password } },
          );
          assert.equal(accept.status, 201, JSON.stringify(accept.body));
          assert.equal(
            (
              await call(`/resource-jobs/${made.body.id}/private`, {
                method: 'POST',
                cookie: customer.cookie,
                body: { password },
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await call(`/resource-jobs/${made.body.id}/private`, {
                method: 'POST',
                cookie: another.cookie,
                body: { password },
              })
            ).status,
            404,
          );
          assert.equal((await getService()).status, 404);
          const next = await call(`/services/${service}/resource/jobs`, {
            method: 'POST',
            cookie: another.cookie,
            key: randomUUID(),
            body: { operation: 'inspect' },
          });
          assert.equal(next.status, 201, JSON.stringify(next.body));
          await waitJob(next.body.id);
          const model = await call(`/services/${service}/resource`, {
            cookie: another.cookie,
          });
          assert.equal(model.status, 200);
          assert.equal(model.body.jobs.length, 1);
          assert.equal(model.body.jobs[0].id, next.body.id);
        },
      );
      await context.test(
        '已启用MFA的主账号必须同时提交第二因素，恢复码只能确认一次资源动作',
        async () => {
          const setup = await call('/auth/mfa/setup', {
            method: 'POST',
            cookie: another.cookie,
            body: { password },
          });
          assert.equal(setup.status, 201, JSON.stringify(setup.body));
          const confirm = await call('/auth/mfa/confirm', {
            method: 'POST',
            cookie: another.cookie,
            body: { code: totp(setup.body.secret) },
          });
          assert.equal(confirm.status, 201, JSON.stringify(confirm.body));
          another.cookie = confirm.cookie;
          tokens.push(confirm.cookie.split('=')[1]!);
          const request = (extra: Record<string, unknown>) =>
            call(`/services/${service}/resource/jobs`, {
              method: 'POST',
              cookie: another.cookie,
              key: randomUUID(),
              body: {
                operation: 'action',
                actionId: 'reboot',
                password,
                ...extra,
              },
            });
          assert.equal((await request({})).status, 401);
          const recoveryCode = confirm.body.recoveryCodes[0],
            made = await request({ recoveryCode });
          assert.equal(made.status, 201, JSON.stringify(made.body));
          await waitJob(made.body.id);
          assert.equal((await request({ recoveryCode })).status, 401);
        },
      );
      await context.test(
        '资源秘密从未写入jobs/result/error/审计，密文与追加授权不能被改写',
        async () => {
          const dump =
            JSON.stringify(
              (
                await database.query(
                  'SELECT payload,result,last_error FROM jobs',
                )
              ).rows,
            ) +
            JSON.stringify(
              (await database.query('SELECT details,canonical_body FROM audit'))
                .rows,
            );
          for (const secret of [
            'RESOURCE-INPUT-SECRET',
            'PRIVATE-SSO-TOKEN',
            'CALLBACK-PRIVATE-PASSWORD',
            'PENDING-MUST-NOT-BE-STORED',
            'NEVER-LOG-THIS',
          ]) {
            assert.ok(!dump.includes(secret), secret);
            assert.ok(!output.includes(secret), '日志中的秘密:' + secret);
          }
          assert.ok(!output.includes('RESOURCE-INPUT-SECRET'));
          let previous = '0'.repeat(64);
          for (const entry of (
            await database.query('SELECT * FROM audit ORDER BY id')
          ).rows) {
            assert.equal(entry.previous_hash, previous);
            assert.equal(
              createHmac('sha256', sharedAuditKey)
                .update(entry.canonical_body)
                .digest('hex'),
              entry.hash,
            );
            previous = entry.hash;
          }
          await assert.rejects(
            database.query(
              "UPDATE resource_requests SET action_id='override' WHERE job_id=$1",
              [inspectJob],
            ),
          );
          await assert.rejects(
            database.query(
              'DELETE FROM resource_private_outputs WHERE job_id=$1',
              [privateJob],
            ),
          );
        },
      );
    } finally {
      if (agent && agent.exitCode === null) {
        try {
          process.kill(-agent.pid!, 'SIGTERM');
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          process.kill(-agent.pid!, 'SIGKILL');
        } catch {}
      }
      if (fixtureDirectory)
        await rm(fixtureDirectory, { recursive: true, force: true });
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
