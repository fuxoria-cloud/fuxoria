/* 插件发现：列出实际加载的业务主体、支付协议能力和Go节点报告的开通插件。
 * 调用：管理员GET /api/v1/admin/extensions；新增业务/支付文件在重启后自动出现。
 * 此处不接受上传后立即执行任意代码；组件代码来自部署时的受信任项目文件。
 */
import { Controller,Get,RequestMethod } from '@nestjs/common';      // 路由清单来自框架真实元数据
import { PATH_METADATA,METHOD_METADATA } from '@nestjs/common/constants.js'; // 不手写第二份接口登记表
import { readdir,readFile } from 'node:fs/promises';                // 文件位置决定业务插件是否存在
import { createHash } from 'node:crypto';                          // 摘要标识当前部署的真实代码
import { Roles } from '../utils/access.js';                       // 只有管理员可检查运行代码清单
import { pool } from './store.js';                                // 开通节点能力来自持久化心跳
import { payments } from './payment.js';                          // 支付能力直接读取真实插件对象

@Controller('admin/extensions') @Roles('admin')
export default class Extension {
  /** @returns 当前部署实际存在的插件与接口。 */
  @Get() async list() {
    const business=[];                                           // 不将文件名再次硬编码到中央列表
    const directory=new URL('./',import.meta.url);                // 源码和产物都使用各自的主体目录
    for (const file of (await readdir(directory)).sort()) {
      if (!/\.(js|ts)$/.test(file) || file.endsWith('.d.ts')) continue; // 排除类型声明和映射文件
      const module=await import(new URL(file,directory).href);    // 加载与主入口相同的受信任文件
      if (!module.default) continue;                             // 数据主体不伪装成HTTP业务扩展
      const root=Reflect.getMetadata(PATH_METADATA,module.default) ?? ''; // 主路由来自@Controller
      const routes=[];                                          // 每个公开操作只登记一次
      for (const name of Object.getOwnPropertyNames(module.default.prototype)) {
        const operation=module.default.prototype[name];          // 一份主体文件包含其业务操作
        if (typeof operation!=='function' || !Reflect.hasMetadata(METHOD_METADATA,operation)) continue; // 跳过构造与内部动作
        const method=Reflect.getMetadata(METHOD_METADATA,operation) as RequestMethod; // 使用实际HTTP方法
        const path=Reflect.getMetadata(PATH_METADATA,operation) ?? ''; // 使用实际方法路径
        routes.push({method:RequestMethod[method],path:`/api/v1/${[root,path].filter(Boolean).join('/')}`}); // 不猜测兼容接口
      }
      const source=await readFile(new URL(file,directory));        // 源码摘要便于部署和审计核对
      business.push({id:file.replace(/\.(ts|js)$/,''),name:module.default.name,type:'business',sha256:createHash('sha256').update(source).digest('hex'),routes}); // 文件名是唯一稳定标识
    }
    const gateways=payments.list().map(item=>{
      const plugin=payments.get(item.id);                         // 能力与实际可调用方法一致
      return {...item,type:'payment',query:typeof plugin.query==='function',refund:typeof plugin.refund==='function',queryRefund:typeof plugin.queryRefund==='function'}; // 商户具体协议限制由渠道返回
    });
    const agents=await pool.query("SELECT id,version,plugins,heartbeat_at AS \"heartbeatAt\",heartbeat_at>now()-interval '90 seconds' AS online FROM agent_presence ORDER BY heartbeat_at DESC LIMIT 100"); // 避免把离线节点当作可用交付能力
    return {business,gateways,agents:agents.rows};                  // 清单不包含商户密钥、执行器环境和会话数据
  }
}
