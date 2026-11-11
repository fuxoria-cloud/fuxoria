/* 支持与服务管理页面验收：真实Nuxt/KIMA页面，业务API严格拦截为本轮浏览器夹具。
 * 执行：WEB_TEST_ORIGIN=http://127.0.0.1:3400 node --test apps/web/tests/support.browser.mjs。
 * 测试不访问真实客户、支付或开通接口，手机/桌面截图保存artifacts/v376-*。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const origin=new URL(process.env.WEB_TEST_ORIGIN || 'http://127.0.0.1:3400');if(!['127.0.0.1','localhost'].includes(origin.hostname))throw new Error('只允许本机前端');
const artifacts=new URL('../../../artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});
const ids={owner:'00000000-0000-4000-8000-000000000001',admin:'00000000-0000-4000-8000-000000000002',staff:'00000000-0000-4000-8000-000000000003',dept:'00000000-0000-4000-8000-000000000004',ticket:'00000000-0000-4000-8000-000000000005',service:'00000000-0000-4000-8000-000000000006',transfer:'00000000-0000-4000-8000-000000000007',cancel:'00000000-0000-4000-8000-000000000008'};
let accessDestination='',accessChannel='email';
const preferences={emailMarketing:false,smsMarketing:false,siteMarketing:false,quietEnabled:false,quietStart:1260,quietEnd:480,timezone:'Asia/Shanghai'};
const fieldData={definitions:[{id:'field-1',scope:'profile',key:'customer_domain',name:'用户域名',description:'填写用于当前项目的域名。',kind:'text',format:'domain',options:[],required:true,access:'customer',customerEditable:true,editable:true,minimum:1,maximum:253,departmentId:null,position:0,active:true}],values:{customer_domain:'example.test'},revision:0};
const messageTemplates=[{id:'message-template-1',name:'客户进展提醒',channel:'site',category:'transactional',scope:'account',subject:'进展提醒',body:'你好，{{name}}，打开控制台查看这次进展。',link:'/console',active:true}];
let messageJob={id:'message-job-1',batchId:'message-batch-1',channel:'email',category:'transactional',subject:'服务进展提醒',state:'uncertain',attempts:1,maxAttempts:5,lastError:'发送结果未确认，请按任务编号核对机构记录',createdAt:'2026-11-10T00:00:00Z',name:'林间来客',email:'guest@example.test',phone:'+8613800000001'};
const user={id:ids.owner,name:'林间来客',email:'guest@example.test',role:'customer'},administrator={id:ids.admin,name:'支持管理员',email:'support@example.test',role:'admin'};
const departments=[{id:ids.dept,name:'技术支持',description:'服务连接与运行问题',active:true,position:0,members:[{id:ids.staff,name:'小岚',email:'helper@example.test'}]}];
const service={id:ids.service,name:'我的轻量云空间',productName:'轻量云 · 北辰',status:'active',billingPeriod:'month',billingMonths:1,configurationLabels:{运行内存:'4GB',系统盘:'60GB NVMe'},remark:'个人站点与备份',groupId:null,autoRenew:false,dueAt:'2026-12-20T00:00:00Z',createdAt:'2026-10-20T00:00:00Z',priceCents:'2900',externalId:'cloud-star-01',email:user.email};
const ticket={id:ids.ticket,userId:ids.owner,subject:'服务连接需要帮助',status:'open',priority:'normal',departmentId:ids.dept,departmentName:'技术支持',assignedTo:ids.staff,assigneeName:'小岚',serviceId:ids.service,serviceName:service.name,createdAt:'2026-11-10T09:00:00Z',replies:[{id:'reply-1',message:'下午开始连接不太稳定，已检查本地网络。',name:user.name,role:'customer',createdAt:'2026-11-10T09:00:00Z'},{id:'reply-2',message:'收到，我们正在核对这段时间的连接情况。可以补充一下发生时间和错误截图。',name:'小岚',role:'support',createdAt:'2026-11-10T09:30:00Z'}],attachments:[]};
const transfer={id:ids.transfer,serviceId:ids.service,serviceName:service.name,senderId:ids.owner,recipientId:ids.admin,senderEmail:user.email,recipientEmail:'newowner@example.test',status:'pending',expiresAt:'2099-11-20T00:00:00Z',createdAt:'2026-11-10T00:00:00Z'};
const cancellation={id:ids.cancel,serviceId:ids.service,serviceName:service.name,mode:'end_of_period',reason:'阶段性项目已结束，希望保留到本计费周期结束。',status:'pending',email:user.email,createdAt:'2026-11-10T00:00:00Z'};
async function withPage(role,viewport,run,scenario={}){
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport,serviceWorkers:'block'}),errors=[],unknown=[],calls=[],documents=[];
 try{const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.resourceType()==='document')documents.push(request.url());});
 await context.route('**/*',async route=>{const address=new URL(route.request().url());if(address.origin!==origin.origin){unknown.push('external '+address.origin);return route.abort();}if(!address.pathname.startsWith('/api/'))return route.continue();
 const path=address.pathname.slice('/api/v1'.length),method=route.request().method();calls.push({path,method,body:route.request().postData()});const reply=data=>route.fulfill({json:data});
 if(path==='/currencies')return reply([{code:'CNY',name:'人民币',symbol:'¥',suffix:'',decimals:2,rateNumerator:'1',rateDenominator:'1',isDefault:true,active:true}]);
 if(path==='/auth/access-options')return reply({emailEnabled:true,smsEnabled:true,phonePasswordEnabled:true});
 if(path==='/auth/challenges'){const body=JSON.parse(route.request().postData());accessDestination=body.destination;accessChannel=body.channel;return reply({id:'access-challenge',expiresAt:'2099-11-20T10:10:00Z',retryAfterSeconds:60});}
 if(['/auth/phone-login','/auth/verify-login'].includes(path))return reply(user);
 if(path==='/auth/verify-register')return reply(user);
 if(path==='/auth/recover')return reply({ok:true});
 if(path==='/overview')return reply({serviceCount:1,unpaidCount:0,ticketCount:1,balanceCents:'12800',recentInvoices:[],recentServices:[service]});
 if(path==='/fields/ticket')return reply({definitions:[]});
 if(path==='/fields/profile'){if(method==='PUT'){fieldData.values=JSON.parse(route.request().postData()).values;fieldData.revision++;return reply({ok:true});}return reply(fieldData);}
 if(path==='/admin/fields')return reply(fieldData.definitions);
 if(path==='/admin/users')return reply([user]);
 if(path==='/admin/clients')return reply({items:[user],total:1,page:1,limit:50});
 if(path==='/message-preferences'){if(method==='PUT'){Object.assign(preferences,JSON.parse(route.request().postData()));return reply({ok:true});}return reply(preferences);}
 if(path==='/admin/messaging/options')return reply({site:true,email:true,sms:true,variables:['name','email','phone','serviceName','serviceId','dueAt']});
 if(path==='/admin/messaging/templates')return reply(messageTemplates);
 if(path==='/admin/messaging/care')return reply([{id:'care-1',name:'到期前三天提醒',templateId:'message-template-1',templateName:'客户进展提醒',trigger:'service_due_days',days:3,productIds:[],active:true,channel:'site'}]);
 if(path==='/admin/messaging/batches'){if(method==='POST')return reply({id:'message-batch-1'});return reply([{id:'message-batch-1',name:'客户进展提醒',channel:'site',category:'transactional',total:1,sent:0,uncertain:1,pending:0,createdAt:'2026-11-10T00:00:00Z'}]);}
 if(path==='/admin/messaging/jobs')return reply({items:[messageJob],total:1,page:1,limit:50});
 if(path==='/admin/messaging/jobs/message-job-1/resolve'){messageJob={...messageJob,state:'queued'};return reply({ok:true,state:'queued'});}
 if(path==='/auth/verification')return reply({email:user.email,phone:'+8613800000001',emailVerified:false,phoneVerified:true,emailEnabled:true,smsEnabled:true});
 if(path==='/auth/verification/challenges')return reply({id:'verification-challenge',expiresAt:'2099-11-20T10:10:00Z',retryAfterSeconds:60});
 if(path==='/auth/verification/confirm'){user.email='verified@example.test';return reply({ok:true,channel:'email'});}
 if(path==='/admin/overview')return reply({userCount:2,serviceCount:1,orderCount:1,failedJobCount:0,revenueCents:'2900',ticketCount:1});
 if(path==='/auth/me')return reply(role==='admin'?administrator:user);
 if(path==='/wallet')return reply({balanceCents:'12800',currency:'CNY'});
 if(path==='/support/departments'||path==='/admin/support/departments')return reply(departments);
 if(path==='/admin/support/agents')return reply([{id:ids.staff,name:'小岚',email:'helper@example.test',role:'support'},administrator]);
 if(path==='/admin/support/replies')return reply([{id:'template-a',title:'请补充发生时间',message:'请补充问题发生的具体时间。',categoryId:null}]);
 if(path==='/admin/content/categories'||path==='/downloads/categories'||path==='/admin/support/reply-categories')return reply([]);
 if(path==='/payments')return reply([]);
 if(path==='/products')return reply([{id:'product-1',name:'轻量云',priceCents:'2900',description:'个人项目',active:true}]);
 if(path==='/admin/support/tickets')return reply({items:[ticket],page:1,limit:100,total:1});
 if(path==='/tickets')return reply([ticket]);
 if(path===`/tickets/${ids.ticket}`)return reply(ticket);
 if(path===`/tickets/${ids.ticket}/replies`){ticket.replies.push({id:'reply-3',message:JSON.parse(route.request().postData()).message,name:user.name,role:'customer',createdAt:new Date().toISOString()});return reply({ok:true});}
 if(path==='/notifications'){return reply({items:[{id:'notice-1',title:'工单有新回复',message:'支持团队已回复你的连接问题，打开工单继续沟通。',link:`/console/tickets/${ids.ticket}`,createdAt:'2026-11-10T09:30:00Z',readAt:null}],unread:1,total:1,page:1,limit:50});}
 if(path==='/downloads')return reply([{id:'download-1',fileId:'file-1',title:'轻量云使用手册',description:'从首次连接到日常维护，按步骤配置你的云空间。',name:'轻量云使用手册.pdf',mediaType:'application/pdf',sizeBytes:286720,access:'account',published:true,categoryName:'使用文档'}]);
 if(path==='/service-upgrades')return reply([]);
 if(path===`/services/${ids.service}/upgrade-options`)return reply({currentProductId:'product-1',configuration:{backup:false},period:scenario.sourcePeriod||'month',targets:[{id:'product-1',name:'轻量云 · 配置变更',priceCents:'2900',currency:'CNY',periods:[{period:'year',priceCents:'29000',setupCents:'0',active:true}],options:[{key:'backup',name:'自动备份',kind:'boolean',required:true,minimum:0,maximum:1,choices:[]}]}],canUpgrade:true,reason:null});
 if(path==='/catalogue/my-quote'){const body=JSON.parse(route.request().postData());return reply({configuration:body.configuration,options:[{key:'backup',name:'自动备份',kind:'boolean',required:true,minimum:0,maximum:1,choices:[]}],currency:'CNY',renewAmountCents:'4900'});}
 if(path===`/services/${ids.service}/upgrade-quote`){const body=JSON.parse(route.request().postData());return reply({id:'quote-1',serviceId:ids.service,productId:'product-1',productName:'轻量云 · 自动备份',configuration:body.configuration,configurationLabels:{自动备份:body.configuration.backup?'是':'否'},oldRenewCents:'2900',renewAmountCents:'4900',amountCents:'970',currency:'CNY',period:body.period||'month',sourcePeriod:scenario.sourcePeriod||'month',cycleChange:!!scenario.sourcePeriod&&scenario.sourcePeriod!==body.period,remainingMs:'1296000000',periodMs:'2678400000',status:'quoted',expiresAt:'2099-11-20T10:15:00Z'});}
 if(path===`/services/${ids.service}/upgrades`)return reply({invoiceId:'invoice-upgrade',status:'unpaid'});
 if(path==='/invoices/invoice-upgrade')return reply({id:'invoice-upgrade',status:'unpaid',amountCents:'970',createdAt:'2026-11-10T00:00:00Z',productName:'方案变更差价',payable:true,items:[]});
 if(path==='/invoices/invoice-upgrade/refunds')return reply([]);
 if(path==='/service-groups')return reply([{id:'group-1',name:'个人项目',sort:0}]);
 if(path==='/service-cancellations')return reply([]);
 if(path==='/service-transfers')return reply([transfer]);
 if(path==='/services'||path==='/admin/services')return reply([service]);
 if(path===`/services/${ids.service}`&&method==='GET')return reply(service);
 if(path===`/services/${ids.service}/auto-renew`){service.autoRenew=JSON.parse(route.request().postData()).enabled;return reply({enabled:service.autoRenew});}
 if(path===`/services/${ids.service}`&&method==='PATCH')return reply({ok:true});
 if(path==='/admin/service-upgrades')return reply([]);
 if(path==='/admin/service-cancellations')return reply([cancellation]);
 if(path===`/admin/service-cancellations/${ids.cancel}/decide`){cancellation.status=JSON.parse(route.request().postData()).action==='approve'?'approved':'rejected';return reply({status:cancellation.status});}
 unknown.push(method+' '+path);return route.fulfill({status:599,json:{message:'未预期接口'}});
 });
 await run(page,{calls,documents});assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);
 }finally{await browser.close();}
}
async function screenshot(page,name){await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));});await page.screenshot({path:new URL(name,artifacts).pathname,fullPage:true,animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'页面超出视口');const clipped=await page.evaluate(()=>[...document.querySelectorAll('.kima-text-field,.kima-select,.kima-number-field,.kima-textarea')].filter(el=>el.checkVisibility()).flatMap(el=>{const r=el.getBoundingClientRect(),panel=el.closest('.panel')?.getBoundingClientRect(),left=panel?.left??0,right=panel?.right??innerWidth;return r.width&&r.height&&(r.left<left-2||r.right>right+2)?[{label:el.querySelector('input,[role=combobox],textarea')?.getAttribute('aria-label'),left:r.left,right:r.right,panelRight:right}]:[]}));assert.deepEqual(clipped,[],'可见表单控件必须完整留在卡片边界内');if(page.viewportSize().width===390){const top=await page.evaluate(()=>scrollY);await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:new URL(name.replace('.png','-viewport.png'),artifacts).pathname,animations:'disabled'});await page.evaluate(top=>scrollTo({top,behavior:'instant'}),top);}}

