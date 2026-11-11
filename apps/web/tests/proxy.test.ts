/*
前端代理验收：真实启动生产Nitro，向本地回显服务转发请求，核对原始字节与可信代理边界。
调用：先npm run build --workspace @fuxoria/web，再node --import tsx --test apps/web/tests/proxy.test.ts。
本文件只用临时本机端口，不连接真实业务数据库或支付机构。
*/
import test from 'node:test'; // 使用Node自带测试执行器
import assert from 'node:assert/strict'; // 原始正文逐字节比较
import { createServer, type Server } from 'node:http'; // 独立回显服务不调用生产API
import { spawn, type ChildProcess } from 'node:child_process'; // 每组部署配置启动独立Nitro
import { once } from 'node:events'; // 等待真实监听与进程退出
import { fileURLToPath } from 'node:url'; // 从文件位置定位构建产物
import type { AddressInfo } from 'node:net'; // 临时端口由操作系统分配

const entry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url)); // 不依赖当前工作目录

async function listen(server: Server): Promise<number> {
  // 仅监听回环地址，临时端口由内核选择
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function run(
  rules: string,
  check: (origin: string, received: () => number) => Promise<void>,
) {
  let received = 0; // 无效配置不得触达上游
  const echo = createServer(async (request, response) => {
    received++;
    const chunks: Buffer[] = []; // 不解析或重编码收到的正文
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/currencies') { response.end(JSON.stringify([{code:'CNY',symbol:'¥',decimals:2}])); return; } // SSR公共插件读取真实币种合同，代理回显不冒充货币定义
    response.setHeader('Cache-Control', 'public, max-age=17'); // 验证上游公开缓存语义可被保留
    response.setHeader('Set-Cookie', 'proxy_test=opaque; Path=/; HttpOnly'); // 只用无权限的测试cookie
    response.end(
      JSON.stringify({
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('base64'),
      }),
    );
  });
  const upstream = await listen(echo); // 回显服务与真实API完全分离
  const reservation = createServer();
  const port = await listen(reservation); // 为独立Nitro取得一个空闲临时端口
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let process: ChildProcess | undefined;
  try {
    process = spawn(globalThis.process.execPath, [entry], {
      env: {
        ...globalThis.process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        NUXT_API_ORIGIN: `http://127.0.0.1:${upstream}`,
        NUXT_TRUST_PROXY_CIDRS: rules,
      },
      stdio: 'ignore',
    }); // 不输出或传递业务凭据给远端
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        if ((await fetch(origin)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* 只等待本机测试进程开始监听 */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, '生产前端测试进程未就绪，请先构建');
    await check(origin, () => received); // 真正发送HTTP请求验证边界
  } finally {
    if (process && process.exitCode === null) {
      process.kill('SIGTERM');
      await once(process, 'exit');
    }
    await new Promise<void>((resolve) => echo.close(() => resolve())); // 测试结束释放全部本机监听
  }
}

test('默认只认socket并保留Origin、查询、原始字节和上游响应', async () => {
  await run('', async (origin) => {
    const body = Buffer.from([0, 255, 123, 34, 228, 184, 173, 34, 125]); // 二进制正文可发现隐式JSON重编码
    const response = await fetch(`${origin}/api/v1/echo?a=1&a=2&symbol=%2B`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        origin: 'https://example.test',
        cookie: 'test=opaque',
        'x-forwarded-for': '203.0.113.8',
        'x-real-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.10',
      },
      body,
    });
    const result = (await response.json()) as {
      url: string;
      body: string;
      headers: Record<string, string>;
    };
    assert.equal(result.body, body.toString('base64'));
    assert.equal(result.url, '/api/v1/echo?a=1&a=2&symbol=%2B');
    assert.equal(result.headers.origin, 'https://example.test');
    assert.equal(result.headers.cookie, 'test=opaque');
    assert.match(result.headers['x-forwarded-for'], /^(?:::ffff:)?127\.0\.0\.1$/);
    assert.equal(result.headers['x-real-ip'], result.headers['x-forwarded-for']);
    assert.equal(result.headers.forwarded, '');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=17');
    assert.match(response.headers.get('set-cookie')!, /proxy_test=opaque/);
  });
});

test('只有明确可信CIDR才能提供转发链，遇到未信任节点立即停止', async () => {
  await run('127.0.0.1/32,10.0.0.0/8', async (origin) => {
    const trusted = (await (
      await fetch(`${origin}/api/v1/echo`, {
        headers: { 'x-forwarded-for': '198.51.100.7, 10.1.2.3' },
      })
    ).json()) as { headers: Record<string, string> };
    assert.equal(trusted.headers['x-forwarded-for'], '198.51.100.7');
    const stopped = (await (
      await fetch(`${origin}/api/v1/echo`, {
        headers: { 'x-forwarded-for': '198.51.100.8, 192.0.2.9' },
      })
    ).json()) as { headers: Record<string, string> };
    assert.equal(stopped.headers['x-forwarded-for'], '192.0.2.9');
  });
});

test('拒绝信任所有来源的部署配置', async () => {
  for (const rules of ['0.0.0.0/0', '::/0', 'true'])
    await run(rules, async (origin, received) => {
      const response = await fetch(`${origin}/api/v1/echo`, {
        headers: { 'x-forwarded-for': '198.51.100.9' },
      });
      assert.equal(response.status, 500);
      assert.equal(received(), 0);
    });
});

test('私有页面大小写与编码别名不进入共享缓存或上游', async () => {
  await run('', async (origin, received) => {
    for (const path of ['/Console', '/%63onsole', '/ADMIN', '/LogIn', '/aPi/v1/echo', '/Recover', '/%76erify-login', '/Verify-register', '/OAuth/confirm']) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    assert.equal(received(), 0); // 被拒绝的别名绝不转发到业务API
  });
});

test('新增认证入口与OAuth确认使用私有缓存', async () => {
  await run('', async origin => {
    for (const path of ['/recover','/verify-login','/verify-register','/oauth/confirm']) {
      const response=await fetch(`${origin}${path}`);
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
    }
  });
}); // 登录凭据页面的标准路径和拒绝的别名使用同一隐私边界

test('公开文章和页面不存在时保留HTTP404并禁止缓存', async () => {
  await run('', async (origin) => {
    for (const path of ['/help/absent-qa', '/news/absent-qa', '/absent-qa']) {
      for (const accept of ['text/html', '*/*', 'application/json']) for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${origin}${path}`, { method, headers: { accept } });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      }
    }
  });
});
