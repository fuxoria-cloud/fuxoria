/* 本机配置：生成独立数据库、Redis、审计与管理员密码，不覆盖已有.env。
 * 调用：npm run setup；密码只写入权限600的.env，不在终端输出。
 */
import { readFile,writeFile } from 'node:fs/promises';              // 配置模板与实例分开保管
import { randomBytes } from 'node:crypto';                         // 每个部署都有自己的随机密钥

const source=new URL('../.env.example',import.meta.url);           // 换目录调用也使用同一模板
const target=new URL('../.env',import.meta.url);                   // 用户配置不写回模板
const template=await readFile(source,'utf8');                      // 初始配置只来自一个文件
const values:Record<string,string>={                              // 所有安全字段一次生成
  AUDIT_KEY:randomBytes(32).toString('hex'),                       // 与数据库分离保存的审计签名钥
  TOTP_KEY:randomBytes(32).toString('hex'),                        // 认证器密钥独立加密，不复用审计用途
  CERTIFICATION_KEY:randomBytes(32).toString('hex'),              // 实名资料与附件使用独立加密密钥
  VERIFICATION_KEY:randomBytes(32).toString('hex'),               // 邮箱/手机挑战摘要独立于审计签名
  RESOURCE_KEY:randomBytes(32).toString('hex'),                   // 供应商凭据和敏感任务参数不复用认证密钥
  POSTGRES_PASSWORD:randomBytes(24).toString('hex'),               // 十六进制可安全用作连接串密码
  REDIS_PASSWORD:randomBytes(24).toString('hex'),                  // 不复用数据库密码
  BOOTSTRAP_PASSWORD:randomBytes(24).toString('base64url'),         // 没有全项目通用的默认管理员密码
};
const content=template.split('\n').map(line=>{                    // 仅替换明确的实例字段
  const name=line.split('=',1)[0]!;                               // 注释和普通配置原样保留
  return Object.hasOwn(values,name)?`${name}=${values[name]}`:line; // 不通过shell解释随机值
}).join('\n');
await writeFile(target,content,{flag:'wx',mode:0o600});             // 文件存在就停止，绝不覆盖用户已有配置
console.log('已创建.env，文件权限为600。管理员邮箱与随机密码可在该文件中查看。'); // 不泄露任何凭据