test('390px消息→工单→服务→转移保持同一文档，并可真实提交回复与续费授权',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/console/notifications',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'站内消息',exact:true}).waitFor();await screenshot(page,'v376-notifications-mobile.png');
 await page.evaluate(()=>{window.__supportDocument='same';});await page.getByRole('link',{name:'查看进展',exact:true}).click();await page.getByRole('heading',{name:ticket.subject,exact:true}).waitFor();
 await page.getByLabel('补充回复',{exact:true}).fill('现在连接已恢复，我会继续观察。');await page.getByRole('button',{name:'发送回复',exact:true}).click();await page.getByText('现在连接已恢复，我会继续观察。',{exact:true}).waitFor();await screenshot(page,'v376-ticket-mobile.png');
 await page.getByRole('link',{name:new RegExp('关联服务：\\s*'+service.name)}).click();await page.getByRole('heading',{name:service.name,exact:true}).waitFor();await screenshot(page,'v376-service-mobile.png');
 await page.getByRole('button',{name:'开启自动续费',exact:true}).click();await page.getByLabel('当前登录密码',{exact:true}).fill('browser-fixture-only');await page.getByRole('button',{name:'确认保存',exact:true}).click();await page.getByText('已授权钱包续费',{exact:true}).waitFor();
 await page.getByRole('link',{name:'管理转移邀请',exact:true}).click();await page.getByRole('heading',{name:'服务转移',exact:true}).waitFor();await screenshot(page,'v376-transfers-mobile.png');
 assert.equal(await page.evaluate(()=>window.__supportDocument),'same');assert.equal(state.documents.length,1);assert.ok(state.calls.some(call=>call.method==='POST'&&call.path.endsWith('/auto-renew')));
}));

