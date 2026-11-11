/* 第三方身份：标准通道PKCE与原生协议插件共用一次性浏览器state；绑定与解绑需要主账号本人证明。
 * 调用：GET /oauth/providers；POST /oauth/:provider/start；GET /oauth/:provider/callback。
 * 对照：3.7.6 OauthController listing/url/callback、OauthBindController listing/untie。
 */
import { Body, Controller, Get, Post, Delete, Param, Query, Req, Res, ConflictException, UnauthorizedException, ForbiddenException, BadRequestException, HttpException } from "@nestjs/common";
import { randomBytes, createHash, createPublicKey, verify, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Response } from "express";
import { z } from "zod";
import { pool, redis, transaction } from "./store.js";
import { record } from "./audit.js";
import { factorFields, verifyIdentity, checkFactor, factorComplete } from "./security.js";
import { start } from "./session.js";
import { Public, interactive, tokenHash, type SessionRequest } from "../utils/access.js";
import { read, uuid } from "../utils/input.js";
export type OAuthAuthorization = { redirectUri: string; state: string; verifier: string; nonce: string };
export type OAuthExchange = Omit<OAuthAuthorization, 'state'>;
export type OAuthIdentity = { subject: string; displayName: string };
export type OAuthJson = (url: string, options?: RequestInit) => Promise<Record<string, any>>;
export type OAuthProvider = {
  id: string;
  name: string;
  kind: "oauth2" | "oidc";
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
  issuer?: string;
  jwksUrl?: string;
  scopes: string;
  subjectField?: string;
  nameField?: string;
  pkce?: boolean;
  authorization?: (context: OAuthAuthorization) => URL;
  exchange?: (code: string, context: OAuthExchange, request: OAuthJson) => Promise<OAuthIdentity>;
};
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nextPath = z.string().max(1000).refine(value => value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(value), "返回路径必须在本站").default("/console");
const proof = z.object({
  password: z.string().min(1).max(128),
  ...factorFields
}).strict();
type Flow = {
  provider: string;
  browserHash: string;
  verifier: string;
  nonce: string;
  next: string;
  userId?: string;
  version?: number;
  sessionHash?: string;
};
type Pending = {
  userId: string;
  version: number;
  bindingId: string;
  provider: string;
  next: string;
};
/** 供应商地址来自部署配置；禁止重定向、内嵌凭据和非HTTPS，测试仅允许本机HTTP。 */
export function providerUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.protocol !== "https:" && !(process.env.NODE_ENV === "test" && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("第三方身份通道地址需要HTTPS");
  return url.href;
}
async function providers() {
  const directory = fileURLToPath(new URL("../oauth-providers/", import.meta.url)),
    found: OAuthProvider[] = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!/\.(ts|js)$/.test(file) || file.endsWith(".d.ts")) continue;
    const configured = (await import(pathToFileURL(join(directory, file)).href)).default() as OAuthProvider | undefined;
    if (!configured) continue;
    for (const address of [configured.authorizationUrl, configured.tokenUrl, configured.userinfoUrl, configured.jwksUrl].filter(Boolean)) providerUrl(address!);
    if (configured.kind === "oidc" && (!configured.issuer || !configured.jwksUrl)) throw new Error("OIDC通道需要固定issuer和JWKS地址");
    found.push(configured);
  }
  return found;
}
async function provider(id: string) {
  read(identifier, id);
  const value = (await providers()).find(item => item.id === id);
  if (!value) throw new BadRequestException("这个第三方身份通道暂未开放");
  return value;
}
function cookieOptions() {
  return {
    httpOnly: true,
    secure: new URL(process.env.PUBLIC_ORIGIN!).protocol === "https:",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600000
  };
}
function origin(request: SessionRequest) {
  if (!request.is("application/json") || request.headers.origin && request.headers.origin !== process.env.PUBLIC_ORIGIN || request.headers["sec-fetch-site"] === "cross-site") throw new ForbiddenException("请从本站表单完成第三方身份操作");
}
async function limit(request: SessionRequest) {
  const count = Number(await redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],600) end;return n", {
    keys: [`oauth-rate:${tokenHash(request.ip ?? "")}`],
    arguments: []
  }));
  if (count > 40) throw new HttpException("第三方登录尝试较多，请稍后再试", 429);
}
async function json(url: string, options: RequestInit = {}) {
  const response = await fetch(providerUrl(url), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new UnauthorizedException("第三方身份服务未接受本次授权");
  if (!response.body) throw new UnauthorizedException("第三方身份服务没有返回有效数据");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 262144) throw new UnauthorizedException("第三方身份响应超出允许范围");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, any>;
  } catch {
    throw new UnauthorizedException("第三方身份响应格式无效");
  }
}
function same(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** OIDC只验证固定JWKS的RS256/ES256，issuer、audience、nonce与授权发起事实逐项绑定。 */
async function idClaims(token: string, channel: OAuthProvider, nonce: string, accessToken: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 32768 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new UnauthorizedException("OIDC身份令牌格式无效");
  let header: Record<string, any>, claims: Record<string, any>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch {
    throw new UnauthorizedException("OIDC身份令牌格式无效");
  }
  if (!["RS256", "ES256"].includes(header.alg) || header.crit || header.b64 === false) throw new UnauthorizedException("OIDC签名算法不受支持");
  const set = await json(channel.jwksUrl!),
    keys = Array.isArray(set.keys) ? set.keys.filter((key: Record<string, any>) => (!header.kid || key.kid === header.kid) && (!key.use || key.use === "sig") && (!key.alg || key.alg === header.alg) && (!key.key_ops || Array.isArray(key.key_ops) && key.key_ops.includes("verify")) && key.kty === (header.alg === "RS256" ? "RSA" : "EC")) : [];
  if (keys.length !== 1) throw new UnauthorizedException("OIDC签名密钥无法唯一确定");
  const selected = keys[0];
  let valid = false;
  try {
    const key = createPublicKey({
      key: header.alg === "RS256" ? {
        kty: "RSA",
        n: selected.n,
        e: selected.e
      } : {
        kty: "EC",
        crv: selected.crv,
        x: selected.x,
        y: selected.y
      },
      format: "jwk"
    });
    if (header.alg === "RS256" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    if (header.alg === "ES256" && selected.crv !== "P-256") throw new Error();
    valid = verify("sha256", Buffer.from(parts[0] + "." + parts[1]), {
      key,
      dsaEncoding: "ieee-p1363"
    }, Buffer.from(parts[2]!, "base64url"));
  } catch {
    valid = false;
  }
  const now = Math.floor(Date.now() / 1000),
    audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!valid || claims.iss !== channel.issuer || !audiences.includes(channel.clientId) || audiences.length > 1 && claims.azp !== channel.clientId || claims.azp && claims.azp !== channel.clientId || !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.nbf && claims.nbf > now + 60 || typeof claims.nonce !== "string" || !same(claims.nonce, nonce) || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new UnauthorizedException("OIDC身份令牌核对失败");
  if (claims.at_hash && claims.at_hash !== createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url")) throw new UnauthorizedException("OIDC访问令牌绑定核对失败");
  return claims;
}
async function identity(channel: OAuthProvider, code: string, flow: Flow) {
  const redirectUri = process.env.PUBLIC_ORIGIN + `/api/v1/oauth/${channel.id}/callback`;
  if (channel.exchange) {
    const result = await channel.exchange(code, { redirectUri, verifier: flow.verifier, nonce: flow.nonce }, json);
    return identified(result.subject, result.displayName); // 协议插件只取第三方身份；绑定、MFA和本地会话始终走公共主体
  }
  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: channel.clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: flow.verifier
  });
  if (channel.clientSecret) parameters.set("client_secret", channel.clientSecret);
  const token = await json(channel.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: parameters
  });
  if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 16384 || token.token_type && String(token.token_type).toLowerCase() !== "bearer") throw new UnauthorizedException("第三方访问令牌无效");
  const claims = channel.kind === "oidc" ? await idClaims(read(z.string().min(1).max(32768), token.id_token), channel, flow.nonce, token.access_token) : undefined;
  const profile = channel.userinfoUrl ? await json(channel.userinfoUrl, {
    headers: {
      authorization: "Bearer " + token.access_token,
      accept: "application/json"
    }
  }) : claims!;
  const subject = channel.kind === "oidc" ? claims!.sub : profile[channel.subjectField ?? "id"];
  if (claims && channel.userinfoUrl && profile.sub !== claims.sub) throw new UnauthorizedException("OIDC用户资料与令牌身份不一致");
  return identified(subject, profile[channel.nameField ?? "name"]); // 邮箱不参与账户匹配或自动合并
}
function identified(subject: unknown, name: unknown): OAuthIdentity {
  if (typeof subject !== "string" && !(typeof subject === "number" && Number.isSafeInteger(subject)) || !String(subject) || String(subject).length > 255 || /[\u0000-\u001f\u007f]/.test(String(subject))) throw new UnauthorizedException("第三方账户缺少稳定身份标识");
  return {
    subject: String(subject),
    displayName: typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : ""
  };
}
@Controller()
export default class OAuth {
  @Public()
  @Get("oauth/providers")
  async list() {
    return (await providers()).map(channel => ({
      id: channel.id,
      name: channel.name,
      kind: channel.kind,
      pkce: channel.pkce !== false
    }));
  }
  @Get("oauth/bindings")
  async bindings(@Req()
  request: SessionRequest) {
    interactive(request);
    return (await pool.query("SELECT id,provider,display_name AS \"displayName\",created_at AS \"createdAt\" FROM oauth_bindings WHERE user_id=$1 ORDER BY created_at,id", [request.user.id])).rows;
  }
  private async authorize(channel: OAuthProvider, next: string, response: Response, account?: {
    userId: string;
    version: number;
    sessionHash: string;
  }) {
    const state = randomBytes(32).toString("base64url"),
      browser = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const flow: Flow = {
      provider: channel.id,
      browserHash: tokenHash(browser),
      verifier,
      nonce,
      next,
      ...account
    };
    await redis.set(`oauth-state:${tokenHash(state)}`, JSON.stringify(flow), {
      EX: 600
    });
    response.cookie("yunzou_oauth_browser", browser, cookieOptions());
    const redirectUri = process.env.PUBLIC_ORIGIN + `/api/v1/oauth/${channel.id}/callback`;
    const url = channel.authorization ? channel.authorization({ redirectUri, state, verifier, nonce }) : new URL(channel.authorizationUrl);
    if (!channel.authorization) for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: channel.clientId,
      redirect_uri: redirectUri,
      scope: channel.scopes,
      state,
      ...(channel.pkce !== false ? { code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" } : {}),
      ...(channel.kind === "oidc" ? {
        nonce
      } : {})
    })) url.searchParams.set(key, value);
    const trusted = new URL(channel.authorizationUrl);
    if (url.origin !== trusted.origin || url.pathname !== trusted.pathname || url.username || url.password || url.searchParams.get('state') !== state || url.searchParams.get('redirect_uri') !== redirectUri) throw new BadRequestException('第三方授权地址与本次登录事实不一致'); // 插件不能覆盖公共层生成的回调或浏览器state
    return {
      url: url.href
    };
  }
  @Public()
  @Post("oauth/:provider/start")
  async begin(@Param("provider")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest, @Res({
    passthrough: true
  })
  response: Response) {
    origin(request);
    await limit(request);
    const input = read(z.object({
      next: nextPath
    }).strict(), body);
    return this.authorize(await provider(id), input.next, response);
  }
  @Post("oauth/:provider/bind")
  async bind(@Param("provider")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest, @Res({
    passthrough: true
  })
  response: Response) {
    interactive(request);
    const input = read(proof.extend({
      next: nextPath.default("/console/identity")
    }), body);
    await verifyIdentity(request, input, "oauth.bind");
    const sessionHash = tokenHash(request.cookies.yunzou_session ?? ""),
      raw = await redis.get(`session:${sessionHash}`);
    if (!raw) throw new UnauthorizedException("登录会话已经变化，请重新登录");
    const session = JSON.parse(raw);
    return this.authorize(await provider(id), input.next, response, {
      userId: request.user.id,
      version: session.version,
      sessionHash
    });
  }
  @Public()
  @Get("oauth/:provider/callback")
  async callback(@Param("provider")
  id: string, @Query()
  query: unknown, @Req()
  request: SessionRequest, @Res()
  response: Response) {
    try {
      const input = read(z.object({
          state: opaque,
          code: z.string().min(1).max(2048),
          iss: z.string().max(2000).optional()
        }), query),
        browser = read(opaque, request.cookies.yunzou_oauth_browser),
        raw = await redis.get(`oauth-state:${tokenHash(input.state)}`);
      if (!raw) throw new UnauthorizedException("本次授权已失效");
      const flow: Flow = JSON.parse(raw);
      if (flow.provider !== id || !same(flow.browserHash, tokenHash(browser))) throw new UnauthorizedException("本次授权与浏览器不一致");
      const consumed = await redis.getDel(`oauth-state:${tokenHash(input.state)}`);
      if (consumed !== raw) throw new UnauthorizedException("本次授权已被使用");
      const channel = await provider(id);
      if (input.iss && input.iss !== channel.issuer) throw new UnauthorizedException("授权来源不一致");
      const profile = await identity(channel, input.code, flow);
      if (flow.userId) {
        const sessionHash = tokenHash(request.cookies.yunzou_session ?? ""),
          session = await redis.get(`session:${sessionHash}`);
        if (sessionHash !== flow.sessionHash || !session || JSON.parse(session).id !== flow.userId || JSON.parse(session).version !== flow.version) throw new UnauthorizedException("绑定期间登录会话已经变化");
        await transaction(async connection => {
          const user = (await connection.query("SELECT id,session_version FROM users WHERE id=$1 AND NOT disabled FOR UPDATE", [flow.userId])).rows[0];
          if (!user || user.session_version !== flow.version) throw new UnauthorizedException("绑定期间账号凭据已经变化");
          const saved = (await connection.query("INSERT INTO oauth_bindings(user_id,provider,subject,display_name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [flow.userId, id, profile.subject, profile.displayName])).rows[0];
          if (!saved) throw new ConflictException("这个第三方身份或通道已有绑定");
          await record(connection, flow.userId!, "oauth.bind", saved.id, {
            provider: id
          });
        });
        response.clearCookie("yunzou_oauth_browser", cookieOptions());
        return response.redirect(process.env.PUBLIC_ORIGIN + flow.next);
      }
      const bound = (await pool.query("SELECT b.id,b.user_id,u.session_version FROM oauth_bindings b JOIN users u ON u.id=b.user_id WHERE b.provider=$1 AND b.subject=$2 AND NOT u.disabled", [id, profile.subject])).rows[0];
      if (!bound) {
        response.clearCookie("yunzou_oauth_browser", cookieOptions());
        return response.redirect(process.env.PUBLIC_ORIGIN + "/login?oauth=unbound");
      }
      const ticket = randomBytes(32).toString("base64url"),
        pending: Pending = {
          userId: bound.user_id,
          version: bound.session_version,
          bindingId: bound.id,
          provider: id,
          next: flow.next
        };
      await redis.set(`oauth-pending:${tokenHash(ticket)}`, JSON.stringify(pending), {
        EX: 300
      });
      response.cookie("yunzou_oauth_result", ticket, {
        ...cookieOptions(),
        maxAge: 300000
      });
      response.clearCookie("yunzou_oauth_browser", cookieOptions());
      return response.redirect(process.env.PUBLIC_ORIGIN + "/oauth/complete");
    } catch (error) {
      console.error(JSON.stringify({
        action: "oauth.callback",
        provider: id,
        status: error instanceof HttpException ? error.getStatus() : 500
      }));
      return response.redirect(process.env.PUBLIC_ORIGIN + "/login?oauth=failed");
    } // 跨站回调将安全错误带回本站表单，不暴露code或令牌
  }
  @Public()
  @Get("oauth/pending")
  async pending(@Req()
  request: SessionRequest) {
    const ticket = read(opaque, request.cookies.yunzou_oauth_result),
      raw = await redis.get(`oauth-pending:${tokenHash(ticket)}`);
    if (!raw) throw new UnauthorizedException("第三方登录确认已过期，请重新发起");
    const saved: Pending = JSON.parse(raw);
    const user = (await pool.query("SELECT u.id,EXISTS(SELECT 1 FROM account_security s WHERE s.user_id=u.id AND s.enabled) AS \"factorRequired\" FROM users u WHERE u.id=$1 AND NOT u.disabled AND session_version=$2", [saved.userId, saved.version])).rows[0];
    if (!user) throw new UnauthorizedException("账号凭据已经变化，请重新发起");
    return {
      provider: saved.provider,
      factorRequired: user.factorRequired
    };
  }
  @Public()
  @Post("oauth/complete")
  async complete(@Body()
  body: unknown, @Req()
  request: SessionRequest, @Res({
    passthrough: true
  })
  response: Response) {
    origin(request);
    await limit(request);
    const input = read(z.object(factorFields).strict(), body),
      ticket = read(opaque, request.cookies.yunzou_oauth_result),
      key = `oauth-pending:${tokenHash(ticket)}`;
    const saved = await transaction(async connection => {
      await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const raw = await redis.get(key);
      if (!raw) throw new UnauthorizedException("这次登录已失效，请重新发起");
      const pending: Pending = JSON.parse(raw);
      const user = (await connection.query("SELECT u.* FROM users u JOIN oauth_bindings b ON b.user_id=u.id WHERE u.id=$1 AND u.session_version=$2 AND NOT u.disabled AND b.id=$3 AND b.provider=$4 FOR UPDATE OF u", [pending.userId, pending.version, pending.bindingId, pending.provider])).rows[0];
      if (!user) throw new UnauthorizedException("账号或绑定已变化，请重新发起");
      await checkFactor(connection, user.id, input, "oauth.login");
      if ((await redis.getDel(key)) !== raw) throw new UnauthorizedException("这次登录确认已被使用");
      await connection.query("UPDATE users SET last_login_at=now(),last_login_ip=$2 WHERE id=$1", [user.id, (request.ip ?? "").slice(0, 80)]);
      await record(connection, user.id, "account.oauth.login", user.id, {
        provider: pending.provider
      });
      return {
        user,
        next: pending.next
      };
    });
    await factorComplete(saved.user.id);
    await start(saved.user.id, saved.user.session_version, response);
    response.clearCookie("yunzou_oauth_result", cookieOptions());
    return {
      ok: true,
      next: saved.next
    };
  }
  @Delete("oauth/bindings/:id")
  async unbind(@Param("id")
  id: string, @Body()
  body: unknown, @Req()
  request: SessionRequest) {
    interactive(request);
    read(uuid, id);
    const input = read(proof, body);
    await verifyIdentity(request, input, "oauth.unbind");
    return transaction(async connection => {
      await connection.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [request.user.id]);
      const removed = await connection.query("DELETE FROM oauth_bindings WHERE id=$1 AND user_id=$2 RETURNING provider", [id, request.user.id]);
      if (!removed.rowCount) throw new ConflictException("这个绑定已经移除或不属于当前账号");
      await connection.query("UPDATE users SET session_version=session_version+1 WHERE id=$1", [request.user.id]);
      await record(connection, request.user.id, "oauth.unbind", id, {
        provider: removed.rows[0].provider
      });
      return {
        ok: true,
        signInRequired: true
      };
    });
  }
}
