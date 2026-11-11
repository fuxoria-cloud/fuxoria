/* 支持域真实验证：随机PostgreSQL库、真实Nest HTTP入口和临时私有文件目录。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/support.integration.test.ts。
 * 真实会话使用生产Access，测试只创建本轮账号、Redis会话键和数据库，结束后逐一清理。
 */
import 'reflect-metadata';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readdir,readFile,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {Module,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type {Response} from 'express';
if(!process.env.DATABASE_URL)process.loadEnvFile(new URL('../../../.env',import.meta.url));
const source=process.env.SUPPORT_TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(source).hostname))throw new Error('支持域测试只允许本机隔离数据库');
const database='yunzou_support_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);
target.pathname='/'+database;process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'yunzou-support-'));process.env.FILE_STORAGE_DIR=directory;
const {pool,redis}=await import('../src/features/store.js');
const {Access,tokenHash}=await import('../src/utils/access.js');
const {start}=await import('../src/features/session.js');
const Ticket=(await import('../src/features/ticket.js')).default,Department=(await import('../src/features/department.js')).default,Download=(await import('../src/features/download.js')).default,Notification=(await import('../src/features/notification.js')).default,Content=(await import('../src/features/content.js')).default;
class SupportTest{}Module({controllers:[Ticket,Department,Download,Notification,Content]})(SupportTest);
let app:INestApplication,url='',created=false;const sessions:string[]=[];
type Identity={id:string;cookie:string};let owner:Identity,other:Identity,administrator:Identity,staff:Identity,outsider:Identity;
async function identity(role='customer'):Promise<Identity>{
 const user=(await pool.query('INSERT INTO users(email,name,password,role) VALUES($1,$2,$3,$4) RETURNING id',[randomUUID()+'@example.test','支持测试 '+role,'fixture-only',role])).rows[0];let token='';
 await start(user.id,0,{cookie(_name:string,value:string){token=value;sessions.push(tokenHash(value));}} as unknown as Response);return {id:user.id,cookie:'yunzou_session='+token};
}
async function http(path:string,who:Identity|null=owner,method='GET',body?:unknown,raw=false){
 const response=await fetch(url+path,{method,headers:{...(who?{Cookie:who.cookie}:{}),Origin:process.env.PUBLIC_ORIGIN!,...(body!==undefined?{'Content-Type':raw?'application/octet-stream':'application/json'}:{})},...(body!==undefined?{body:raw?body as Buffer:JSON.stringify(body)}:{})});
 const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return {status:response.status,data,headers:response.headers};
}
async function okay(path:string,who:Identity=owner,method='GET',body?:unknown){const result=await http(path,who,method,body);assert.ok(result.status>=200 && result.status<300,JSON.stringify(result.data));return result.data;}
async function ticket(who:Identity=owner,extra:Record<string,unknown>={}){return okay('/tickets',who,'POST',{subject:'需要核对服务',message:'请帮忙查看连接情况。',...extra});}
before(async()=>{
 await admin.connect();await admin.query(`CREATE DATABASE "${database}"`);created=true;
 const root=new URL('../../../database/migrations/',import.meta.url),files=await readdir(root);
 const selected=files.filter(file=>file.endsWith('.sql'));
 for(const file of selected.sort())await pool.query(await readFile(new URL(file,root),'utf8')); // 原始迁移加本域结构，不改变开发库
 await redis.connect();[owner,other,administrator,staff,outsider]=await Promise.all([identity(),identity(),identity('admin'),identity('support'),identity('support')]);
 app=await NestFactory.create(SupportTest,{logger:false});app.setGlobalPrefix('api/v1');app.use(cookieParser());app.useGlobalGuards(new Access());await app.listen(0,'127.0.0.1');url=(await app.getUrl())+'/api/v1';
});
after(async()=>{if(app)await app.close();if(redis.isOpen){for(const session of sessions)await redis.del('session:'+session);await redis.quit();}await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});