test('桌面支持工作台能打开真实部门成员、快捷回复与工单分配表单',async()=>withPage('admin',{width:1440,height:1000},async(page,state)=>{
 await page.goto(origin.origin+'/admin/support',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'支持工作台',exact:true}).waitFor();await screenshot(page,'v376-support-desktop.png');
 await page.getByRole('button',{name:'分配与合并',exact:true}).click();await page.getByRole('heading',{name:'工单安排',exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'部门与成员',exact:true}).click();await page.getByRole('button',{name:'编辑部门与成员',exact:true}).click();await page.getByRole('checkbox',{name:/小岚/}).waitFor();await screenshot(page,'v376-department-desktop.png');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'快捷回复',exact:true}).click();await page.getByText('请补充发生时间',{exact:true}).waitFor();assert.equal(state.documents.length,1);
}));

test('390px下载资料与管理员到期取消审批呈现真实状态',async()=>withPage('admin',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/console/downloads',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'轻量云使用手册',exact:true}).waitFor();await screenshot(page,'v376-downloads-mobile.png');
 await page.getByRole('button',{name:'更多导航',exact:true}).click();await page.getByRole('link',{name:'管理后台',exact:true}).click();await page.getByRole('link',{name:'取消审批',exact:true}).click();await page.getByRole('heading',{name:'服务生命周期',exact:true}).waitFor();await page.getByText('阶段性项目已结束，希望保留到本计费周期结束。',{exact:true}).waitFor();await screenshot(page,'v376-lifecycle-mobile.png');
 await page.getByRole('button',{name:'核对并批准',exact:true}).click();await page.getByLabel('审核说明',{exact:true}).fill('已核对客户意愿，保留到当前计费周期结束。');await page.getByLabel('当前管理员密码',{exact:true}).fill('browser-fixture-only');await page.getByRole('button',{name:'确认批准',exact:true}).click();await page.getByText('已批准，等待到期',{exact:true}).waitFor();assert.equal(state.documents.length,1);
}));


