/* 微信网站扫码真实HTTP回归：独立PostgreSQL/Redis、生产OAuth控制器和本机微信协议服务器。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/wechat.integration.test.ts。
 * 模拟服务器只接受appid授权、GET换码和openid资料请求，不请求真实微信或创建外部账号。
 */
import 'reflect-metadata';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { hash } from 'argon2';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { totp } from '../src/utils/otp.js';
import { verifyAudit } from '../../../scripts/verify-audit.js';

if (!process.env.DATABASE_URL) process.loadEnvFile(new URL('../../../.env', import.meta.url));
const source = process.env.DATABASE_URL!;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source).hostname));
const database = 'yunzou_wechat_' + randomUUID().replaceAll('-', ''), master = new pg.Client({ connectionString: source }), address = new URL(source);
address.pathname = '/' + database;
process.env.DATABASE_URL = address.href;
process.env.NODE_ENV = 'test';
process.env.AUDIT_KEY = randomBytes(32).toString('hex');
process.env.TOTP_KEY = randomBytes(32).toString('hex');
delete process.env.OAUTH_WECHAT_APP_ID;
delete process.env.OAUTH_WECHAT_APP_SECRET;
const { pool, redis } = await import('../src/features/store.js');
const { Access, tokenHash } = await import('../src/utils/access.js');
const OAuth = (await import('../src/features/oauth.js')).default;
const Account = (await import('../src/features/account.js')).default;
const Security = (await import('../src/features/security.js')).default;
class Application {}
Module({ controllers: [OAuth, Account, Security] })(Application);
type Jar = Map<string, string>;
type Actor = { id: string; email: string; jar: Jar };
const password = 'Wechat-isolated-password-2026', appid = 'wx-isolated-application', secret = randomBytes(24).toString('hex');
const ip = '198.18.' + randomBytes(1)[0] + '.' + randomBytes(1)[0]; // 每次真实HTTP测试使用独立来源限额，不清除共享本机额度
const sessions = new Set<string>(), states = new Set<string>(), tickets = new Set<string>(), users: string[] = [];
const codes = new Map<string, { openid: string; mode: string }>(), tokens = new Map<string, { openid: string; mode: string }>();
let created = false, app: INestApplication, base = '', origin = '', providerOrigin = '', alice: Actor, bob: Actor;
let openid = 'openid-alice', mode = 'normal', exchanges = 0, profileCalls = 0;
const protocolErrors: unknown[] = [];
const issuer = createServer(async (request, response) => {
  const reply = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
  try {
    const url = new URL(request.url!, providerOrigin);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, undefined);
    if (url.pathname === '/connect/qrconnect') {
      assert.equal(url.searchParams.get('appid'), process.env.OAUTH_WECHAT_APP_ID);
      assert.equal(url.searchParams.get('scope'), 'snsapi_login');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/v1/oauth/wechat/callback');
      assert.match(url.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
      for (const field of ['client_id', 'secret', 'code_challenge', 'code_challenge_method']) assert.equal(url.searchParams.has(field), false);
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { openid, mode });
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code }).toString();
      response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (url.pathname === '/sns/oauth2/access_token') {
      exchanges++;
      assert.equal(url.searchParams.get('appid'), process.env.OAUTH_WECHAT_APP_ID);
      assert.equal(url.searchParams.get('secret'), secret);
      assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
      for (const field of ['client_id', 'client_secret', 'code_verifier']) assert.equal(url.searchParams.has(field), false);
      const code = url.searchParams.get('code')!, saved = codes.get(code); codes.delete(code);
      if (!saved) return reply({ errcode: 40029, errmsg: 'invalid code' });
      if (saved.mode === 'token-error') return reply({ errcode: 40029, errmsg: 'invalid code' });
      const token = randomBytes(24).toString('base64url'); tokens.set(token, saved);
      return reply({ access_token: token, expires_in: 7200, refresh_token: 'unused-refresh', openid: saved.mode === 'missing-openid' ? undefined : saved.openid, scope: saved.mode === 'wrong-scope' ? 'snsapi_userinfo' : 'snsapi_login', unionid: 'shared-unionid' });
    }
    if (url.pathname === '/sns/userinfo') {
      profileCalls++;
      const saved = tokens.get(url.searchParams.get('access_token')!);
      assert.ok(saved);
      assert.equal(url.searchParams.get('openid'), saved.openid);
      assert.equal(url.searchParams.get('lang'), 'zh_CN');
      if (saved.mode === 'profile-error') return reply({ errcode: 40003, errmsg: 'invalid openid' });
      if (saved.mode === 'redirect') { response.writeHead(302, { location: providerOrigin + '/forbidden-follow' }); response.end(); return; }
      if (saved.mode === 'oversize') return reply({ openid: saved.openid, nickname: 'x'.repeat(262145) });
      return reply({ openid: saved.mode === 'mismatched-openid' ? 'openid-mismatch' : saved.openid, nickname: '微信回归用户', unionid: 'shared-unionid', email: alice?.email });
    }
    throw new Error('未授权的本机协议路径：' + url.pathname);
  } catch (error) { protocolErrors.push(error); response.statusCode = 500; reply({ errcode: 500, errmsg: 'protocol assertion failed' }); }
});
function receiveCookies(response: globalThis.Response, jar: Jar) {
  for (const value of response.headers.getSetCookie()) {
    const part = value.split(';')[0]!, split = part.indexOf('='), key = part.slice(0, split), token = decodeURIComponent(part.slice(split + 1));
    if (!token || /max-age=0/i.test(value)) jar.delete(key); else jar.set(key, token);
    if (key === 'yunzou_session' && token) sessions.add(tokenHash(token));
    if (key === 'yunzou_oauth_result' && token) tickets.add(tokenHash(token));
  }
}
async function http(path: string, jar: Jar = new Map(), method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Origin: origin, 'X-Forwarded-For': ip, ...(jar.size ? { Cookie: [...jar].map(([key, value]) => key + '=' + encodeURIComponent(value)).join('; ') } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  receiveCookies(response, jar);
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, data };
}
function okay(result: Awaited<ReturnType<typeof http>>) { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.data)); return result.data; }
async function actor(): Promise<Actor> {
  const email = randomUUID() + '@wechat.test', row = (await pool.query('INSERT INTO users(email,name,password) VALUES($1,$2,$3) RETURNING id', [email, '微信协议回归', await hash(password)])).rows[0]; users.push(row.id);
  const jar = new Map(); okay(await http('/auth/login', jar, 'POST', { email, password })); return { id: row.id, email, jar };
}
async function authorize(jar: Jar, bind = false, extra: Record<string, unknown> = {}) {
  const result = okay(await http('/oauth/wechat/' + (bind ? 'bind' : 'start'), jar, 'POST', bind ? { password, ...extra } : { next: '/console', ...extra }));
  const url = new URL(result.url); states.add(tokenHash(url.searchParams.get('state')!));
  assert.equal(url.hash, '#wechat_redirect');
  const response = await fetch(url, { redirect: 'manual' }); assert.equal(response.status, 302);
  return new URL(response.headers.get('location')!);
}
function callback(url: URL, jar: Jar) { return http(url.pathname.replace('/api/v1', '') + url.search, jar); }
before(async () => {
  await master.connect(); await master.query(`CREATE DATABASE "${database}"`); created = true;
  const root = new URL('../../../database/migrations/', import.meta.url), chosen = new Map<string, string>();
  for (const file of (await readdir(root)).filter(file => file.endsWith('.sql') || file.endsWith('.draft')).sort()) { const key = file.slice(0, 3); if (!chosen.has(key) || file.endsWith('.sql')) chosen.set(key, file); }
  for (const file of [...chosen.values()].sort()) await pool.query(await readFile(new URL(file, root), 'utf8'));
  await redis.connect(); await new Promise<void>(resolve => issuer.listen(0, '127.0.0.1', resolve)); providerOrigin = 'http://127.0.0.1:' + (issuer.address() as { port: number }).port;
  process.env.OAUTH_WECHAT_TEST_AUTHORIZATION_URL = providerOrigin + '/connect/qrconnect'; process.env.OAUTH_WECHAT_TEST_TOKEN_URL = providerOrigin + '/sns/oauth2/access_token'; process.env.OAUTH_WECHAT_TEST_USERINFO_URL = providerOrigin + '/sns/userinfo';
  app = await NestFactory.create(Application, { logger: false }); app.getHttpAdapter().getInstance().set('trust proxy', 'loopback'); app.setGlobalPrefix('api/v1'); app.use(cookieParser()); app.useGlobalGuards(new Access()); await app.listen(0, '127.0.0.1'); origin = await app.getUrl(); base = origin + '/api/v1'; process.env.PUBLIC_ORIGIN = origin;
  alice = await actor(); bob = await actor();
});
after(async () => {
  if (app) await app.close(); await new Promise<void>(resolve => issuer.close(() => resolve()));
  if (redis.isOpen) { for (const key of sessions) await redis.del('session:' + key); for (const key of states) await redis.del('oauth-state:' + key); for (const key of tickets) await redis.del('oauth-pending:' + key); for (const id of users) await redis.del(['account-proof:user:' + id, 'account-factor:' + id]); await redis.del(['oauth-rate:' + tokenHash(ip), 'account-proof:ip:' + tokenHash(ip), 'login:' + tokenHash(ip)]); await redis.quit(); }
  await pool.end(); if (created) await master.query(`DROP DATABASE "${database}" WITH (FORCE)`); await master.end(); assert.deepEqual(protocolErrors, []);
});

