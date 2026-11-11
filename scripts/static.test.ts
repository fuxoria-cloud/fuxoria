/* 静态发布故障验收：文件更新、修复或删除后清单写入失败，重试仍保留未确认路径。
 * 调用：node --env-file=.env --import tsx --test scripts/static.test.ts。
 * 文章覆盖换目标、缺失损坏及失败重试；使用临时目录和随机独立数据库，结束后完整清理。
 */
import test from 'node:test';                                     // 测试真正的CLI流程和中断恢复
import assert from 'node:assert/strict';                           // 对生成文件和数据库基线逐项核对
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat } from 'node:fs/promises'; // 在临时目录注入可恢复故障
import { randomUUID } from 'node:crypto';                         // 文章验收不争用其它套件的固定数据库
import { tmpdir } from 'node:os';                                 // 验收产物不进入用户网站
import { join } from 'node:path';                                 // 不用shell拼接带路径的命令
import { fileURLToPath } from 'node:url';                          // 脚本位置不依赖测试启动目录
import { execFile } from 'node:child_process';                     // 环境直接作为结构化参数传递
import { promisify } from 'node:util';                            // CLI失败作为明确断言
import pg from 'pg';                                              // 发布修订在真实PostgreSQL中核对

const execute=promisify(execFile);                                // 不经shell解释目录和凭据
const root=fileURLToPath(new URL('../',import.meta.url));          // 与实际项目使用同一套发布命令
const cli=async(script:string,environment:NodeJS.ProcessEnv)=>execute(process.execPath,['--import','tsx',fileURLToPath(new URL(script,import.meta.url))],{cwd:root,env:{...process.env,...environment},timeout:30_000}); // 每次独立进程模拟真实部署器

test('静态分发失败后重放上传与删除意图，损坏同尺寸文件也能修复',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yunzou-static-'));  // 每轮拥有独立发布目录
  const source=join(directory,'source'),target=join(directory,'target'); // 不接触已运行网站
  try {
    await mkdir(source);await mkdir(target);                     // 显式准备两个不同的目录
    await writeFile(join(source,'one.html'),'first');await writeFile(join(source,'two.html'),'second'); // 两份可观察的初始页面
    const environment={STATIC_SOURCE:source,STATIC_OUTPUT:target}; // 配置只存在于测试子进程
    await cli('static.ts',environment);                          // 先建立成功基线
    const baseline=await readFile(join(target,'static-manifest.json'),'utf8'); // 此基线必须在后续故障期间保留
    await writeFile(join(source,'one.html'),'changed');await rm(join(source,'two.html')); // 让同一轮同时包含上传与删除
    await rm(join(target,'static-invalidation.json'));await mkdir(join(target,'static-invalidation.json')); // 用目录阻断最后的原子清单替换
    await assert.rejects(()=>cli('static.ts',environment));       // 不允许报发布成功
    assert.equal(await readFile(join(target,'one.html'),'utf8'),'changed'); // 文件已被先写入，模拟真实半程失败
    assert.equal(await readFile(join(target,'static-manifest.json'),'utf8'),baseline); // 摘要基线没有提前推进
    await rm(join(target,'static-invalidation.json'),{recursive:true}); // 清除导致失败的条件
    await cli('static.ts',environment);                          // 重试必须恢复清单而非吞掉已写过的变化
    assert.deepEqual(JSON.parse(await readFile(join(target,'static-invalidation.json'),'utf8')),{changed:['/one.html'],removed:['/two.html']}); // 上传与删除的CDN意图都没有丢失
    await cli('static.ts',environment);                          // 成功后的空跑保持稳定
    assert.deepEqual(JSON.parse(await readFile(join(target,'static-invalidation.json'),'utf8')),{changed:[],removed:[]}); // 不制造假变化
    const complete=await readFile(join(target,'static-manifest.json'),'utf8'); // 基线已正确记录changed的摘要
    for (const fault of ['damage','missing']) {
      if (fault==='damage') await writeFile(join(target,'one.html'),'broken!'); // 与changed同尺寸但内容损坏
      else await rm(join(target,'one.html'));                    // 丢失不改变此前成功基线
      await rm(join(target,'static-invalidation.json'));await mkdir(join(target,'static-invalidation.json')); // 在修复文件之后阻断失效清单
      await assert.rejects(()=>cli('static.ts',environment));   // 修复完成也不能误报整轮成功
      assert.equal(await readFile(join(target,'one.html'),'utf8'),'changed'); // 文件已恢复成旧marker记录的正确内容
      assert.equal(await readFile(join(target,'static-manifest.json'),'utf8'),complete); // 基线相同不能作为失效已完成的证据
      assert.deepEqual(JSON.parse(await readFile(join(target,'.yunzou-static-pending.json'),'utf8')),{paths:['one.html']}); // 修复前持久保存了未确认路径
      await rm(join(target,'static-invalidation.json'),{recursive:true});await cli('static.ts',environment); // 文件与marker已一致时仍须重放
      assert.deepEqual(JSON.parse(await readFile(join(target,'static-invalidation.json'),'utf8')),{changed:['/one.html'],removed:[]}); // 修复的CDN路径没有丢失
      await assert.rejects(readFile(join(target,'.yunzou-static-pending.json')),{code:'ENOENT'}); // 全部成功后才清除待确认日志
      await cli('static.ts',environment);                        // 确认后的再次运行才是空跑
      assert.deepEqual(JSON.parse(await readFile(join(target,'static-invalidation.json'),'utf8')),{changed:[],removed:[]}); // 不残留永久dirty状态
    }
  } finally {await rm(directory,{recursive:true,force:true})}     // 只清理本轮临时目录
});