test('390px配置变更先核对差价与续费价格，确认后AJAX进入真实收银台',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+`/console/upgrades?serviceId=${ids.service}`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'更改方案与配置',exact:true}).waitFor();await page.getByRole('checkbox',{name:'自动备份',exact:true}).check();await page.getByRole('button',{name:'核对本次差价',exact:true}).click();await page.getByRole('heading',{name:'确认这次变更',exact:true}).waitFor();await screenshot(page,'v376-upgrade-mobile.png');await page.getByRole('checkbox',{name:'我已核对目标配置、差价和后续续费价格',exact:true}).check();await page.getByRole('button',{name:'确认，创建差价账单',exact:true}).click();await page.waitForURL(origin.origin+'/console/invoices/invoice-upgrade');await page.getByRole('heading',{level:1}).waitFor();assert.equal(state.documents.length,1);const call=state.calls.find(item=>item.path.endsWith('/upgrade-quote'));assert.equal(JSON.parse(call.body).configuration.backup,true,JSON.stringify(state.calls.filter(call=>call.path.includes('quote'))));
}));

test('390px试用服务可选择正式周期，转换报价展示新周期起算规则',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+`/console/upgrades?serviceId=${ids.service}`,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'更改方案与配置',exact:true}).waitFor();await page.getByRole('combobox',{name:'变更后的计费周期',exact:true}).click();await page.getByRole('option',{name:'年付 · ¥290.00',exact:true}).click();await page.getByRole('button',{name:'核对本次差价',exact:true}).click();await page.getByRole('heading',{name:'确认这次变更',exact:true}).waitFor();await page.getByText(/供应商确认变更后，新的计费周期开始/).waitFor();await screenshot(page,'v376-cycle-conversion-mobile.png');assert.equal(JSON.parse(state.calls.find(item=>item.path.endsWith('/upgrade-quote')).body).period,'year');assert.equal(state.documents.length,1);
},{sourcePeriod:'ontrial'}));