test('微信凭据缺失时不显示入口；配置完整后由目录自动发现并明确无PKCE', async () => {
  assert.equal(okay(await http('/oauth/providers')).some((item: any) => item.id === 'wechat'), false);
  process.env.OAUTH_WECHAT_APP_ID = appid;
  assert.equal(okay(await http('/oauth/providers')).some((item: any) => item.id === 'wechat'), false);
  assert.equal((await http('/oauth/wechat/start', new Map(), 'POST', {})).status, 400);
  process.env.OAUTH_WECHAT_APP_SECRET = secret;
  assert.deepEqual(okay(await http('/oauth/providers')).find((item: any) => item.id === 'wechat'), { id: 'wechat', name: '微信扫码', kind: 'oauth2', pkce: false });
});
test('同邮箱或UnionID的未绑定微信身份不会登录、注册或接管账户', async () => {
  const jar: Jar = new Map(), before = (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
  assert.equal((await callback(await authorize(jar), jar)).headers.get('location'), origin + '/login?oauth=unbound');
  assert.equal(jar.has('yunzou_session'), false); assert.equal((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n, before);
});
test('本人密码发起绑定，GET换码和openid资料匹配，state跨浏览器与回放均拒绝', async () => {
  assert.equal((await http('/oauth/wechat/bind', new Map(), 'POST', { password })).status, 401);
  assert.equal((await http('/oauth/wechat/bind', alice.jar, 'POST', { password: 'incorrect' })).status, 401);
  const url = await authorize(alice.jar, true), before = exchanges;
  assert.equal((await callback(url, new Map())).headers.get('location'), origin + '/login?oauth=failed'); assert.equal(exchanges, before);
  assert.equal((await callback(url, alice.jar)).headers.get('location'), origin + '/console/identity'); assert.equal(exchanges, before + 1);
  const binding = (await pool.query("SELECT * FROM oauth_bindings WHERE provider='wechat'")).rows[0]; assert.equal(binding.user_id, alice.id); assert.equal(binding.subject, appid + ':openid-alice');
  assert.equal((await callback(url, alice.jar)).headers.get('location'), origin + '/login?oauth=failed'); assert.equal(exchanges, before + 1);
  assert.equal((await callback(await authorize(bob.jar, true), bob.jar)).headers.get('location'), origin + '/login?oauth=failed'); assert.equal((await pool.query("SELECT count(*)::int n FROM oauth_bindings WHERE provider='wechat'")).rows[0].n, 1);
});
test('微信错误码、缺少openid、错误scope、资料身份错配和重定向不能签发票据', async () => {
  for (const bad of ['token-error', 'missing-openid', 'wrong-scope', 'profile-error', 'mismatched-openid', 'redirect', 'oversize']) {
    mode = bad; const jar: Jar = new Map(); assert.equal((await callback(await authorize(jar), jar)).headers.get('location'), origin + '/login?oauth=failed'); assert.equal(jar.has('yunzou_oauth_result'), false); assert.equal(jar.has('yunzou_session'), false);
  }
  mode = 'normal'; assert.ok(profileCalls > 0);
});
test('openid按应用隔离，正常微信登录仍需消费一次本地确认票据', async () => {
  process.env.OAUTH_WECHAT_APP_ID = 'wx-another-application'; const isolated: Jar = new Map();
  try { assert.equal((await callback(await authorize(isolated), isolated)).headers.get('location'), origin + '/login?oauth=unbound'); } finally { process.env.OAUTH_WECHAT_APP_ID = appid; }
  const jar: Jar = new Map(), url = await authorize(jar), before = exchanges;
  const replies = await Promise.all([callback(url, jar), callback(url, jar)]); assert.equal(replies.filter(reply => reply.headers.get('location') === origin + '/oauth/complete').length, 1); assert.equal(exchanges, before + 1); assert.equal(jar.has('yunzou_session'), false);
  assert.equal(okay(await http('/oauth/pending', jar)).factorRequired, false);
  const completed = await Promise.all([http('/oauth/complete', jar, 'POST', {}), http('/oauth/complete', jar, 'POST', {})]); assert.equal(completed.filter(reply => reply.status === 201).length, 1); assert.equal(okay(await http('/auth/me', jar)).id, alice.id);
});
test('微信登录保留本地MFA，解绑必须本人证明并撤销全部旧会话', async () => {
  const setup = okay(await http('/auth/mfa/setup', alice.jar, 'POST', { password })), enabled = okay(await http('/auth/mfa/confirm', alice.jar, 'POST', { code: totp(setup.secret) }));
  const jar: Jar = new Map(); await callback(await authorize(jar), jar); assert.equal(okay(await http('/oauth/pending', jar)).factorRequired, true);
  assert.equal((await http('/oauth/complete', jar, 'POST', {})).status, 401); okay(await http('/oauth/complete', jar, 'POST', { recoveryCode: enabled.recoveryCodes[0] })); assert.equal(okay(await http('/auth/me', jar)).id, alice.id);
  const binding = okay(await http('/oauth/bindings', alice.jar))[0]; assert.equal((await http('/oauth/bindings/' + binding.id, alice.jar, 'DELETE', { password: 'wrong' })).status, 401);
  okay(await http('/oauth/bindings/' + binding.id, alice.jar, 'DELETE', { password, recoveryCode: enabled.recoveryCodes[1] })); assert.equal((await http('/auth/me', jar)).status, 401); assert.equal((await http('/auth/me', alice.jar)).status, 401);
  assert.equal((await pool.query("SELECT count(*)::int n FROM oauth_bindings WHERE provider='wechat'")).rows[0].n, 0); assert.ok((await verifyAudit(pool, process.env.AUDIT_KEY!)).count > 0);
});
