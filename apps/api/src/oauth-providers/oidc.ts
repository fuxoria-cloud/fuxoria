/* 标准OIDC通道：环境配置完整时显示，固定issuer/JWKS，授权码和身份令牌在oauth.ts验证。 */
import type {OAuthProvider} from '../features/oauth.js';
export default function():OAuthProvider|undefined{
 const value=(name:string)=>process.env['OAUTH_OIDC_'+name];
 if(!value('CLIENT_ID')||!value('AUTHORIZATION_URL')||!value('TOKEN_URL')||!value('ISSUER')||!value('JWKS_URL'))return;
 return {id:'oidc',name:value('NAME')||'身份提供商',kind:'oidc',clientId:value('CLIENT_ID')!,clientSecret:value('CLIENT_SECRET'),authorizationUrl:value('AUTHORIZATION_URL')!,tokenUrl:value('TOKEN_URL')!,userinfoUrl:value('USERINFO_URL'),issuer:value('ISSUER')!,jwksUrl:value('JWKS_URL')!,scopes:'openid '+(value('SCOPES')||'profile email')};
}