test('文章换目标重建、同尺寸损坏修复及清单失败后仍重放更新撤回路径',async()=>{
  assert.ok(process.env.DATABASE_URL,'请提供测试PostgreSQL连接');  // 没有真实数据库不伪称通过
  const address=new URL(process.env.DATABASE_URL),master=new URL(address);master.pathname='/postgres'; // 不使用开发业务表
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(master.hostname),'文章集成验收只允许本机PostgreSQL'); // 不操作外部实例
  const admin=new pg.Client({connectionString:master.href});await admin.connect(); // 只用于管理专用测试库
  const name='yunzou_publication_'+randomUUID().replaceAll('-','');address.pathname=`/${name}`; // 每轮只管理自身随机库
  const directory=await mkdtemp(join(tmpdir(),'yunzou-publication-')); // 静态文件也独立
  let database:pg.Client|undefined;                              // 异常时仍能回收连接
  let created=false;                                            // 建库失败时不误执行清理
  try {
    await admin.query(`CREATE DATABASE ${name}`);created=true;    // 不写开发库，也不删除其它测试拥有的对象
    database=new pg.Client({connectionString:address.href});await database.connect(); // 此后所有业务数据仅在隔离库
    const migrations=new URL('../database/migrations/',import.meta.url); // 所有当前正式约束参与验收
    for (const file of (await readdir(migrations)).filter(file=>file.endsWith('.sql')).sort()) await database.query(await readFile(new URL(file,migrations),'utf8')); // 不用简化结构替代真实迁移
    await database.query("INSERT INTO articles(slug,title,content,kind,published) VALUES('sample','验收文章','first','help',true)"); // 创建一篇真实发布对象
    await database.query("INSERT INTO publications(path) VALUES('/help/sample')"); // 初始修订为1
    const environment={DATABASE_URL:address.href,PUBLIC_ORIGIN:'https://publication.example.invalid',STATIC_OUTPUT:directory}; // 不连接真实域名
    await cli('publish.ts',environment);                         // 先写出成功基线
    const baseline=(await database.query("SELECT published_revision,content_hash FROM publications WHERE path='/help/sample'")).rows[0]; // 记录已经确认的修订
    const initial=await readFile(join(directory,'help/sample/index.html')); // 原目标成功发布后的完整HTML字节
    const replica=join(directory,'replica'),replicaPage=join(replica,'help/sample/index.html'); // 同一数据库的第二个空目标
    const replicaEnvironment={...environment,STATIC_OUTPUT:replica}; // 全局已发布不代表此处有页面
    await cli('publish.ts',replicaEnvironment);                   // 换空目录不需要人为回退数据库修订
    assert.deepEqual(await readFile(replicaPage),initial);        // 已发布文章在新目标仍完整生成
    assert.deepEqual(JSON.parse(await readFile(join(replica,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // 新目标必须输出路径失效意图
    const untouched=await stat(replicaPage);                      // 后续空跑不能原子替换相同HTML
    await cli('publish.ts',replicaEnvironment);                   // 同一目标的文件与成功基线均已匹配
    assert.deepEqual(JSON.parse(await readFile(join(replica,'invalidation.json'),'utf8')),{paths:[]}); // 空跑不制造假变化
    const unchanged=await stat(replicaPage);                      // 内容相同也核对真实文件身份和修改时间
    assert.equal(unchanged.ino,untouched.ino);assert.equal(unchanged.mtimeMs,untouched.mtimeMs); // 相同HTML没有重新写入
    const complete=await readFile(join(replica,'.yunzou-content-manifest.json'),'utf8'); // 旧marker正确，不能靠摘要变化恢复意图
    for (const fault of ['damage','missing']) {
      if (fault==='damage') {
        const damaged=Buffer.from(initial);damaged[0]^=1;         // 字节数保持一致，大小检查不能发现损坏
        await writeFile(replicaPage,damaged);                    // 不修改数据库的文章修订
      } else await rm(replicaPage);                             // 文件丢失也保留旧成功基线
      await rm(join(replica,'invalidation.json'));await mkdir(join(replica,'invalidation.json')); // 已修复HTML后才在失效清单处失败
      await assert.rejects(()=>cli('publish.ts',replicaEnvironment)); // 不能把部分成功当作已确认发布
      assert.deepEqual(await readFile(replicaPage),initial);     // HTML已恢复，下一次实际文件和旧marker会匹配
      assert.equal(await readFile(join(replica,'.yunzou-content-manifest.json'),'utf8'),complete); // 摘要不变仍然存在待确认意图
      assert.deepEqual(JSON.parse(await readFile(join(replica,'.yunzou-content-pending.json'),'utf8')),{paths:['/help/sample']}); // 修复前已经原子保存失效路径
      await rm(join(replica,'invalidation.json'),{recursive:true});await cli('publish.ts',replicaEnvironment); // 重跑不得被文件相同的快速分支忽略
      assert.deepEqual(JSON.parse(await readFile(join(replica,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // 修复和丢失都能恢复CDN意图
      await assert.rejects(readFile(join(replica,'.yunzou-content-pending.json')),{code:'ENOENT'}); // 清单和基线成功后日志才消失
      await cli('publish.ts',replicaEnvironment);                // 确认完成后恢复正常空跑
      assert.deepEqual(JSON.parse(await readFile(join(replica,'invalidation.json'),'utf8')),{paths:[]}); // 不制造后续虚假失效
    }
    const interrupted=join(directory,'interrupted');              // 单独验证新目标中途失败，不能借用原目标基线
    const interruptedEnvironment={...environment,STATIC_OUTPUT:interrupted}; // 此时数据库全局已经是最新状态
    await mkdir(interrupted);await mkdir(join(interrupted,'invalidation.json')); // 文件能写好但最后清单无法原子替换
    await assert.rejects(()=>cli('publish.ts',interruptedEnvironment)); // 失败不能宣告此目标已发布
    assert.deepEqual(await readFile(join(interrupted,'help/sample/index.html')),initial); // HTML在失败前已经生成
    await assert.rejects(readFile(join(interrupted,'.yunzou-content-manifest.json')),{code:'ENOENT'}); // 成功目标基线还没有推进
    await rm(join(interrupted,'invalidation.json'),{recursive:true});await cli('publish.ts',interruptedEnvironment); // 再跑时文件和全局DB虽然已匹配，仍需恢复目标意图
    assert.deepEqual(JSON.parse(await readFile(join(interrupted,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // 重跑没有丢失新目标的CDN路径
    await database.query("UPDATE articles SET content='<script>unsafe()</script> & changed' WHERE slug='sample'"); // 还要验证内容转义
    await database.query("UPDATE publications SET revision=revision+1 WHERE path='/help/sample'"); // 登记一篇变化，不触碰其它页面
    await rm(join(directory,'invalidation.json'));await mkdir(join(directory,'invalidation.json')); // 阻断失效清单持久化
    await assert.rejects(()=>cli('publish.ts',environment));       // 文件已变但不能提前宣告修订成功
    assert.deepEqual((await database.query("SELECT published_revision,content_hash FROM publications WHERE path='/help/sample'")).rows[0],baseline); // 失败后基线仍为上次成功值
    await rm(join(directory,'invalidation.json'),{recursive:true});await cli('publish.ts',environment); // 修复条件并重试
    assert.deepEqual(JSON.parse(await readFile(join(directory,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // 即使文件上次已生成，仍会刷新CDN路径
    const html=await readFile(join(directory,'help/sample/index.html'),'utf8'); // 检查真正会被静态服务器返回的内容
    assert.ok(html.includes('&lt;script&gt;unsafe()&lt;/script&gt; &amp; changed'));assert.ok(!html.includes('<script>unsafe()')); // 正文不能成为可执行代码
    await database.query("UPDATE articles SET published=false WHERE slug='sample'");await database.query("UPDATE publications SET revision=revision+1 WHERE path='/help/sample'"); // 撤回也参与同一恢复流程
    await rm(join(directory,'invalidation.json'));await mkdir(join(directory,'invalidation.json')); // 模拟删除后最后清单失败
    await assert.rejects(()=>cli('publish.ts',environment));       // 已删除文件的路径不能被下次运行忘掉
    await rm(join(directory,'invalidation.json'),{recursive:true});await cli('publish.ts',environment); // 再次重试撤回
    assert.deepEqual(JSON.parse(await readFile(join(directory,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // CDN仍会移除旧页面
    await cli('publish.ts',replicaEnvironment);                   // 另一个目标在全局修订已确认后仍需撤回旧文件
    await assert.rejects(readFile(replicaPage),{code:'ENOENT'});   // 目标不遗留已撤回的公开正文
    assert.deepEqual(JSON.parse(await readFile(join(replica,'invalidation.json'),'utf8')),{paths:['/help/sample']}); // 每个目标单独保留删除失效意图
  } finally {
    if(database) await database.end();                            // 先关业务连接再删专用库
    if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end(); // 关闭全部连接后仅删除本轮随机库
    await rm(directory,{recursive:true,force:true});              // 不留下用户正文或测试文件
  }
});