test('真实HTTP会话、部门和成员限制客服范围，客户不能操作分配',async()=>{
 assert.equal((await http('/tickets',null)).status,401);
 const dep=await okay('/admin/support/departments',administrator,'POST',{name:'技术支持',description:'连接与运行问题'});
 await okay(`/admin/support/departments/${dep.id}/members`,administrator,'PUT',{userIds:[staff.id]});
 const item=await ticket(owner,{departmentId:dep.id,priority:'high'});
 assert.equal((await http(`/tickets/${item.id}`,other)).status,404);assert.equal((await http(`/tickets/${item.id}`,outsider)).status,404);
 assert.equal((await okay(`/tickets/${item.id}`,staff)).priority,'high');
 assert.equal((await http(`/admin/support/tickets/${item.id}/assign`,owner,'POST',{departmentId:dep.id,assignedTo:owner.id})).status,403);
 assert.equal((await http(`/admin/support/tickets/${item.id}/assign`,administrator,'POST',{departmentId:dep.id,assignedTo:outsider.id})).status,409);
 await okay(`/admin/support/tickets/${item.id}/assign`,administrator,'POST',{departmentId:dep.id,assignedTo:staff.id,priority:'normal'});
 assert.equal((await okay('/admin/support/tickets',staff)).items.some((row:any)=>row.id===item.id),true);
 assert.equal((await okay('/admin/support/tickets',outsider)).items.some((row:any)=>row.id===item.id),false);
});

test('内部备注和内部附件客户不可见，文件真实落在0700目录/0600文件且防篡改',async()=>{
 const item=await ticket(),content=Buffer.from('仅供支持团队查看');
 const upload=await http(`/tickets/${item.id}/files?name=private.txt&internal=true`,administrator,'POST',content,true);assert.equal(upload.status,201,JSON.stringify(upload.data));
 assert.equal((await stat(join(directory,upload.data.id+'.blob'))).mode&0o777,0o600);assert.equal((await stat(directory)).mode&0o777,0o700);
 await okay(`/tickets/${item.id}/replies`,administrator,'POST',{message:'内部诊断记录',internal:true,attachmentIds:[upload.data.id]});
 const customer=await okay(`/tickets/${item.id}`);assert.equal(customer.replies.some((r:any)=>r.message==='内部诊断记录'),false);assert.equal(customer.attachments.length,0);
 assert.equal((await http('/files/'+upload.data.id,owner)).status,404);assert.equal((await http('/files/'+upload.data.id,other)).status,404);
 const download=await http('/files/'+upload.data.id,administrator);assert.equal(download.status,200);assert.deepEqual(download.data,content);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.equal(download.headers.get('cache-control'),'private, no-store');assert.ok(download.headers.get('content-disposition')?.startsWith('attachment;'));
 await writeFile(join(directory,upload.data.id+'.blob'),'篡改');assert.equal((await http('/files/'+upload.data.id,administrator)).status,409);
 assert.equal((await http(`/tickets/${item.id}/files?name=..%2Fescape.txt`,owner,'POST',Buffer.from('abc'),true)).status,400);
 assert.equal((await http(`/tickets/${item.id}/files?name=malware.png`,owner,'POST',Buffer.from('<script>alert(1)</script>'),true)).status,400);
 assert.equal((await http(`/tickets/${item.id}/files?name=large.txt`,owner,'POST',Buffer.alloc(5*1024*1024+1,65),true)).status,413);
 assert.equal((await http(`/tickets/${item.id}/replies`,owner,'POST',{message:'伪装内部',internal:true})).status,403);
});

