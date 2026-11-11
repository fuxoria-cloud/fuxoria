# 第三方登录与绑定

登录页只显示配置完整的第三方通道。已有狐岚云账号在 `/console/identity` 通过当前密码与双因素发起绑定，随后跳转到提供商授权页面。绑定使用提供商的稳定 subject。邮箱相同的第三方身份不会自动匹配、注册或接管现有账号；新客户可先创建狐岚云账号，再绑定身份。

登录授权成功后返回 `/oauth/complete`，本地已开启的双因素仍须通过。解绑也需要本人密码和双因素，并递增凭据版本撤销旧会话。子账户与自动化 API 密钥不能代办绑定或解绑。

## 配置通道

通道文件位于 `apps/api/src/oauth-providers/`。一个文件导出一个通道配置函数，目录扫描自动发现；新增文件后重启 API。客户端密钥只留在 API 环境，不写进前端。

标准 OIDC 使用以下变量：

```text
OAUTH_OIDC_NAME=登录按钮名称
OAUTH_OIDC_CLIENT_ID=提供商登记的客户端ID
OAUTH_OIDC_CLIENT_SECRET=客户端密钥
OAUTH_OIDC_AUTHORIZATION_URL=https://身份服务/authorize
OAUTH_OIDC_TOKEN_URL=https://身份服务/token
OAUTH_OIDC_USERINFO_URL=https://身份服务/userinfo
OAUTH_OIDC_ISSUER=https://身份服务
OAUTH_OIDC_JWKS_URL=https://身份服务/jwks
OAUTH_OIDC_SCOPES=profile email
```

回调地址须在提供商处精确登记为 `${PUBLIC_ORIGIN}/api/v1/oauth/oidc/callback`。OIDC 通道自动请求 `openid`，用户信息端点可留空，此时使用已验证的 ID Token 资料。令牌端点使用 `client_secret_post`；无客户端密钥的公开客户端使用 PKCE。

标准 OAuth2 使用 `OAUTH_OAUTH2_` 前缀，配置 `NAME`、`CLIENT_ID`、`CLIENT_SECRET`、`AUTHORIZATION_URL`、`TOKEN_URL`、`USERINFO_URL`、`SCOPES`、`SUBJECT_FIELD`、`NAME_FIELD`。其中 subject 字段默认 `id`，显示名称默认 `name`。回调地址为 `${PUBLIC_ORIGIN}/api/v1/oauth/oauth2/callback`。用户资料端点必须用 Bearer 令牌返回稳定身份标识。

微信网站扫码由 `oauth-providers/wechat.ts` 自动发现。填写微信开放平台已审核的网站应用凭据：

```text
OAUTH_WECHAT_APP_ID=网站应用AppID
OAUTH_WECHAT_APP_SECRET=网站应用AppSecret
```

两项缺少任何一项时，登录页不显示微信入口。在微信开放平台配置回调域名，本站回调地址固定为 `${PUBLIC_ORIGIN}/api/v1/oauth/wechat/callback`。授权地址使用 `appid` 和 `snsapi_login`，服务端通过 GET 换取令牌，再以 `access_token`、`openid` 获取资料并核对两次返回的身份。生产端点固定为微信官方地址，不能通过登录参数更换。协议依据为[微信网站应用登录指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)和[微信授权关系接口指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Authorized_Interface_Calling_UnionID.html)。

微信通道不发送 PKCE 参数，仍执行一次性 state、浏览器 Cookie 绑定、固定回调和本地双因素认证。绑定键为 `AppID:openid`；相同昵称、邮箱或 UnionID 不触发自动合并。更换网站应用 AppID 后，原绑定不会自动转到新应用。用户先注册并登录狐岚云，再通过本人密码与双因素绑定微信。

## 授权核对

标准 OAuth2 和 OIDC 授权码使用 S256 PKCE。所有通道的 state 为一次性随机值，与 HttpOnly 浏览器 Cookie 绑定，十分钟后失效；回调通过核对后立即消费。提供商的授权、令牌和资料端点来自固定部署配置，生产地址要求 HTTPS，请求拒绝跟随重定向。回到本站后的短期确认票据也只存放于 HttpOnly Cookie。

OIDC 核对固定 JWKS 的 RS256 或 ES256 签名、issuer、audience、授权方、有效期、nonce，以及存在时的访问令牌绑定摘要。用户资料端点返回的 subject 必须与 ID Token 一致。这些规则对应 [PKCE 规范 RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)、[OAuth 安全实践 RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) 和 [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)。

```sh
node --env-file=.env --import tsx --test apps/api/tests/identity-provider.integration.test.ts
node --env-file=.env --import tsx --test apps/api/tests/wechat.integration.test.ts
```

测试启动本机授权服务器，实际兑换一次性授权码并检查 PKCE 与回调地址，使用真实 RSA 签名和 JWKS。回归包括浏览器 state 隔离、回放拒绝、同邮箱未绑定身份、subject 唯一归属、错误签名、nonce、audience、本地 MFA 和解绑后的会话撤销。

微信测试使用本机 HTTP 协议服务器，实际检查 `appid`、GET 换码和用户资料请求。覆盖未配置入口、错误码、scope、openid 错配、禁止重定向、响应大小、跨应用身份隔离、并发一次性消费、本地 MFA 和解绑会话撤销，不向真实微信发送请求。
