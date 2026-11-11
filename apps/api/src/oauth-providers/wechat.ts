/* 微信开放平台网站扫码登录：appid授权、GET换令牌、openid资料核对；本地账号绑定与MFA交给oauth.ts。
 * 配置：OAUTH_WECHAT_APP_ID和OAUTH_WECHAT_APP_SECRET；回调${PUBLIC_ORIGIN}/api/v1/oauth/wechat/callback。
 */
import { UnauthorizedException } from '@nestjs/common';
import type { OAuthProvider } from '../features/oauth.js';

/** 微信生产端点固定；隔离测试仅可把同一协议指向本机，不允许借测试配置把密钥发到别的主机。 */
function endpoint(kind: 'AUTHORIZATION' | 'TOKEN' | 'USERINFO', official: string) {
  const override = process.env.NODE_ENV === 'test' ? process.env['OAUTH_WECHAT_TEST_' + kind + '_URL'] : undefined;
  if (!override) return official;
  const url = new URL(override);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('微信测试端点只允许本机固定路径');
  return url.href;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export default function(): OAuthProvider | undefined {
  const appid = process.env.OAUTH_WECHAT_APP_ID?.trim(), secret = process.env.OAUTH_WECHAT_APP_SECRET?.trim();
  if (!identifier(appid) || appid.length > 64 || !secret || secret.length > 512 || /[\s\u0000-\u001f\u007f]/.test(secret)) return;
  const authorizationUrl = endpoint('AUTHORIZATION', 'https://open.weixin.qq.com/connect/qrconnect');
  const tokenUrl = endpoint('TOKEN', 'https://api.weixin.qq.com/sns/oauth2/access_token');
  const userinfoUrl = endpoint('USERINFO', 'https://api.weixin.qq.com/sns/userinfo');
  return {
    id: 'wechat', name: '微信扫码', kind: 'oauth2', clientId: appid, clientSecret: secret,
    authorizationUrl, tokenUrl, userinfoUrl, scopes: 'snsapi_login', pkce: false,
    authorization({ redirectUri, state }) {
      const url = new URL(authorizationUrl);
      url.search = new URLSearchParams({ appid, redirect_uri: redirectUri, response_type: 'code', scope: 'snsapi_login', state }).toString();
      url.hash = 'wechat_redirect';
      return url; // 微信网站应用未提供PKCE参数，保留公共一次性state和浏览器绑定，不声称PKCE已生效
    },
    async exchange(code, _context, request) {
      const tokenAddress = new URL(tokenUrl);
      tokenAddress.search = new URLSearchParams({ appid, secret, code, grant_type: 'authorization_code' }).toString();
      const token = await request(tokenAddress.href, { headers: { accept: 'application/json' } });
      if (token.errcode !== undefined && token.errcode !== 0 || typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 16384 || /[\u0000-\u001f\u007f]/.test(token.access_token) || !identifier(token.openid) || typeof token.scope !== 'string' || !token.scope.split(/[\s,]+/).includes('snsapi_login')) throw new UnauthorizedException('微信未接受本次网站登录授权');
      const profileAddress = new URL(userinfoUrl);
      profileAddress.search = new URLSearchParams({ access_token: token.access_token, openid: token.openid, lang: 'zh_CN' }).toString();
      const profile = await request(profileAddress.href, { headers: { accept: 'application/json' } });
      if (profile.errcode !== undefined && profile.errcode !== 0 || !identifier(profile.openid) || profile.openid !== token.openid) throw new UnauthorizedException('微信用户资料与本次授权身份不一致');
      // 网站应用范围内的openid作为唯一绑定键；不把昵称、邮箱或另一个应用的unionid当作自动合并依据。
      return { subject: `${appid}:${token.openid}`, displayName: typeof profile.nickname === 'string' ? profile.nickname : '' };
    }
  };
}