test('普通附件必须属于当前回复，关闭与回复并发后保持关闭，评价只记录一次',async()=>{
 const item=await ticket();const upload=await http(`/tickets/${item.id}/files?name=info.txt`,owner,'POST',Buffer.from('服务连接说明'),true);assert.equal(upload.status,201);
 const foreign=await ticket(other);assert.equal((await http(`/tickets/${foreign.id}/replies`,other,'POST',{message:'借用附件',attachmentIds:[upload.data.id]})).status,404);
 await okay(`/tickets/${item.id}/replies`,owner,'POST',{message:'补充说明',attachmentIds:[upload.data.id]});assert.equal((await okay(`/tickets/${item.id}`)).attachments[0].replyId!==null,true);
 const results=await Promise.all([http(`/tickets/${item.id}/close`,owner,'POST'),http(`/tickets/${item.id}/replies`,owner,'POST',{message:'同时发送'})]);assert.equal(results[0].status,201);assert.ok([201,409].includes(results[1].status));assert.equal((await okay(`/tickets/${item.id}`)).status,'closed');
 const evaluations=await Promise.all([http(`/tickets/${item.id}/evaluate`,owner,'POST',{rating:5,comment:'解决了'}),http(`/tickets/${item.id}/evaluate`,owner,'POST',{rating:1,comment:'不同评价'})]);assert.equal(evaluations.filter(row=>row.status===201).length,1);assert.equal(evaluations.filter(row=>row.status===409).length,1);
 assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit WHERE target=$1 AND action='ticket.evaluate'",[item.id])).rows[0].count,1);
 await okay(`/tickets/${item.id}/reopen`,owner,'POST');assert.equal((await okay(`/tickets/${item.id}`)).status,'open');
});

test('合并只接受同一客户，合并链保留正文附件且不允许旧工单继续回复',async()=>{
 const a=await ticket(),b=await ticket(),c=await ticket(),foreign=await ticket(other);
 assert.equal((await http(`/admin/support/tickets/${a.id}/merge`,administrator,'POST',{targetId:foreign.id})).status,409);
 await okay(`/tickets/${a.id}/replies`,owner,'POST',{message:'从原工单保留的正文'});
 await okay(`/admin/support/tickets/${a.id}/merge`,administrator,'POST',{targetId:b.id});await okay(`/admin/support/tickets/${b.id}/merge`,administrator,'POST',{targetId:c.id});
 const merged=await okay(`/tickets/${c.id}`);assert.equal(merged.replies.some((row:any)=>row.message==='从原工单保留的正文'),true);assert.equal((await okay(`/tickets/${a.id}`)).mergedInto,c.id);
 assert.equal((await http(`/tickets/${a.id}/replies`,owner,'POST',{message:'旧回复'})).status,409);assert.equal((await http(`/tickets/${a.id}/reopen`,owner,'POST')).status,409);
});

test('内容分类拒绝环与类型串用，快捷回复类别与模板可真实编辑和删除',async()=>{
 const root=await okay('/admin/content/categories',administrator,'POST',{name:'开始使用',kind:'help'}),child=await okay('/admin/content/categories',administrator,'POST',{name:'安装',kind:'help',parentId:root.id});
 assert.equal((await http(`/admin/content/categories/${root.id}`,administrator,'PUT',{name:'开始使用',kind:'help',parentId:child.id})).status,400);
 const article=await okay('/admin/content',administrator,'POST',{slug:'support-help',title:'如何提交说明',content:'正文按纯文本保存',kind:'help',published:true,categoryId:child.id});
 assert.equal((await okay('/content?kind=help&categoryId='+child.id))[0].id,article.id);
 assert.equal((await http('/admin/content',administrator,'POST',{slug:'wrong-kind',title:'无效',content:'正文',kind:'news',published:true,categoryId:child.id})).status,404);
 assert.equal((await http('/admin/content/categories/'+root.id,administrator,'DELETE')).status,409);
 const cat=await okay('/admin/support/reply-categories',administrator,'POST',{name:'连接问题'}),template=await okay('/admin/support/replies',administrator,'POST',{title:'初步排查',message:'请提供发生时间。',categoryId:cat.id});
 await okay('/admin/support/replies/'+template.id,administrator,'PUT',{title:'已更新',message:'请提供时间和错误截图。',categoryId:cat.id});assert.equal((await okay('/admin/support/replies',staff)).some((row:any)=>row.title==='已更新'),true);await okay('/admin/support/replies/'+template.id,administrator,'DELETE');
});