test('390px邮箱验证发码后确认本人密码，成功后AJAX刷新验证资料',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/console/verification',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'邮箱与手机验证',exact:true}).waitFor();await page.getByLabel('目标邮箱',{exact:true}).fill('verified@example.test');await page.getByRole('button',{name:'发送验证码',exact:true}).click();await page.getByLabel('6位验证码',{exact:true}).filter({visible:true}).fill('123456');await page.getByLabel('当前登录密码',{exact:true}).fill('browser-fixture-only');await screenshot(page,'v376-verification-mobile.png');await page.getByRole('button',{name:'验证并保存',exact:true}).click();await page.getByText('验证资料已保存，当前登录已更新，其它旧会话已失效。',{exact:true}).waitFor();assert.equal(state.documents.length,1);const confirmation=state.calls.find(item=>item.path==='/auth/verification/confirm');assert.equal(JSON.parse(confirmation.body).code,'123456');
}));


test('390px手机密码登录使用真实KIMA并以AJAX进入控制台',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/verify-login',{waitUntil:'networkidle'});await page.getByLabel('已验证手机号',{exact:true}).fill('+8613800000001');await page.getByLabel('登录密码',{exact:true}).fill('browser-fixture-only');await screenshot(page,'v376-phone-login-mobile.png');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(origin.origin+'/console');assert.equal(state.documents.length,1);
}));

