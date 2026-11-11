/* 标准OAuth2通道：按部署配置读取受信任用户资料端点，以稳定subject标识绑定，不匹配邮箱。 */
import type {OAuthProvider} from '../features/oauth.js';
export default function():OAuthProvider|undefined{
 const value=(name:string)=>process.env['OAUTH_OAUTH2_'+name];
 if(!value('CLIENT_ID')||!value('AUTHORIZATION_URL')||!value('TOKEN_URL')||!value('USERINFO_URL'))return;
 return {id:'oauth2',name:value('NAME')||'第三方账户',kind:'oauth2',clientId:value('CLIENT_ID')!,clientSecret:value('CLIENT_SECRET'),authorizationUrl:value('AUTHORIZATION_URL')!,tokenUrl:value('TOKEN_URL')!,userinfoUrl:value('USERINFO_URL')!,scopes:value('SCOPES')||'profile',subjectField:value('SUBJECT_FIELD')||'id',nameField:value('NAME_FIELD')||'name'};
}
