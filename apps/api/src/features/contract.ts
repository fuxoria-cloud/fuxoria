/* 合同：模板按申请时快照保存，主账号复核后签署，历史签署事实与文本指纹不可覆盖。
 * 调用：GET/POST /contracts；POST /contracts/:id/sign {signer,accept:true,snapshotHash,password,totp?}。
 * 管理：/admin/contract-templates；下载GET /contracts/:id/document返回带文本指纹的PDF记录。
 */
import {Body,Controller,Get,Post,Put,Param,Headers,Req,Res,ConflictException,NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Response} from 'express';
import {pool,transaction} from './store.js';
import {record} from './audit.js';
import {factorFields,verifyIdentity} from './security.js';
import {Roles,type SessionRequest} from '../utils/access.js';
import {read,uuid} from '../utils/input.js';
import {pdf} from '../utils/pdf.js';

const template=z.object({title:z.string().trim().min(1).max(200),content:z.string().trim().min(1).max(50000),productIds:z.array(uuid).max(200).default([]),active:z.boolean().default(true)}).strict();
const party=z.object({name:z.string().trim().min(1).max(100),company:z.string().trim().max(200).default(''),address:z.string().trim().min(1).max(500),phone:z.string().trim().min(1).max(40),email:z.email().max(254)}).strict();
const key=z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const columns='c.id,c.number::text,c.service_id AS "serviceId",c.snapshot,c.snapshot_hash AS "snapshotHash",c.status,c.signer,c.signed_at AS "signedAt",c.void_reason AS "voidReason",c.created_at AS "createdAt"';

