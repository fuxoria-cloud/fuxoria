/* 自定义字段真实验证：随机PostgreSQL库、真实Nest HTTP入口和临时私有文件目录。
 * 执行：node --env-file=.env --import tsx --test apps/api/tests/custom-fields.integration.test.ts。
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
const database='yunzou_fields_'+randomUUID().replaceAll('-',''),admin=new pg.Client({connectionString:source}),target=new URL(source);
target.pathname='/'+database;process.env.DATABASE_URL=target.href;process.env.AUDIT_KEY=randomBytes(32).toString('hex');
const directory=await mkdtemp(join(tmpdir(),'yunzou-fields-'));process.env.FILE_STORAGE_DIR=directory;
const {pool,redis}=await import('../src/features/store.js');
const {Access,tokenHash}=await import('../src/utils/access.js');
const {start}=await import('../src/features/session.js');
const Fields=(await import('../src/features/fields.js')).default;
const Ticket=(await import('../src/features/ticket.js')).default,Department=(await import('../src/features/department.js')).default,Download=(await import('../src/features/download.js')).default,Notification=(await import('../src/features/notification.js')).default,Content=(await import('../src/features/content.js')).default;
class SupportTest{}Module({controllers:[Fields,Ticket,Department]})(SupportTest);
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
 const selected=files.filter(file=>file.endsWith('.sql')||file.startsWith('031_')&&file.endsWith('.draft'));
 for(const file of selected.sort())await pool.query(await readFile(new URL(file,root),'utf8')); // 原始迁移加本域结构，不改变开发库
 await redis.connect();[owner,other,administrator,staff,outsider]=await Promise.all([identity(),identity(),identity('admin'),identity('support'),identity('support')]);
 app=await NestFactory.create(SupportTest,{logger:false});app.setGlobalPrefix('api/v1');app.use(cookieParser());app.useGlobalGuards(new Access());await app.listen(0,'127.0.0.1');url=(await app.getUrl())+'/api/v1';
});
after(async()=>{if(app)await app.close();if(redis.isOpen){for(const session of sessions)await redis.del('session:'+session);await redis.quit();}await pool.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});


async function field(input:Record<string,unknown>){return okay('/admin/fields',administrator,'POST',{scope:'profile',key:'test_'+randomUUID().slice(0,8),name:'测试字段',kind:'text',...input});}

test('资料字段区分客户/客服/管理员读写，普通入口不能覆盖隐藏字段',async()=>{
 const visible=await field({key:'public_note',name:'公开补充资料',required:true}),hidden=await field({key:'internal_tag',name:'管理标记',access:'admin'}),readonly=await field({key:'readonly_note',name:'只读说明',customerEditable:false});
 await okay(`/admin/clients/${owner.id}/fields`,administrator,'PUT',{revision:0,values:{public_note:'原始资料',internal_tag:'内部审查事实',readonly_note:'由团队填写'}});
 const mine=await okay('/fields/profile');assert.deepEqual(mine.definitions.map((item:any)=>item.key).sort(),['public_note','readonly_note']);assert.equal('internal_tag' in mine.values,false);assert.equal(mine.definitions.find((item:any)=>item.key==='readonly_note').editable,false);
 assert.equal((await http('/fields/profile',owner,'PUT',{revision:mine.revision,values:{public_note:'修改',internal_tag:'伪造'}})).status,400);assert.equal((await http('/fields/profile',owner,'PUT',{revision:mine.revision,values:{public_note:'修改',readonly_note:'伪造'}})).status,400);
 await okay('/fields/profile',owner,'PUT',{revision:mine.revision,values:{public_note:'合法更新'}});
 const admin=await okay(`/admin/clients/${owner.id}/fields`,administrator);assert.equal(admin.values.internal_tag,'内部审查事实');assert.equal(admin.values.readonly_note,'由团队填写');assert.equal(admin.values.public_note,'合法更新');
 assert.equal((await http('/admin/fields',owner,'POST',{scope:'profile',key:'elevate',name:'越权',kind:'text'})).status,403);
});

test('必填格式由服务端检查，版本冲突不覆盖另一份资料，历史不能修改',async()=>{
 const email=await field({key:'contact_address',name:'联络地址',format:'email'}),before=await okay('/fields/profile');
 assert.equal((await http('/fields/profile',owner,'PUT',{revision:before.revision,values:{public_note:'   '}})).status,400);assert.equal((await http('/fields/profile',owner,'PUT',{revision:before.revision,values:{public_note:'有效',contact_address:'not-an-email'}})).status,400);
 const results=await Promise.all([http('/fields/profile',owner,'PUT',{revision:before.revision,values:{public_note:'版本甲',contact_address:'a@example.test'}}),http('/fields/profile',owner,'PUT',{revision:before.revision,values:{public_note:'版本乙',contact_address:'b@example.test'}})]);assert.equal(results.filter(row=>row.status===200).length,1);assert.equal(results.filter(row=>row.status===409).length,1);
 assert.equal((await pool.query("SELECT count(*)::int AS count FROM custom_field_changes WHERE scope='profile' AND target_id=$1",[owner.id])).rows[0].count,3);
 await assert.rejects(pool.query("UPDATE custom_field_changes SET values='{}' WHERE target_id=$1",[owner.id]),/不可|immutable|append|修改|追加/i);
 assert.equal((await http('/admin/fields',administrator,'POST',{scope:'profile',key:'x',name:'无效',kind:'text',pattern:'(a+)+'})).status>=400,true);
});

test('部门工单收集必填字段并冻结定义，内部必填不阻挡客户，越权值被拒绝',async()=>{
 const department=await okay('/admin/support/departments',administrator,'POST',{name:'字段技术团队'});await okay(`/admin/support/departments/${department.id}/members`,administrator,'PUT',{userIds:[staff.id]});
 const domain=await field({scope:'ticket',key:'affected_domain',name:'发生问题的域名',format:'domain',required:true}),date=await field({scope:'ticket',key:'started_on',name:'开始日期',kind:'date',departmentId:department.id,required:true}),privateField=await field({scope:'ticket',key:'admin_trace',name:'内部排查记录',access:'admin',required:true,departmentId:department.id});
 assert.equal((await http('/tickets',owner,'POST',{subject:'字段检查',message:'正文',departmentId:department.id})).status,400);assert.equal((await http('/tickets',owner,'POST',{subject:'字段检查',message:'正文',departmentId:department.id,customFields:{affected_domain:'example.test',started_on:'2026-02-30'}})).status,400);
 assert.equal((await http('/tickets',owner,'POST',{subject:'字段检查',message:'正文',departmentId:department.id,customFields:{affected_domain:'example.test',started_on:'2026-11-11',admin_trace:'伪造管理员信息'}})).status,400);
 const item=await okay('/tickets',owner,'POST',{subject:'按部门填写资料',message:'正文',departmentId:department.id,customFields:{affected_domain:'example.test',started_on:'2026-11-11'}});
 let view=await okay('/tickets/'+item.id);assert.equal(view.customFields.values.affected_domain,'example.test');assert.equal(view.customFields.definitions.some((field:any)=>field.key==='admin_trace'),false);
 const {id:definitionId,...all}=(await okay('/admin/fields',administrator)).find((field:any)=>field.id===domain.id);await okay('/admin/fields/'+domain.id,administrator,'PUT',{...all,name:'之后修改的新标签'});
 view=await okay('/tickets/'+item.id);assert.equal(view.customFields.definitions.find((field:any)=>field.key==='affected_domain').name,'发生问题的域名');
 const inside=await okay(`/tickets/${item.id}/fields`,administrator);await okay(`/tickets/${item.id}/fields`,administrator,'PUT',{revision:inside.revision,values:{affected_domain:'example.test',started_on:'2026-11-11',admin_trace:'真实排查事实'}});
 assert.equal('admin_trace' in (await okay(`/tickets/${item.id}/fields`,staff)).values,false);assert.equal((await http(`/tickets/${item.id}/fields`,other)).status,404);
 const latest=await okay(`/tickets/${item.id}/fields`);assert.equal((await http(`/tickets/${item.id}/fields`,owner,'PUT',{revision:latest.revision,values:{affected_domain:'new.example.test',started_on:'2026-11-11',admin_trace:'猜测'}})).status,400);
});

test('原可见字段收紧权限后客户不再读取，管理定义变化不能扩散历史内部数据',async()=>{
 const all=await okay('/admin/fields',administrator),{id,...definition}=all.find((field:any)=>field.key==='public_note');await okay('/admin/fields/'+id,administrator,'PUT',{...definition,access:'admin',customerEditable:false});
 const mine=await okay('/fields/profile');assert.equal('public_note' in mine.values,false);assert.equal(mine.definitions.some((field:any)=>field.key==='public_note'),false);assert.equal((await http('/fields/profile',owner,'PUT',{revision:mine.revision,values:{public_note:'越权写回'}})).status,400);
});