test('下载资料支持公开/登录/指定服务权限，草稿和不持有服务者不能下载',async()=>{
 const file=await http('/admin/support/files?name=guide.pdf',administrator,'POST',Buffer.from('%PDF-1.7\nfixture'),true);assert.equal(file.status,201);
 const pub=await okay('/admin/support/downloads',administrator,'POST',{fileId:file.data.id,title:'公开手册',access:'public',published:true});
 assert.equal((await http('/public/downloads/'+pub.id+'/file',null)).status,200);
 const account=await okay('/admin/support/downloads',administrator,'POST',{fileId:file.data.id,title:'账户资料',access:'account',published:true});assert.equal((await http('/public/downloads/'+account.id+'/file',null)).status,404);assert.equal((await http('/downloads/'+account.id+'/file',other)).status,200);
 const product=(await pool.query("INSERT INTO products(name,price_cents) VALUES('配套服务',100) RETURNING id")).rows[0];
 const order=(await pool.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents) VALUES($1,$2,$3,'fixture',100) RETURNING id",[owner.id,product.id,randomUUID()])).rows[0];
 await pool.query("INSERT INTO services(user_id,product_id,order_id,name,status) VALUES($1,$2,$3,'测试服务','active')",[owner.id,product.id,order.id]);
 const gated=await okay('/admin/support/downloads',administrator,'POST',{fileId:file.data.id,title:'服务资料',access:'service',productId:product.id,published:true});assert.equal((await http('/downloads/'+gated.id+'/file',owner)).status,200);assert.equal((await http('/downloads/'+gated.id+'/file',other)).status,404);assert.equal((await okay('/downloads',other)).some((row:any)=>row.id===gated.id),false);
 const changed=(await pool.query("INSERT INTO products(name,price_cents) VALUES('升级后资料',200) RETURNING id")).rows[0];await pool.query('UPDATE services SET current_product_id=$2 WHERE product_id=$1',[product.id,changed.id]);
 const current=await okay('/admin/support/downloads',administrator,'POST',{fileId:file.data.id,title:'当前方案资料',access:'service',productId:changed.id,published:true});assert.equal((await http('/downloads/'+current.id+'/file',owner)).status,200);assert.equal((await http('/downloads/'+gated.id+'/file',owner)).status,404);
 const draft=await okay('/admin/support/downloads',administrator,'POST',{fileId:file.data.id,title:'未发布资料',published:false});assert.equal((await http('/downloads/'+draft.id+'/file',owner)).status,404);
});

test('站内通知严格按账户读取、已读、删除，消息与工单事实共同提交',async()=>{
 const result=await okay('/admin/notifications',administrator,'POST',{userIds:[owner.id],title:'核对通知',message:'只发送给这个账户',link:'/console/tickets'});assert.equal(result.count,1);
 const list=await okay('/notifications');const item=list.items.find((row:any)=>row.title==='核对通知');assert.ok(item);assert.equal((await http(`/notifications/${item.id}/read`,other,'POST')).status,404);assert.equal((await http(`/notifications/${item.id}`,other,'DELETE')).status,404);
 await okay(`/notifications/${item.id}/read`,owner,'POST');assert.ok((await okay('/notifications')).items.find((row:any)=>row.id===item.id).readAt);await okay(`/notifications/${item.id}`,owner,'DELETE');assert.equal((await okay('/notifications')).items.some((row:any)=>row.id===item.id),false);
 assert.equal((await http('/admin/notifications',administrator,'POST',{userIds:[owner.id],title:'外部链接',message:'不可接受',link:'//example.test'})).status,400);
 await okay('/notifications/read-all',owner,'POST');assert.equal((await okay('/notifications')).unread,0);
});