test('390px验证注册在创建账号前核对验证码，以AJAX进入控制台',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/verify-register',{waitUntil:'networkidle'});await page.getByLabel('验证邮箱',{exact:true}).fill('new-owner@example.test');await page.getByRole('button',{name:'发送验证码',exact:true}).click();await page.getByLabel('注册验证码',{exact:true}).fill('123456');await page.getByLabel('怎么称呼你',{exact:true}).fill('山间来客');await page.getByLabel('登录密码',{exact:true}).fill('Registered-browser-password-2026');await page.getByLabel('再次填写密码',{exact:true}).fill('Registered-browser-password-2026');await screenshot(page,'v376-verified-register-mobile.png');await page.getByRole('button',{name:'验证并注册',exact:true}).click();await page.waitForURL(origin.origin+'/console');assert.equal(state.documents.length,1);assert.ok(state.calls.some(call=>call.path==='/auth/verify-register'&&JSON.parse(call.body).name==='山间来客'));
}));

test('390px找回页面提交验证码与新口令，恢复成功保留重新登录提示',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/recover',{waitUntil:'networkidle'});await page.getByLabel('验证邮箱',{exact:true}).fill('verified@example.test');await page.getByRole('button',{name:'发送验证码',exact:true}).click();await page.getByLabel('找回验证码',{exact:true}).fill('123456');await page.getByLabel('新登录密码',{exact:true}).fill('Recovered-browser-password-2026');await page.getByLabel('再次填写新密码',{exact:true}).fill('Recovered-browser-password-2026');await screenshot(page,'v376-recover-mobile.png');await page.getByRole('button',{name:'验证并重置密码',exact:true}).click();await page.getByText('密码已重置',{exact:true}).waitFor();assert.equal(state.documents.length,1);
}));

