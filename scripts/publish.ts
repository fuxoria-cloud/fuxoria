/* 差异静态发布：按每个目标的发布基线恢复公开文章，输出原子文件和CDN失效清单。
 * 调用：STATIC_OUTPUT=/srv/yunzou/public npm run publish:content；数据库和域名读取.env。
 * 换空目录、文件丢失或损坏均可重建；HTML一致不重写，撤回文章删除，私有资料不参与生成。
 * .yunzou-content-pending.json先保存失效意图；成功基线确认后才清除，修复和撤回中断都可重放。
 */
import { existsSync } from 'node:fs';                              // 环境可由部署器注入
import { mkdir,readFile,rename,rm,writeFile } from 'node:fs/promises'; // 文件先写临时文件再原子替换
import { createHash,randomUUID } from 'node:crypto';                // 内容摘要用于差异与缓存失效
import { resolve,join,dirname } from 'node:path';                  // 输出根由部署器明确设置
import pg from 'pg';                                              // 数据库提供当前公开内容与修订，目标文件由本地基线核对
import { generatePalette } from '@kernel4632/kima/theme';          // 静态文章也使用同一KIMA种子色生成配色

if (existsSync(new URL('../.env',import.meta.url))) process.loadEnvFile(new URL('../.env',import.meta.url)); // 不依赖当前工作目录
if (!process.env.STATIC_OUTPUT) throw new Error('请用STATIC_OUTPUT指定静态文件输出目录'); // 不猜测生产网站位置
const root=resolve(process.env.STATIC_OUTPUT);                    // 所有生成文件限制在此目录
const origin=new URL(process.env.PUBLIC_ORIGIN!).origin;          // canonical只有一个正式站点来源
const dark=generatePalette('#61afef',{isDark:true});                // 不在模板里手写第二套品牌颜色
const light=generatePalette('#61afef',{isDark:false});              // 浅色文章保持与应用主题一致
type Published={revision:string;hash:string|null};                 // 每个路径在此目标上成功发布的事实
const marker=join(root,'.yunzou-content-manifest.json');           // 文章基线不与Nuxt构建分发清单混用
const renderer=createHash('sha256').update(await readFile(new URL(import.meta.url))).update(JSON.stringify({origin,dark,light})).digest('hex'); // 模板、域名或配色变化时重新核对期望HTML
const current:Record<string,Published>={};                         // 本轮完整目标基线只在最后成功时保存
const connection=new pg.Client({connectionString:process.env.DATABASE_URL}); // 内容与待发布修订共用连接
await connection.connect();                                      // 失败时不会生成错误页面覆盖线上
try {
  await connection.query('SELECT pg_advisory_lock(812432)');      // 同时只能有一个发布器写同一批文件
  const priorMarker=existsSync(marker)?await readFile(marker,'utf8'):''; // 锁内读取，不能覆盖另一发布器刚确认的基线
  const previous=priorMarker?JSON.parse(priorMarker) as {renderer:string;pages:Record<string,Published>}:{renderer:'',pages:{}}; // 新目标不依赖全局published_revision
  const pendingFile=join(root,'.yunzou-content-pending.json');     // 未确认意图不等同于成功发布事实
  const pending=new Set<string>(existsSync(pendingFile)?JSON.parse(await readFile(pendingFile,'utf8')).paths:[]); // 失败前已经写好HTML，也须再次输出失效路径
  const changed=new Set(pending);                                 // 删除或修复后失败的旧意图一并保留
  /** @param path 即将变更或尚未确认失效的公开文章路径。 */
  async function remember(path:string) {
    if (pending.has(path)) return;                                // 已确认落盘的意图不重复写日志
    pending.add(path);                                            // 成功基线以前不清除任何路径
    const temporary=`${pendingFile}.${randomUUID()}.tmp`;           // 意图日志不能留下半份JSON
    await writeFile(temporary,JSON.stringify({paths:[...pending].sort()},null,2)+'\n'); // 只记录公开URL，不含正文和凭据
    await rename(temporary,pendingFile);                           // 真正修改目标文件前先保存待失效事实
  }
  const updates:{path:string;revision:string;digest:string|null}[]=[]; // 所有文件和失效清单成功前不推进数据库修订
  const publications=await connection.query('SELECT path,revision,published_revision,content_hash FROM publications ORDER BY path'); // 全局已发布不代表当前目标已有文件
  await mkdir(root,{recursive:true});                             // 首次发布才建站点目录
  for (const publication of publications.rows) {
    const match=/^\/(news|help|page)\/([a-z0-9][a-z0-9-]{0,99})$/.exec(publication.path); // 数据库路径在文件系统边界再限制
    if (!match) throw new Error('静态发布路径不符合公开内容规则'); // 阻止目录穿越写入
    const path=join(root,match[1]!,match[2]!,'index.html');          // 文件位置只取受控字符
    const deployed=existsSync(path)?await readFile(path):null;      // 实际字节可发现同尺寸损坏和丢失
    const actualHash=deployed===null?null:createHash('sha256').update(deployed).digest('hex'); // 文件缺失与撤回都用null表示
    const saved=previous.pages[publication.path];                  // 基线只属于当前STATIC_OUTPUT
    if (previous.renderer===renderer && saved?.revision===publication.revision && saved.hash===actualHash && !pending.has(publication.path)) {
      current[publication.path]=saved;                            // 修订和实际文件都匹配，不查询正文或重新渲染
      if (publication.published_revision!==publication.revision || publication.content_hash!==saved.hash) updates.push({path:publication.path,revision:publication.revision,digest:saved.hash}); // 上次SQL确认失败仍可完成全局记账
      continue;                                                   // 内容未变时HTML及其修改时间保持原样
    }
    const article=await connection.query('SELECT title,content,kind,slug,updated_at FROM articles WHERE kind=$1 AND slug=$2 AND published',[match[1],match[2]]); // 只渲染此目标需要更新或修复的路径
    let digest:string|null=null;                                 // 删除的页面没有内容摘要
    let altered=false;                                           // 文件修复也必须通知CDN，即使数据库内容未变
    if (!article.rowCount) {
      if (deployed!==null) {await remember(publication.path);await rm(path);altered=true;} // 删除前保存意图，不依赖旧文件下次仍存在
    } else {
      const html=render(article.rows[0],`${origin}${publication.path}`); // 模板只插入转义后的纯文本
      digest=createHash('sha256').update(html).digest('hex');      // 精确内容摘要支持ETag和CDN清单
      if (actualHash!==digest) {
        await remember(publication.path);                         // 同摘要修复也先留痕，清单失败后不能被快速分支跳过
        await mkdir(dirname(path),{recursive:true});             // 只创建当前路径的目录
        const temporary=`${path}.${randomUUID()}.tmp`;            // 半写文件不会被Web服务读到
        await writeFile(temporary,html,'utf8');                    // 生成过程中保持线上旧文件可读
        await rename(temporary,path);                             // 同文件系统原子切换
        altered=true;                                            // 新目标、丢失或损坏都需要刷新对应URL
      }
    }
    if (altered || saved?.hash!==digest || pending.has(publication.path)) {
      await remember(publication.path);                           // 未确认的新目标或撤回同样进入持久意图
      changed.add(publication.path);                              // 内容已写好不代表CDN失效已经确认
    }
    current[publication.path]={revision:publication.revision,hash:digest}; // 撤回路径也保留null摘要供重复运行核对
    if (publication.published_revision!==publication.revision || publication.content_hash!==digest) updates.push({path:publication.path,revision:publication.revision,digest}); // 无变化时不重复更新全局记录
  }
  const manifest=JSON.stringify({paths:[...changed].sort()},null,2)+'\n'; // 不放时间戳，空跑不会制造虚假变更
  const invalidation=join(root,'invalidation.json');                // 失效清单必须先于数据库基线持久化
  const temporary=`${invalidation}.${randomUUID()}.tmp`;           // 中途失败不会破坏上一份完整清单
  await writeFile(temporary,manifest);                             // 文件生成失败时所有revision仍可重跑
  await rename(temporary,invalidation);                            // 原子发布本次完整失效意图
  await connection.query('BEGIN');                                // 失效清单就绪后再推进各篇修订
  for (const item of updates) await connection.query('UPDATE publications SET published_revision=$2,content_hash=$3 WHERE path=$1',[item.path,item.revision,item.digest]); // 并发产生的新revision仍保留为待发布
  await connection.query('COMMIT');                               // 数据库失败时重跑依据旧摘要重新生成失效清单
  const content=JSON.stringify({renderer,pages:current},null,2)+'\n'; // 目标基线不包含时间戳、正文或凭据
  if (content!==priorMarker) {
    const temporary=`${marker}.${randomUUID()}.tmp`;               // 失效清单和SQL成功后才确认此目标已发布
    await writeFile(temporary,content);                           // 此处失败仍以旧marker重放失效意图
    await rename(temporary,marker);                               // 原子基线不会给下次运行留下半份JSON
  }
  await rm(pendingFile,{force:true});                             // 清单、SQL和目标基线均成功后才清除，失败至多重放
  console.log(manifest.trim());                                  // 不输出文章正文或数据库凭据
} finally {
  await connection.end();                                         // 释放发布锁
}