@Controller()
export default class Contract {
  @Get('contract-templates') async templates() {return (await pool.query('SELECT id,title,content,product_ids AS "productIds" FROM contract_templates WHERE active ORDER BY created_at DESC')).rows;}
  @Roles('admin') @Get('admin/contract-templates') async allTemplates() {return (await pool.query('SELECT id,title,content,product_ids AS "productIds",active FROM contract_templates ORDER BY created_at DESC')).rows;}
  @Roles('admin') @Post('admin/contract-templates') async createTemplate(@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(template,body);
    return transaction(async connection=>{
      const saved=(await connection.query('INSERT INTO contract_templates(title,content,product_ids,active) VALUES($1,$2,$3,$4) RETURNING id',[input.title,input.content,input.productIds,input.active])).rows[0];
      await record(connection,request.actorId??request.user.id,'contract.template.create',saved.id,{title:input.title});return saved;
    });
  }
  @Roles('admin') @Put('admin/contract-templates/:id') async updateTemplate(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    const input=read(template,body);read(uuid,id);
    return transaction(async connection=>{
      const saved=await connection.query('UPDATE contract_templates SET title=$2,content=$3,product_ids=$4,active=$5,updated_at=now() WHERE id=$1 RETURNING id',[id,input.title,input.content,input.productIds,input.active]);
      if(!saved.rowCount)throw new NotFoundException('合同模板不存在');
      await record(connection,request.actorId??request.user.id,'contract.template.update',id,{title:input.title});return saved.rows[0];
    });
  }
  @Get('contracts') async list(@Req() request:SessionRequest) {return (await pool.query(`SELECT ${columns} FROM contracts c WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 200`,[request.user.id])).rows;}
  @Roles('admin') @Get('admin/contracts') async adminList() {return (await pool.query(`SELECT ${columns},u.email FROM contracts c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200`)).rows;}
  @Get('contracts/:id') async get(@Param('id') id:string,@Req() request:SessionRequest) {
    const found=await pool.query(`SELECT ${columns} FROM contracts c WHERE c.id=$1 AND (c.user_id=$2 OR $3='admin')`,[read(uuid,id),request.user.id,request.user.role]);
    if(!found.rowCount)throw new NotFoundException('合同不存在');return found.rows[0];
  }
  @Post('contracts') async create(@Body() body:unknown,@Headers('idempotency-key') token:unknown,@Req() request:SessionRequest) {
    const input=read(z.object({templateId:uuid,serviceId:uuid.optional(),party}).strict(),body);read(key,token);
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transaction(async connection=>{
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contract:${request.user.id}:${token}`]);
      const old=await connection.query('SELECT id,request_hash FROM contracts WHERE user_id=$1 AND idempotency_key=$2',[request.user.id,token]);
      if(old.rowCount){if(old.rows[0].request_hash!==fingerprint)throw new ConflictException('提交标识已经用于另一份合同');return {id:old.rows[0].id};}
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contract-active:${request.user.id}:${input.templateId}:${input.serviceId??'base'}`]);
      if((await connection.query("SELECT 1 FROM contracts WHERE user_id=$1 AND template_id=$2 AND service_id IS NOT DISTINCT FROM $3::uuid AND status IN('pending','signed')",[request.user.id,input.templateId,input.serviceId??null])).rowCount)throw new ConflictException('已有待签或已签合同，请先查看原记录');
      const form=(await connection.query('SELECT * FROM contract_templates WHERE id=$1 AND active FOR SHARE',[input.templateId])).rows[0];
      if(!form)throw new NotFoundException('可用合同模板不存在');
      let service:Record<string,any>|undefined;
      if(input.serviceId){service=(await connection.query("SELECT s.*,COALESCE(s.current_product_id,s.product_id) AS effective_product_id,p.name AS product_name FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 AND COALESCE((to_jsonb(s)->>'current_owner_id')::uuid,s.user_id)=$2 AND s.status IN('active','suspended') FOR SHARE OF s",[input.serviceId,request.user.id])).rows[0];if(!service)throw new NotFoundException('可签合同的服务不存在');}
      if(form.product_ids.length && (!service || !form.product_ids.includes(service.effective_product_id)))throw new ConflictException('这份合同模板不适用于当前服务');
      const values:Record<string,string>={name:input.party.name,company:input.party.company,service:service?.name??'',product:service?.product_name??''};
      const content=form.content.replace(/\{\{(name|company|service|product)\}\}/g,(_:string,name:string)=>values[name]!);
      const snapshot={title:form.title,content,party:input.party,service:service?{id:service.id,name:service.name,productName:service.product_name}:null};
      const digest=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const saved=(await connection.query('INSERT INTO contracts(user_id,template_id,service_id,snapshot,snapshot_hash,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[request.user.id,input.templateId,input.serviceId??null,snapshot,digest,token,fingerprint])).rows[0];
      await record(connection,request.actorId??request.user.id,'contract.request',saved.id,{snapshotHash:digest,serviceId:input.serviceId});return saved;
    });
  }
  @Post('contracts/:id/sign') async sign(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);const input=read(z.object({signer:z.string().trim().min(1).max(100),accept:z.literal(true),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(1).max(128),...factorFields}).strict(),body);
    await verifyIdentity(request,input,'contract.sign');
    return transaction(async connection=>{
      const target=(await connection.query('SELECT service_id FROM contracts WHERE id=$1 AND user_id=$2',[id,request.user.id])).rows[0]; // 先确定服务锁，和转移保持服务→合同顺序
      if(target?.service_id)await connection.query('SELECT id FROM services WHERE id=$1 FOR SHARE',[target.service_id]); // 转移不会与签署互相等待
      const found=(await connection.query('SELECT * FROM contracts WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,request.user.id])).rows[0];
      if(!found)throw new NotFoundException('合同不存在');
      if(found.snapshot_hash!==input.snapshotHash || input.signer!==found.snapshot.party.name)throw new ConflictException('签署人或文本指纹与合同不一致，请重新核对');
      if(found.status==='signed')return {ok:true,snapshotHash:found.snapshot_hash};
      if(found.status!=='pending')throw new ConflictException('此合同当前不能签署');
      if(found.service_id && !(await connection.query("SELECT 1 FROM services s WHERE s.id=$1 AND COALESCE((to_jsonb(s)->>'current_owner_id')::uuid,s.user_id)=$2 AND s.status IN('active','suspended') FOR SHARE",[found.service_id,request.user.id])).rowCount)throw new ConflictException('服务归属或状态已经变化，不能签署原申请');
      await connection.query("UPDATE contracts SET status='signed',signer=$2,signed_at=now(),sign_ip=$3 WHERE id=$1",[id,input.signer,request.ip]);
      await record(connection,request.actorId??request.user.id,'contract.sign',id,{snapshotHash:found.snapshot_hash,signer:input.signer});return {ok:true,snapshotHash:found.snapshot_hash};
    });
  }
  @Post('contracts/:id/cancel') async cancel(@Param('id') id:string,@Req() request:SessionRequest) {
    read(uuid,id);return transaction(async connection=>{
      const saved=await connection.query("UPDATE contracts SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",[id,request.user.id]);
      if(!saved.rowCount)throw new ConflictException('只能撤回尚未签署的本人合同');
      await record(connection,request.actorId??request.user.id,'contract.cancel',id,{});return {ok:true};
    });
  }
  @Roles('admin') @Post('admin/contracts/:id/void') async void(@Param('id') id:string,@Body() body:unknown,@Req() request:SessionRequest) {
    read(uuid,id);const input=read(z.object({reason:z.string().trim().min(1).max(1000),password:z.string().min(1).max(128),...factorFields}).strict(),body);await verifyIdentity(request,input,'contract.void','admin');
    return transaction(async connection=>{
      const saved=await connection.query("UPDATE contracts SET status='voided',void_reason=$2 WHERE id=$1 AND status='signed' RETURNING id",[id,input.reason]);
      if(!saved.rowCount)throw new ConflictException('只能作废已签署的合同');
      await record(connection,request.actorId??request.user.id,'contract.void',id,{reason:input.reason});return {ok:true};
    });
  }
  @Get('contracts/:id/document') async document(@Param('id') id:string,@Req() request:SessionRequest,@Res() response:Response) {
    const row=await this.get(id,request);const p=row.snapshot.party;
    response.setHeader('Content-Disposition',`attachment; filename="contract-${row.number}.pdf"`);
    response.setHeader('X-Content-Type-Options','nosniff');
    response.type('application/pdf').send(pdf(row.snapshot.title,[`合同编号：${row.number}`,`状态：${row.status}`,`签约方：${p.name} ${p.company}`,`地址：${p.address}`,`联系方式：${p.phone} ${p.email}`,'',row.snapshot.content,'',`签署人：${row.signer??'尚未签署'}`,`签署时间：${row.signedAt??'—'}`,`文本SHA-256：${row.snapshotHash}`,row.voidReason?`作废说明：${row.voidReason}`:'']));
  }
}
