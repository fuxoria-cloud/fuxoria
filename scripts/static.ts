/* 静态产物差异分发：比较内容SHA，只复制变化文件，保留仍可能被旧页面引用的指纹资源。
 * 调用：STATIC_OUTPUT=/srv/yunzou/public npm run publish:static；先完成Nuxt构建。
 * 私有页面不在Nuxt公共输出中；此命令只读.output/public，不读取.env里的客户或商户数据。
 * 修改文件前先保存.yunzou-static-pending.json；失效清单和成功基线都完成后才清除，修复失败也不丢路径。
 */
import { readdir,readFile,writeFile,mkdir,rename,rm } from 'node:fs/promises'; // 文件逐个原子替换
import { createHash,randomUUID } from 'node:crypto';                // 摘要比时间戳更能准确识别变化
import { resolve,relative,dirname,join,sep } from 'node:path';       // 路径必须被限制在指定站点目录
import { fileURLToPath } from 'node:url';                          // 默认源路径不受启动位置影响
import { existsSync } from 'node:fs';                             // 首次发布没有历史清单

if (!process.env.STATIC_OUTPUT) throw new Error('请用STATIC_OUTPUT指定独立静态站点目录'); // 不猜测或覆盖用户站点
const source=resolve(process.env.STATIC_SOURCE ?? fileURLToPath(new URL('../apps/web/.output/public',import.meta.url))); // 只处理构建后的公共产物
const target=resolve(process.env.STATIC_OUTPUT);                   // 本次明确指定的输出位置
if (source===target || target.startsWith(source+sep) || source.startsWith(target+sep)) throw new Error('源目录与输出目录必须独立，不能互相包含'); // 防止递归复制或自覆盖
const marker=join(target,'static-manifest.json');                  // 只有本工具上次记录的文件归本工具管理
type Entry={sha256:string;size:number};                           // 清单不含凭据、源文件绝对位置和时间噪声
const previous:Record<string,Entry>=existsSync(marker)?JSON.parse(await readFile(marker,'utf8')):{}; // 读取上次成功发布的摘要
const pendingFile=join(target,'.yunzou-static-pending.json');      // 未确认意图与成功摘要分开保存
const pending=new Set<string>(existsSync(pendingFile)?JSON.parse(await readFile(pendingFile,'utf8')).paths:[]); // 上次修复已写好文件，也必须继续失效
const current:Record<string,Entry>={},changed:string[]=[],removed:string[]=[]; // 每次只输出实际变化的路径
await mkdir(target,{recursive:true});                             // 新站点的目录从这里创建
for (const file of await files(source)) {
  const name=relative(source,file).split(sep).join('/');           // URL统一使用正斜杠
  const data=await readFile(file);                                 // 同一份内容用于摘要和写入
  const sha256=createHash('sha256').update(data).digest('hex');      // 指纹资源不因重新构建时间而变化
  const destination=inside(name);                                // 出口路径只由受控相对路径构成
  current[name]={sha256,size:data.length};                         // 当前构建的完整公共资产事实
  const deployed=existsSync(destination)?createHash('sha256').update(await readFile(destination)).digest('hex'):''; // 大小相同也要核对内容，发现损坏能恢复
  if (previous[name]?.sha256===sha256 && deployed===sha256 && !pending.has(name)) continue; // 正确文件仍须重放未确认的失效路径
  await remember(name);                                          // 真正替换目标前先持久记录意图
  if (deployed!==sha256) {
    await mkdir(dirname(destination),{recursive:true});           // 只创建本文件所需父目录
    const temporary=`${destination}.${randomUUID()}.tmp`;          // CDN源站不会看到半个文件
    await writeFile(temporary,data);                              // 完整生成后才交换
    await rename(temporary,destination);                          // 原子替换单个变化文件
  }
  changed.push('/'+name);                                        // 可交给对象存储或CDN按路径上传失效
}
for (const name of new Set([...Object.keys(previous),...pending])) {
  if (current[name]) continue;                                   // 本轮仍存在的文件已在上面记录为changed
  const path=inside(name);                                        // 历史清单同样经过系统边界校验
  if (name.startsWith('_nuxt/')) {
    if (pending.has(name)) (existsSync(path)?changed:removed).push('/'+name); // 保留旧指纹文件，同时确认上轮尚未完成的失效
    continue;                                                    // 旧客户端仍可能引用的指纹资源不删除
  }
  await remember(name);                                          // 即使删除后中断，下次仍保留这条删除意图
  if (existsSync(path)) await rm(path);                           // 上次失败可能已经删过文件
  removed.push('/'+name);                                        // 只有基线提交成功，删除的CDN失效意图才算完整保存
}
const temporary=`${marker}.${randomUUID()}.tmp`;                    // 清单也在完整发布后才切换
const result={changed,removed};                                   // 只包含可公开的相对URL
const invalidation=join(target,'static-invalidation.json');         // 先保存CDN失效意图，不能先把变化标记为已发布
const intent=`${invalidation}.${randomUUID()}.tmp`;                  // 不留下半份JSON让部署器误用
await writeFile(intent,JSON.stringify(result,null,2)+'\n');         // 此处失败不会推进manifest基线
await rename(intent,invalidation);                                // 与文章发布的失效清单分开保管
await writeFile(temporary,JSON.stringify(current,null,2)+'\n');     // 不写时间戳保证重复构建稳定
await rename(temporary,marker);                                   // 所有公开文件与失效清单就绪后才推进基线
await rm(pendingFile,{force:true});                               // 最后清理意图，失败只会导致下次安全重放
console.log(JSON.stringify(result));                              // 不输出内容正文和本机路径

/** @param name 本轮即将替换、删除或尚未确认失效的受控相对路径。 */
async function remember(name:string) {
  if (pending.has(name)) return;                                  // 已持久保存的路径不重复重写日志
  pending.add(name);                                              // 不区分旧动作，重跑按当前源决定上传或删除
  const temporary=`${pendingFile}.${randomUUID()}.tmp`;             // 不让下次读到半份未确认意图
  await writeFile(temporary,JSON.stringify({paths:[...pending].sort()},null,2)+'\n'); // 只保存文件名，不载入整站资源正文
  await rename(temporary,pendingFile);                             // 原子意图先于实际文件变更生效
}

// --- 只收集真实文件，拒绝将符号链接当公开资产 ---
async function files(directory:string):Promise<string[]> {
  const result:string[]=[];                                       // 一次只持有文件路径，不把全站内容放进内存
  for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=join(directory,entry.name);                         // 名称来自目录，不来自HTTP输入
    if (entry.isSymbolicLink()) throw new Error('公共输出包含符号链接，请先复制为明确的公开文件'); // 防止意外把目录外秘密发布出去
    if (entry.isDirectory()) result.push(...await files(path));   // 逐目录收集同类公开产物
    else if(entry.isFile()) result.push(path);                    // 设备或特殊文件不参与发布
  }
  return result;                                                 // 文件顺序固定，清单便于比较
}

function inside(name:string) {
  const path=resolve(target,name);                                // 正规化旧清单里的路径
  if (!name || name.includes('\\') || name.startsWith('/') || path===target || !path.startsWith(target+sep)) throw new Error('静态清单包含越界路径'); // 不允许清单把删除或写入带到站点外
  return path;                                                   // 所有改动局限于指定输出目录
}