// --- 文章模板：纯文本安全、窄屏可读，不需要业务服务渲染每次访问 ---
function render(article:{title:string;content:string;updated_at:Date},canonical:string) {
  const title=escape(article.title);                              // 标题不能注入标签或属性
  const text=escape(article.content);                             // 正文不执行HTML和脚本
  const date=article.updated_at.toISOString().slice(0,10);          // 时间来自文章事实，不在每次生成时改变
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 狐岚云</title><meta name="description" content="${escape(article.content.slice(0,150))}"><link rel="canonical" href="${escape(canonical)}"><meta name="color-scheme" content="dark light"><style>:root{${Object.entries(dark).map(([name,value])=>`--kima-color-${name}:${value}`).join(";")}}body{margin:0;background:var(--kima-color-surface);color:var(--kima-color-on-surface);font:600 16px/1.8 'Maple Mono NF CN',ui-monospace,monospace}main,nav{max-width:800px;margin:auto;padding:32px 24px}nav{display:flex;align-items:center;justify-content:space-between}a{color:var(--kima-color-primary);min-height:48px;display:inline-flex;align-items:center;gap:12px}img{width:56px;height:56px;object-fit:contain}h1{font-size:clamp(28px,5vw,40px);line-height:1.4;text-wrap:balance}article{white-space:pre-wrap;overflow-wrap:anywhere}time{color:var(--kima-color-on-surface-variant);font-size:14px}footer{margin-top:48px}@media(prefers-color-scheme:light){:root{${Object.entries(light).map(([name,value])=>`--kima-color-${name}:${value}`).join(";")}}}</style></head><body><nav aria-label="站点导航"><a href="/"><img src="/brand/fuxoria-logo.png" alt="">狐岚云</a><a href="/console">打开工作台 ↗</a></nav><main><h1>${title}</h1><p><time datetime="${date}">更新于 ${date}</time></p><article>${text}</article><footer><a href="/help">返回帮助中心</a></footer></main></body></html>\n`; // 独立公开HTML没有客户Cookie、会话或余额
}

function escape(value:string) {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!)); // 内容与属性统一转义
}
