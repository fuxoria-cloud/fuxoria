/* 狐岚云API入口：自动发现业务文件，接收HTTP请求，统一权限、错误和缓存边界。
 * 调用：项目根 npm run dev:api；健康检查 GET /api/v1/health。
 * 新主体放features/<主体>.ts，默认导出带@Controller的类，重启后自动发现。
 */
import 'reflect-metadata';                                       // Nest装饰器需要元数据先于主体加载
import { readdir,readFile } from 'node:fs/promises';               // 从主体文件发现HTTP业务，并核对迁移版本
import { pathToFileURL, fileURLToPath } from 'node:url';            // 源码和生产产物使用相同目录规则
import { join } from 'node:path';                                 // 文件名不由用户输入决定
import { randomUUID,createHash } from 'node:crypto';                // 请求编号与迁移内容摘要
import { Module, HttpException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common'; // 框架只负责边界
import { NestFactory } from '@nestjs/core';                       // 创建主业务HTTP服务
import type { NestExpressApplication } from '@nestjs/platform-express'; // 明确使用Express原始正文解析能力
import { APP_GUARD } from '@nestjs/core';                         // 所有非公开入口统一检查身份
import cookieParser from 'cookie-parser';                        // 会话Cookie在这里解析一次
import helmet from 'helmet';                                     // API统一安全响应头
import type { Request,Response,NextFunction } from 'express';     // 入口处理HTTP协议而不处理业务
import { Access } from './utils/access.js';                       // 统一访问规则
import { close,connect,pool,redis } from './features/store.js';    // 连接生命周期由入口管理
import { loadPayments } from './features/payment.js';             // 支付插件启动时扫描

if (!process.env.AUDIT_KEY || process.env.AUDIT_KEY.length<32 || process.env.AUDIT_KEY.includes('replace-')) throw new Error('AUDIT_KEY需要独立生成的至少32位随机密钥'); // 不以演示密钥启动
if (!process.env.PUBLIC_ORIGIN || new URL(process.env.PUBLIC_ORIGIN).origin!==process.env.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN须为不带路径的完整站点来源'); // CSRF边界只有一个可信来源
if (process.env.NODE_ENV==='production' && new URL(process.env.PUBLIC_ORIGIN).protocol!=='https:' && !['127.0.0.1','localhost','[::1]'].includes(new URL(process.env.PUBLIC_ORIGIN).hostname)) throw new Error('正式域名必须使用HTTPS；HTTP仅允许本机访问'); // 不在公网明文签发会话
await connect();                                                 // 数据库和认证均就绪才对外监听
const migrations=new URL('../../../database/migrations/',import.meta.url); // API源码和产物都回到项目数据库配置
const recorded=await pool.query('SELECT name,hash FROM migrations'); // 未升级结构时不把API伪装成就绪
for (const file of (await readdir(migrations)).filter(file=>file.endsWith('.sql'))) {
  const digest=createHash('sha256').update(await readFile(new URL(file,migrations))).digest('hex'); // 已执行迁移不能悄悄改内容
  if (!recorded.rows.some(row=>row.name===file && row.hash===digest)) throw new Error(`数据库结构与当前代码不一致，请先执行 npm run db:migrate：${file}`); // 明确给管理员可执行的恢复动作
}
await loadPayments();                                            // 文件即插件，未配置支付保持禁用
const directory=fileURLToPath(new URL('./features/',import.meta.url)); // 主体路径相对于入口固定
const controllers=[];                                            // 只登记默认导出的业务入口
for (const file of (await readdir(directory)).sort()) {
  if (!/\.(ts|js)$/.test(file) || file.endsWith('.d.ts')) continue; // 不加载声明或构建映射文件
  const feature=await import(pathToFileURL(join(directory,file)).href); // 主体在同一位置完成自己的业务
  if (feature.default) controllers.push(feature.default);         // 数据主体没有默认导出，不成为HTTP入口
}

@Module({controllers,providers:[{provide:APP_GUARD,useClass:Access}]})
class Application {}                                             // 框架元数据集中在唯一入口

const app=await NestFactory.create<NestExpressApplication>(Application,{rawBody:true,bodyParser:false}); // 签名必须使用机构发送的原始正文
const proxies=(process.env.TRUST_PROXY_CIDRS ?? 'loopback').split(',').map(value=>value.trim()).filter(Boolean); // 只接受部署方明确列出的代理地址范围
if (proxies.includes('0.0.0.0/0') || proxies.includes('::/0') || proxies.includes('true')) throw new Error('TRUST_PROXY_CIDRS不能无条件信任所有来源'); // 公开客户端不能自行伪造限流来源
app.getHttpAdapter().getInstance().set('trust proxy',proxies);      // Express按可信代理链还原客户端IP
app.useBodyParser('json',{limit:'256kb'});                         // 限制通知与业务输入占用
app.useBodyParser('urlencoded',{extended:false,limit:'256kb'});    // 支付表单保留原始正文供验签
app.setGlobalPrefix('api/v1');                                    // 新版接口显式版本化
app.use(helmet());                                               // 阻止内容嗅探和常见浏览器误用
app.use(cookieParser());                                         // 不在每个主体重复解析Cookie
app.use((request:Request & {requestId?:string},response:Response,next:NextFunction)=>{
  request.requestId=randomUUID();                                // 编号不接收用户可控值
  response.setHeader('X-Request-Id',request.requestId);            // 用户和日志能定位同一次请求
  response.setHeader('Cache-Control','private, no-store');         // 私有业务绝不进入CDN缓存
  next();                                                        // 权限与业务依次执行
});
app.use('/api/v1/health',async (_request:Request,response:Response,next:NextFunction)=>{
  try {
    await pool.query('SELECT 1');                                 // 探测真实账本依赖
    await redis.ping();                                          // 会话系统也必须在线
    response.json({status:'ok',name:'狐岚云'});                     // 不公开内部地址和凭据
  } catch (error) { next(error); }                                // 故障交由统一入口处理
});
app.useGlobalFilters(new class implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse<Response>();    // 全部主体共用一份错误出口
    const request=host.switchToHttp().getRequest<Request & {requestId:string}>(); // 请求编号用来找服务日志
    const exception=error as {status?:number;code?:string;message?:string;type?:string}; // 支付插件和数据库都在此跨边界
    const status=error instanceof HttpException ? error.getStatus() : exception.type==='entity.parse.failed'?400:exception.type==='entity.too.large'?413:exception.code==='23505'?409:exception.status ?? 500; // 用户输入错误不会伪装成系统故障
    if (status>=500) console.error(JSON.stringify({requestId:request.requestId,path:request.path,error:exception.message})); // 故障细节留服务端，不回传SQL或密钥
    const message=status>=500?'服务暂时遇到问题，请稍后重试；可向客服提供请求编号':status===409 && exception.code==='23505'?'提交的数据已存在':exception.message ?? '请求无法处理'; // 反馈可执行的下一步
    response.status(status).json({statusCode:status,message,requestId:request.requestId}); // 前端用同一种结构展示错误
  }
});
await app.listen(Number(process.env.PORT ?? 3301),process.env.HOST ?? '127.0.0.1'); // 监听地址由部署环境决定
for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,async()=>{
  await app.close();                                              // 先停止接受新请求
  await close();                                                  // 事务退出后关闭数据库与Redis
  process.exit(0);                                                // 正常结束允许编排器安全重启
});
