/* 实名与OAuth真实HTTP回归：独立PostgreSQL/Redis、私有加密材料、本机签名OIDC授权服务器。
 * 调用：node --env-file=.env --import tsx --test apps/api/tests/identity-provider.integration.test.ts。
 * 测试使用合成身份与临时凭据，授权服务器实际检查code、PKCE与redirect_uri。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { readdir, readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { hash, argon2id } from "argon2";
import pg from "pg";
import { createClient } from "redis";
import { totp } from "../src/utils/otp.js";
import { verifyAudit } from "../../../scripts/verify-audit.js";
const digest = value => createHash("sha256").update(value).digest("hex");
test("实名材料与OAuth授权在真实HTTP中保持历史、隐私和身份边界", {
  timeout: 120000
}, async context => {
  const source = process.env.DATABASE_URL;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(source).hostname));
  const name = "yunzou_verification_" + randomBytes(8).toString("hex"),
    address = new URL(source);
  address.pathname = "/" + name;
  const master = new pg.Client({
      connectionString: source
    }),
    database = new pg.Pool({
      connectionString: address.href
    }),
    cache = createClient({
      url: process.env.REDIS_URL
    });
  const directory = await mkdtemp(join(tmpdir(), "yunzou-verification-")),
    password = "Verification-" + randomBytes(12).toString("hex"),
    audit = randomBytes(32).toString("hex");
  const tokens = new Set(),
    states = new Set(),
    tickets = new Set(),
    users = [],
    emails = [];
  const ip = "198.18." + randomBytes(1)[0] + "." + randomBytes(1)[0];
  let server,
    issuer,
    created = false,
    logs = "",
    base = "",
    origin = "",
    providerOrigin = "",
    subject = "external-alice",
    mode = "normal",
    tokenExchanges = 0;
  const elliptic = generateKeyPairSync('ec',{namedCurve:'prime256v1'}),ellipticJwk=elliptic.publicKey.export({format:'jwk'});
  const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048
    }),
    publicJwk = pair.publicKey.export({
      format: "jwk"
    }),
    codes = new Map(),
    access = new Map();
  function cookies(response, jar) {
    for (const value of response.headers.getSetCookie()) {
      const [part] = value.split(";"),
        at = part.indexOf("="),
        key = part.slice(0, at),
        value_ = decodeURIComponent(part.slice(at + 1));
      if (/max-age=0/i.test(value) || !value_) jar.delete(key);else jar.set(key, value_);
      if (key === "yunzou_session" && value_) tokens.add(value_);
      if (key === "yunzou_oauth_result" && value_) tickets.add(value_);
    }
  }
  cookies;
  async function call(path, jar = new Map(), method = "GET", body, raw = false) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "X-Forwarded-For": ip,
        ...(jar.size ? {
          Cookie: [...jar].map(([key, value]) => key + "=" + encodeURIComponent(value)).join("; ")
        } : {}),
        ...(body !== void 0 ? {
          "Content-Type": raw ? "application/octet-stream" : "application/json"
        } : {})
      },
      ...(body !== void 0 ? {
        body: raw ? body : JSON.stringify(body)
      } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    cookies(response, jar);
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      data,
      headers: response.headers
    };
  }
  call;
  function ok(result) {
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.data));
    return result.data;
  }
  ok;
  async function actor(role = "customer") {
    const email = randomUUID() + "@verification.test",
      id = randomUUID();
    users.push(id);
    emails.push(email);
    await database.query("INSERT INTO users(id,email,name,password,role) VALUES($1,$2,$3,$4,$5)", [id, email, "核验测试用户", await hash(password, {
      type: argon2id
    }), role]);
    const jar = new Map();
    ok(await call("/auth/login", jar, "POST", {
      email,
      password
    }));
    return {
      id,
      email,
      jar
    };
  }
  actor;
  async function authorize(jar, bind = false, extra = {}, channel = 'oidc') {
    const result = ok(await call("/oauth/" + channel + "/" + (bind ? "bind" : "start"), jar, "POST", bind ? {
      password,
      ...extra
    } : {
      next: "/console",
      ...extra
    }));
    const url = new URL(result.url);
    states.add(url.searchParams.get("state"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), origin + "/api/v1/oauth/" + channel + "/callback");
    const response = await fetch(url, {
      redirect: "manual"
    });
    assert.equal(response.status, 302);
    return new URL(response.headers.get("location"));
  }
  authorize;
  async function callback(url, jar) {
    return call(url.pathname.replace("/api/v1", "") + url.search, jar);
  }
  callback;
  try {
    await master.connect();
    await master.query(`CREATE DATABASE ${name}`);
    created = true;
    await cache.connect();
    await database.query("CREATE TABLE migrations(name text PRIMARY KEY,hash text NOT NULL)");
    const root = new URL("../../../database/migrations/", import.meta.url),
      files = (await readdir(root)).filter(file => file.endsWith(".sql") || /^026_.*\.draft$/.test(file)).sort();
    for (const file of files) {
      const sql = await readFile(new URL(file, root), "utf8");
      await database.query(sql);
      await database.query("INSERT INTO migrations(name,hash)VALUES($1,$2)", [file, digest(sql)]);
    }
    issuer = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, providerOrigin);
        response.setHeader("content-type", "application/json");
        if (url.pathname === "/authorize") {
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          assert.ok(['oidc','oauth2'].some(channel=>url.searchParams.get('redirect_uri')===origin+'/api/v1/oauth/'+channel+'/callback'));
          const code = randomBytes(24).toString("base64url");
          codes.set(code, {
            challenge: url.searchParams.get("code_challenge"),
            nonce: url.searchParams.get("nonce"),
            redirect: url.searchParams.get("redirect_uri"),
            subject
          });
          const target = new URL(url.searchParams.get("redirect_uri"));
          target.search = new URLSearchParams({
            code,
            state: url.searchParams.get("state"),
            ...(target.pathname.includes('/oidc/')?{iss:providerOrigin}:{}),
            session_state: "provider-session-extension"
          }).toString();
          response.writeHead(302, {
            location: target.href
          });
          response.end();
          return;
        }
        if (url.pathname === "/jwks") {
          response.end(JSON.stringify({
            keys: [{
              ...(mode==='ec'?ellipticJwk:publicJwk),
              kid: "test-key",
              alg: mode==='ec'?'ES256':'RS256',
              use: "sig"
            }]
          }));
          return;
        }
        if (url.pathname === "/token") {
          let raw = "";
          for await (const chunk of request) raw += chunk;
          const input = new URLSearchParams(raw),
            saved = codes.get(input.get("code"));
          if (!saved || input.get("client_id") !== "test-client" || input.get("client_secret") !== "test-secret" || input.get("redirect_uri") !== saved.redirect || createHash("sha256").update(input.get("code_verifier") ?? "").digest("base64url") !== saved.challenge) {
            response.writeHead(400);
            response.end(JSON.stringify({
              error: "invalid_grant"
            }));
            return;
          }
          codes.delete(input.get("code"));
          tokenExchanges++;
          const accessToken = randomBytes(32).toString("base64url");
          access.set(accessToken, saved.subject);
          const encoded = value => Buffer.from(JSON.stringify(value)).toString("base64url"),
            header = encoded({
            alg: mode==='ec'?'ES256':'RS256',
              kid: "test-key"
            }),
            claims = encoded({
              iss: providerOrigin,
              aud: mode === "audience" ? "attacker-client" : "test-client",
              sub: saved.subject,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 300,
              nonce: mode === "nonce" ? "wrong-nonce" : saved.nonce
            }),
            content = header + "." + claims,
            signature = mode === "signature" ? randomBytes(256) : mode==='ec'?sign('sha256',Buffer.from(content),{key:elliptic.privateKey,dsaEncoding:'ieee-p1363'}):sign("sha256", Buffer.from(content), pair.privateKey);
          response.end(JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            id_token: content + "." + signature.toString("base64url")
          }));
          return;
        }
        if (url.pathname === "/userinfo") {
          const saved = access.get(request.headers.authorization?.replace("Bearer ", "") ?? "");
          if (!saved) {
            response.writeHead(401);
            response.end("{}");
            return;
          }
          response.end(JSON.stringify({
            sub: saved,
            id: saved,
            name: "第三方测试身份",
            email: emails[0]
          }));
          return;
        }
        response.writeHead(404);
        response.end("{}");
      } catch {
        response.writeHead(500);
        response.end("{}");
      }
    });
    await new Promise(resolve => issuer.listen(0, "127.0.0.1", resolve));
    providerOrigin = "http://127.0.0.1:" + issuer.address().port;
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(() => resolve()));
    origin = "http://127.0.0.1:" + port;
    base = origin + "/api/v1";
    server = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
      cwd: new URL("../../../", import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL: address.href,
        AUDIT_KEY: audit,
        TOTP_KEY: randomBytes(32).toString("hex"),
        CERTIFICATION_KEY: randomBytes(32).toString("hex"),
        CERTIFICATION_STORAGE_DIR: directory,
        PUBLIC_ORIGIN: origin,
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        OAUTH_OIDC_CLIENT_ID: "test-client",
        OAUTH_OIDC_CLIENT_SECRET: "test-secret",
        OAUTH_OIDC_AUTHORIZATION_URL: providerOrigin + "/authorize",
        OAUTH_OIDC_TOKEN_URL: providerOrigin + "/token",
        OAUTH_OIDC_USERINFO_URL: providerOrigin + "/userinfo",
        OAUTH_OIDC_JWKS_URL: providerOrigin + "/jwks",
        OAUTH_OIDC_ISSUER: providerOrigin,
        OAUTH_OAUTH2_CLIENT_ID: 'test-client',OAUTH_OAUTH2_CLIENT_SECRET: 'test-secret',OAUTH_OAUTH2_AUTHORIZATION_URL: providerOrigin+'/authorize',OAUTH_OAUTH2_TOKEN_URL: providerOrigin+'/token',OAUTH_OAUTH2_USERINFO_URL: providerOrigin+'/userinfo'
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const keep = value => {
      logs = (logs + value.toString()).slice(-6000);
    };
    server.stdout?.on("data", keep);
    server.stderr?.on("data", keep);
    let ready = false;
    for (let n = 0; n < 150; n++) {
      try {
        ready = (await fetch(base + "/health")).ok;
      } catch {}
      if (ready) break;
      if (server.exitCode !== null) throw new Error("核验API启动失败：" + logs);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.ok(ready, "核验API未启动：" + logs);
    const alice = await actor(),
      bob = await actor(),
      admin = await actor("admin");
    await context.test("个人资料与材料加密，遮盖读取、越权拒绝和真实访问审计", async () => {
      const number = "SYNTHETIC-ID-0001",
        saved = ok(await call("/certifications", alice.jar, "POST", {
          kind: "personal",
          name: "合成证件甲",
          documentNumber: number,
          password
        }));
      const row = (await database.query("SELECT * FROM certifications WHERE id=$1", [saved.id])).rows[0];
      assert.ok(!row.encrypted_details.includes(number) && !row.encrypted_details.includes("合成证件甲"));
      assert.equal(row.status, "pending");
      assert.equal(row.method, "manual");
      const listed = ok(await call("/certifications", alice.jar));
      assert.ok(!JSON.stringify(listed).includes(number));
      assert.equal((await call(`/admin/certifications/${saved.id}/reveal`, bob.jar, "POST", {
        password,
        reason: "越权访问"
      })).status, 403);
      const proof = {
          password,
          reason: "本轮人工材料核验"
        },
        empty = {
          ...proof,
          decision: "approved",
          reviewReference: "TEST-REVIEW-1",
          reviewedEvidence: true
        };
      assert.equal((await call(`/admin/certifications/${saved.id}/decision`, admin.jar, "POST", empty)).status, 409);
      const content = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("synthetic-private-proof")]);
      const file = ok(await call(`/certifications/${saved.id}/files`, alice.jar, "POST", content, true));
      assert.equal((await stat(join(directory, file.id + ".enc"))).mode & 511, 384);
      assert.equal((await stat(directory)).mode & 511, 448);
      assert.ok(!(await readFile(join(directory, file.id + ".enc"))).includes(Buffer.from("synthetic-private-proof")));
      assert.equal((await call(`/certifications/${saved.id}/files`, bob.jar, "POST", content, true)).status, 404);
      assert.equal((await call(`/certifications/${saved.id}/files`, alice.jar, "POST", Buffer.from("<script>fake</script>"), true)).status, 400);
      const details = ok(await call(`/admin/certifications/${saved.id}/reveal`, admin.jar, "POST", proof));
      assert.equal(details.details.documentNumber, number);
      assert.equal(details.verificationSource, "manual");
      assert.equal(details.files.length, 1);
      const opened = await call(`/admin/certifications/${saved.id}/files/${file.id}/open`, admin.jar, "POST", proof);
      ok(opened);
      assert.deepEqual(opened.data, content);
      assert.equal(opened.headers.get("cache-control"), "private, no-store");
      assert.equal((await database.query("SELECT count(*)::int n FROM audit WHERE target=$1 AND action IN('certification.reveal','certification.material.read')", [saved.id])).rows[0].n, 2);
      ok(await call(`/admin/certifications/${saved.id}/decision`, admin.jar, "POST", empty));
      assert.equal((await call(`/admin/certifications/${saved.id}/decision`, admin.jar, "POST", empty)).status, 409);
      const enterprise = ok(await call("/certifications", alice.jar, "POST", {
        kind: "enterprise",
        name: "合成代表人",
        documentNumber: "SYNTHETIC-PERSON-2",
        company: "合成测试企业",
        registrationNumber: "SYNTHETIC-BUSINESS-0001",
        password
      }));
      const history = ok(await call("/certifications", alice.jar));
      assert.equal(history.find(item => item.id === enterprise.id).previousId, saved.id);
      assert.equal(history.find(item => item.id === saved.id).status, "approved");
      ok(await call(`/certifications/${enterprise.id}/withdraw`, alice.jar, "POST", {
        password
      }));
      await assert.rejects(() => database.query("UPDATE certifications SET encrypted_details='changed' WHERE id=$1", [saved.id]), /历史只能追加/);
    });
    await context.test("同email未绑定身份不会登录、注册或抢占现有账户", async () => {
      const jar = new Map(),
        before = (await database.query("SELECT count(*)::int n FROM users")).rows[0].n;
      const reply = await callback(await authorize(jar), jar);
      assert.equal(reply.status, 302);
      assert.equal(reply.headers.get("location"), origin + "/login?oauth=unbound");
      assert.equal(jar.has("yunzou_session"), false);
      assert.equal((await database.query("SELECT count(*)::int n FROM users")).rows[0].n, before);
      assert.equal((await database.query("SELECT count(*)::int n FROM oauth_bindings")).rows[0].n, 0);
    });
    await context.test("真实PKCE授权绑定、浏览器state隔离、回放拒绝和subject唯一归属", async () => {
      const url = await authorize(alice.jar, true),
        before = tokenExchanges;
      assert.equal((await callback(url, new Map())).headers.get("location"), origin + "/login?oauth=failed");
      assert.equal(tokenExchanges, before);
      const reply = await callback(url, alice.jar);
      assert.equal(reply.headers.get("location"), origin + "/console/identity");
      assert.equal((await database.query("SELECT user_id FROM oauth_bindings")).rows[0].user_id, alice.id);
      assert.equal((await callback(url, alice.jar)).headers.get("location"), origin + "/login?oauth=failed");
      assert.equal(tokenExchanges, before + 1);
      const stolen = await callback(await authorize(bob.jar, true), bob.jar);
      assert.equal(stolen.headers.get("location"), origin + "/login?oauth=failed");
      assert.equal((await database.query("SELECT user_id FROM oauth_bindings")).rows[0].user_id, alice.id);
      const jar = new Map();
      assert.equal((await callback(await authorize(jar), jar)).headers.get("location"), origin + "/oauth/complete");
      assert.equal(ok(await call("/oauth/pending", jar)).factorRequired, false);
      ok(await call("/oauth/complete", jar, "POST", {}));
      assert.equal(ok(await call("/auth/me", jar)).id, alice.id);
      assert.equal((await call("/oauth/complete", jar, "POST", {})).status, 400);
    });
    await context.test("OIDC错签名、nonce和audience都不能签发本地会话", async () => {
      for (mode of ["signature", "nonce", "audience"]) {
        const jar = new Map();
        const reply = await callback(await authorize(jar), jar);
        assert.equal(reply.headers.get("location"), origin + "/login?oauth=failed");
        assert.equal(jar.has("yunzou_session"), false);
        assert.equal(jar.has("yunzou_oauth_result"), false);
      }
      mode = "normal";
    });
    await context.test('OIDC的ES256公钥和标准P1363签名可完成真实授权',async()=>{mode='ec';const jar=new Map();assert.equal((await callback(await authorize(jar),jar)).headers.get('location'),origin+'/oauth/complete');ok(await call('/oauth/complete',jar,'POST',{}));assert.equal(ok(await call('/auth/me',jar)).id,alice.id);mode='normal';});
    await context.test('OAuth2独立通道使用Bearer用户资料的稳定subject进行绑定和登录',async()=>{
      subject='external-bob-oauth2';const bound=await callback(await authorize(bob.jar,true,{},'oauth2'),bob.jar);assert.equal(bound.headers.get('location'),origin+'/console/identity');
      const jar=new Map();const login=await callback(await authorize(jar,false,{},'oauth2'),jar);assert.equal(login.headers.get('location'),origin+'/oauth/complete');ok(await call('/oauth/complete',jar,'POST',{}));assert.equal(ok(await call('/auth/me',jar)).id,bob.id);
      const binding=ok(await call('/oauth/bindings',bob.jar)).find(item=>item.provider==='oauth2');ok(await call('/oauth/bindings/'+binding.id,bob.jar,'DELETE',{password}));subject='external-alice';
    });
    await context.test("第三方登录不能绕过本地MFA，解绑须本人证明并撤销会话", async () => {
      const setup = ok(await call("/auth/mfa/setup", alice.jar, "POST", {
          password
        })),
        enabled = ok(await call("/auth/mfa/confirm", alice.jar, "POST", {
          code: totp(setup.secret)
        }));
      const jar = new Map();
      await callback(await authorize(jar), jar);
      assert.equal(ok(await call("/oauth/pending", jar)).factorRequired, true);
      assert.equal((await call("/oauth/complete", jar, "POST", {})).status, 401);
      ok(await call("/oauth/complete", jar, "POST", {
        recoveryCode: enabled.recoveryCodes[0]
      }));
      assert.equal(ok(await call("/auth/me", jar)).id, alice.id);
      const binding = ok(await call("/oauth/bindings", alice.jar))[0];
      assert.equal((await call("/oauth/bindings/" + binding.id, alice.jar, "DELETE", {
        password: "wrong"
      })).status, 401);
      ok(await call("/oauth/bindings/" + binding.id, alice.jar, "DELETE", {
        password,
        recoveryCode: enabled.recoveryCodes[1]
      }));
      assert.equal((await call("/auth/me", jar)).status, 401);
      assert.equal((await call("/auth/me", alice.jar)).status, 401);
      assert.equal((await database.query("SELECT count(*)::int n FROM oauth_bindings")).rows[0].n, 0);
    });
    const verified = await verifyAudit(database, audit);
    assert.ok(verified.count > 15);
  } finally {
    if (server && server.exitCode === null) {
      const done = new Promise(resolve => server.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    if (issuer) await new Promise(resolve => issuer.close(() => resolve()));
    await database.end();
    if (cache.isOpen) {
      for (const value of tokens) await cache.del("session:" + digest(value));
      for (const value of states) await cache.del("oauth-state:" + digest(value));
      for (const value of tickets) await cache.del("oauth-pending:" + digest(value));
      for (const id of users) await cache.del([`account-proof:user:${id}`, `account-factor:${id}`]);
      for (const email of emails) await cache.del("login:" + digest(email));
      await cache.del(["oauth-rate:" + digest(ip), "account-proof:ip:" + digest(ip), "login:" + digest(ip)]);
      await cache.quit();
    }
    if (created) await master.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await master.end();
    await rm(directory, {
      recursive: true,
      force: true
    });
  }
});