test('390px补充资料与消息偏好使用定义字段与实际发送设置',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/console/profile-fields',{waitUntil:'networkidle'});await page.getByLabel('用户域名',{exact:true}).fill('new.example.test');await page.getByRole('button',{name:'保存补充资料',exact:true}).click();await page.getByText('补充资料已保存。',{exact:true}).waitFor();await screenshot(page,'v376-custom-fields-mobile.png');assert.equal(fieldData.values.customer_domain,'new.example.test');
 await page.getByRole('link',{name:'消息接收偏好',exact:true}).filter({visible:true}).click();await page.getByRole('checkbox',{name:'接收营销邮件',exact:true}).check();await page.getByRole('checkbox',{name:'批量通知与关怀消息在这段时间后再发送',exact:true}).check();await page.getByLabel('开始时间',{exact:true}).fill('22:00');await page.getByLabel('结束时间',{exact:true}).fill('08:00');await screenshot(page,'v376-message-preferences-mobile.png');await page.getByRole('button',{name:'保存接收偏好',exact:true}).click();await page.getByText('偏好已保存，待发营销消息会按新设置处理。',{exact:true}).waitFor();assert.equal(preferences.quietStart,1320);assert.equal(state.documents.length,1);
}));

test('桌面消息工作台按机构未知结果进行凭据核对',async()=>withPage('admin',{width:1440,height:1000},async(page,state)=>{
 await page.goto(origin.origin+'/admin/messaging',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'消息与关怀',exact:true}).waitFor();await screenshot(page,'v376-messaging-desktop.png');await page.getByRole('button',{name:'发送任务',exact:true}).click();await page.getByRole('button',{name:'核对并处理',exact:true}).click();await page.getByLabel('核对结果与凭据编号',{exact:true}).fill('已向机构核对原请求，继续使用原幂等编号。');await page.getByLabel('当前管理员密码',{exact:true}).fill('browser-fixture-only');await page.getByRole('checkbox',{name:'我已核对机构记录，并确认这次处理',exact:true}).check();await screenshot(page,'v376-message-review-desktop.png');await page.getByRole('button',{name:'确认保存',exact:true}).click();await page.getByText('等待发送',{exact:true}).filter({visible:true}).waitFor();assert.equal(state.documents.length,1);
}));

test('键盘首个Tab显示跳正文入口，手机抽屉指针关闭后保持隐藏',async()=>withPage('customer',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/console/message-preferences',{waitUntil:'networkidle'});const skip=page.locator('.skip-link');assert.equal(await skip.evaluate(el=>getComputedStyle(el).opacity),'0');await page.keyboard.press('Tab');assert.equal(await skip.evaluate(el=>el.matches(':focus-visible')),true);assert.equal(await skip.evaluate(el=>getComputedStyle(el).opacity),'1');await page.keyboard.press('Enter');await page.waitForURL(origin.origin+'/console/message-preferences#main-content');await page.getByRole('button',{name:'更多导航',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await skip.evaluate(el=>getComputedStyle(el).opacity),'0');assert.equal(state.documents.length,1);
}));

test('390px批量发送先选择真实模板和客户，再以AJAX进入队列进度',async()=>withPage('admin',{width:390,height:844},async(page,state)=>{
 await page.goto(origin.origin+'/admin/messaging',{waitUntil:'networkidle'});await page.getByRole('button',{name:'批量发送',exact:true}).click();await page.getByRole('combobox',{name:'消息模板',exact:true}).click();await page.getByRole('option',{name:'客户进展提醒',exact:true}).click();await page.getByRole('checkbox',{name:new RegExp(user.name)}).check();await screenshot(page,'v376-message-batch-mobile.png');await page.getByRole('button',{name:'保存并进入发送队列',exact:true}).click();await page.waitForURL(origin.origin+'/admin/messaging?tab=jobs&batchId=message-batch-1');const submitted=state.calls.find(call=>call.path==='/admin/messaging/batches'&&call.method==='POST');assert.deepEqual(JSON.parse(submitted.body),{templateId:'message-template-1',userIds:[ids.owner]});assert.equal(state.documents.length,1);
}));
