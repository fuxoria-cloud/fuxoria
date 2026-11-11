/* 服务升降级：服务器按剩余计费时间核对整数差价，付款后排真实供应商任务。
 * 调用：GET /services/:id/upgrade-options；POST /services/:id/upgrade-quote {productId,configuration}；
 * POST /services/:id/upgrades {quoteId} + Idempotency-Key。降配不制造现金退款，后续续费按新合同价。
 */
import { Body, Controller, Get, Headers, Param, Post, Req, ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from './store.js';
import { record } from './audit.js';
import { notify } from './notification.js';
import Product from './product.js';
import { configurationSchema, quoteSelection, groupDiscount,periodSchema,periods, type Period } from './catalogue.js';
import { Roles, type SessionRequest } from '../utils/access.js';
import { read, uuid } from '../utils/input.js';
const actor = (request: SessionRequest) => request.actorId ?? request.user.id;
const fields = 'u.id,u.service_id AS "serviceId",u.target_product_id AS "productId",u.product_name AS "productName",u.target_configuration AS configuration,u.target_labels AS "configurationLabels",u.source_renew_cents::text AS "oldRenewCents",u.target_renew_cents::text AS "renewAmountCents",u.amount_cents::text AS "amountCents",u.currency,(SELECT decimals FROM currencies WHERE code=u.currency) AS "currencyDecimals",COALESCE(u.target_billing_period,u.billing_period) AS period,u.billing_period AS "sourcePeriod",u.cycle_change AS "cycleChange",u.remaining_ms::text AS "remainingMs",u.period_ms::text AS "periodMs",u.status,u.expires_at AS "expiresAt",u.created_at AS "createdAt",u.applied_at AS "appliedAt",u.order_id AS "orderId",i.id AS "invoiceId",j.id AS "jobId",j.state AS "jobState",j.last_error AS "jobError"';
const from = 'FROM service_upgrades u LEFT JOIN invoices i ON i.order_id=u.order_id LEFT JOIN jobs j ON j.id=u.job_id';
/** @returns 向上取整到分；全程BigInt，不把金额或比率转换成浮点。 */
export function upgradeCharge(oldPrice: bigint, newPrice: bigint, remaining: bigint, period: bigint) { return newPrice > oldPrice ? ((newPrice - oldPrice) * remaining + period - 1n) / period : 0n; }
export function cycleCharge(oldPrice:bigint,newPrice:bigint,remaining:bigint,period:bigint){const credit=oldPrice*remaining/period;return newPrice>credit?newPrice-credit:0n;}
/** @returns 当前资源和准确的毫秒计费快照，锁定后才能创建报价或变更单。 */
async function owned(connection: PoolClient, id: string, userId: string | null) {
    const service = (await connection.query(`SELECT s.*,p.provider,s.billing_currency AS currency,COALESCE(s.current_product_id,s.product_id) AS product,
 COALESCE(s.renew_amount_cents,p.price_cents)::text AS renewal,
 s.due_at::text AS due_text,
 floor(extract(epoch FROM s.due_at)*1000)::bigint::text AS end_ms,
 floor(extract(epoch FROM (s.due_at-make_interval(months=>s.billing_months,secs=>s.billing_seconds)))*1000)::bigint::text AS start_ms,
 floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms
 FROM services s JOIN products p ON p.id=COALESCE(s.current_product_id,s.product_id) WHERE s.id=$1 AND ($2::uuid IS NULL OR COALESCE(s.current_owner_id,s.user_id)=$2) FOR UPDATE OF s`, [id, userId])).rows[0];
    if (!service)
        throw new NotFoundException('服务不存在');
    return service;
}
/** @returns 人工供应商可由后台确认；外部供应商须有在线节点明确公布upgrade能力。 */
async function capable(connection: PoolClient, provider: string) { return provider === 'manual' || !!(await connection.query("SELECT 1 FROM agent_presence WHERE heartbeat_at>now()-interval '2 minutes' AND plugins @> $1::jsonb", [JSON.stringify([{ id: provider, actions: ['upgrade'] }])])).rowCount; }
/** @param connection 已锁住服务的业务事务。@param id 服务ID。未决变更不能被其它资源/计费动作跨越。 */
export async function ensureUpgradeIdle(connection: PoolClient, id: string) {
    if ((await connection.query("SELECT 1 FROM service_upgrades u JOIN orders o ON o.id=u.order_id WHERE u.service_id=$1 AND u.status IN ('unpaid','queued','review') AND o.status<>'cancelled'", [id])).rowCount)
        throw new ConflictException('请先处理此服务尚未结束的升降级账单或任务');
}
/** 变更不能越过未决续费、转移、取消或执行结果。 */
async function available(connection: PoolClient, service: Record<string, any>) {
    await ensureUpgradeIdle(connection, service.id);
    if (!['active', 'suspended'].includes(service.status) || service.termination_requested_at)
        throw new ConflictException('当前服务不能变更配置');
    if ((await connection.query("SELECT 1 FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review') UNION ALL SELECT 1 FROM renewals r JOIN invoices i ON i.order_id=r.order_id WHERE r.service_id=$1 AND i.status='unpaid' UNION ALL SELECT 1 FROM service_cancellations WHERE service_id=$1 AND status IN ('pending','approved','executing') UNION ALL SELECT 1 FROM service_transfers WHERE service_id=$1 AND status='pending' AND expires_at>now()", [service.id])).rowCount)
        throw new ConflictException('请先处理此服务已有的账单、变更、转移或取消申请');
    if (!await capable(connection, service.provider))
        throw new ConflictException('供应商当前没有可用的配置变更能力，请联系支持团队');
}
/** @returns 付款前后都校验同一份原资源快照，不能用旧报价覆盖续费或已转移的服务。 */
function matches(service: Record<string, any>, change: Record<string, any>) { return service.product === change.source_product_id && service.renewal === change.source_renew_cents && service.billing_period === change.billing_period && service.billing_months === change.billing_months && service.billing_seconds===change.billing_seconds && service.due_text === change.due_text && service.provider === change.provider && (service.current_owner_id ?? service.user_id) === change.user_id; }
/** @param allowReview 外部实收款须保存核对事实；余额扣款可回滚原事务。@returns 此账单是否属于升降级。 */
export async function fulfillUpgrade(connection: PoolClient, invoice: {
    id: string;
    order_id: string;
}, allowReview = true): Promise<boolean> {
    const found = (await connection.query('SELECT *,due_at::text AS due_text,expires_at>clock_timestamp() AS valid FROM service_upgrades WHERE order_id=$1', [invoice.order_id])).rows[0];
    if (!found)
        return false;
    const service = await owned(connection, found.service_id, null);
    const change = (await connection.query('SELECT *,due_at::text AS due_text,expires_at>clock_timestamp() AS valid FROM service_upgrades WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
    if (['queued', 'succeeded'].includes(change.status))
        return true;
    const configuration = (await connection.query('SELECT $1::jsonb=$2::jsonb AS equal', [service.configuration, change.source_configuration])).rows[0].equal;
    const targetValid = !!(await connection.query('SELECT 1 FROM products WHERE id=$1 AND provider=$2', [change.target_product_id, change.provider])).rowCount;
    const busy = (await connection.query("SELECT 1 FROM jobs WHERE service_id=$1 AND state IN ('queued','running','waiting','manual_review') UNION ALL SELECT 1 FROM service_cancellations WHERE service_id=$1 AND status IN ('pending','approved','executing') UNION ALL SELECT 1 FROM service_transfers WHERE service_id=$1 AND status='pending' AND expires_at>now()", [service.id])).rowCount;
    if (!targetValid || change.status !== 'unpaid' || !matches(service, change) || !configuration || !['active', 'suspended'].includes(service.status) || service.termination_requested_at || busy || !change.valid) {
        if (!allowReview)
            throw new ConflictException('服务或报价已变化，请重新核对升降级账单');
        await connection.query("INSERT INTO billing_reviews(invoice_id,service_id,reason) VALUES($1,$2,'upgrade_resource_changed') ON CONFLICT(invoice_id) DO NOTHING", [invoice.id, service.id]);
        await connection.query("UPDATE service_upgrades SET status='review' WHERE id=$1", [change.id]);
        await record(connection, 'billing', 'upgrade.review', invoice.id, { serviceId: service.id, upgradeId: change.id });
        return true;
    }
    const job = (await connection.query("INSERT INTO jobs(service_id,action,provider,payload,dedup_key) VALUES($1,'upgrade',$2,$3,$4) ON CONFLICT(dedup_key) DO UPDATE SET dedup_key=EXCLUDED.dedup_key RETURNING id", [service.id, change.provider, { invoiceId: invoice.id, upgradeId: change.id, productId: change.target_product_id, sourceProductId: change.source_product_id, configuration: change.target_configuration, configurationLabels: change.target_labels, billingPeriod: change.target_billing_period??change.billing_period,billingMonths:change.target_billing_months??change.billing_months,billingSeconds:change.target_billing_seconds??change.billing_seconds,cycleChange:change.cycle_change, renewAmountCents: change.target_renew_cents }, `upgrade:${change.id}`])).rows[0];
    await connection.query("UPDATE service_upgrades SET status='queued',job_id=$2 WHERE id=$1", [change.id, job.id]);
    await record(connection, change.user_id, 'upgrade.queued', service.id, { upgradeId: change.id, invoiceId: invoice.id, jobId: job.id });
    return true;
}
@Controller()
export default class Upgrade {
    @Get('services/:id/upgrade-options')
    async options(
    @Param('id')
    id: string, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        return transaction(async (connection) => { const service = await owned(connection, id, request.user.id); const allowed = await capable(connection, service.provider); const targets = (await new Product().list()).filter(product => product.provider === service.provider); return { serviceId: id, currentProductId: service.product, period: service.billing_period, configuration: service.configuration, targets: allowed ? targets : [], canUpgrade: allowed, reason: allowed ? null : '供应商当前没有在线配置变更能力，请联系支持团队。' }; });
    }
    @Get('service-upgrades')
    async list(
    @Req()
    request: SessionRequest) { return (await pool.query(`SELECT ${fields} ${from} WHERE u.user_id=$1 AND u.order_id IS NOT NULL ORDER BY u.created_at DESC LIMIT 200`, [request.user.id])).rows; }
    @Roles('admin')
    @Get('admin/service-upgrades')
    async all() { return (await pool.query(`SELECT ${fields},a.email,a.phone ${from} JOIN users a ON a.id=u.user_id WHERE u.order_id IS NOT NULL ORDER BY u.created_at DESC LIMIT 200`)).rows; }
    @Post('services/:id/upgrade-quote')
    async quote(
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const input = read(z.object({ productId: uuid, configuration: configurationSchema,period:periodSchema.optional() }).strict(), body);
        return transaction(async (connection) => {
            const service = await owned(connection, id, request.user.id);
            await available(connection, service);
            const target = (await connection.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [input.productId])).rows[0];
            if (!target)
                throw new NotFoundException('目标商品不存在');
            if(target.currency!==service.currency)throw new ConflictException('目标商品的币种与服务合同不同，请选择同币种方案');
            if (target.provider !== service.provider)
                throw new ConflictException('跨供应商变更需要实际迁移，请联系支持团队');
            const targetPeriod=input.period??service.billing_period as Period,cycleChange=targetPeriod!==service.billing_period;
            if(cycleChange&&(!['ontrial','hour','day'].includes(service.billing_period)||periods[targetPeriod].months===0))throw new ConflictException('试用、时付或日付服务可转换为产品支持的包月或包年周期');
            if(targetPeriod==='ontrial')throw new ConflictException('试用阶段请先转为正式付费周期，再更改配置');
            const priced = await quoteSelection(connection, target, { productId: target.id, quantity: 1, period: targetPeriod, configuration: input.configuration }, await groupDiscount(connection, request.user.id),{userId:request.user.id});
            const same = (await connection.query('SELECT $1::jsonb=$2::jsonb AS equal', [service.configuration, priced.configuration])).rows[0].equal;
            if (!cycleChange&&target.id === service.product && same && priced.renewAmountCents === service.renewal)
                throw new ConflictException('请选择需要改变的商品或配置');
            let remaining = 1n, duration = 1n;
            if (service.billing_months > 0 || service.billing_seconds>0) {
                if (!service.due_at || !cycleChange&&BigInt(service.end_ms) <= BigInt(service.now_ms))
                    throw new ConflictException('请先完成当前服务续费，再变更配置');
                duration = BigInt(service.end_ms) - BigInt(service.start_ms);
                remaining = BigInt(service.end_ms) - BigInt(service.now_ms);
                if(remaining<0n)remaining=0n;
                if (remaining > duration)
                    remaining = duration;
            }
            const amount = (cycleChange?cycleCharge:upgradeCharge)(BigInt(service.renewal), BigInt(priced.renewAmountCents), remaining, duration);
            const saved = (await connection.query('INSERT INTO service_upgrades(service_id,user_id,source_product_id,target_product_id,provider,source_configuration,target_configuration,target_labels,source_renew_cents,target_renew_cents,billing_period,billing_months,due_at,remaining_ms,period_ms,amount_cents,currency,product_name,billing_seconds,target_billing_period,target_billing_months,target_billing_seconds,cycle_change,pricing_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id', [id, request.user.id, service.product, target.id, service.provider, service.configuration, priced.configuration, priced.configurationLabels, service.renewal, priced.renewAmountCents, service.billing_period, service.billing_months, service.due_text, remaining.toString(), duration.toString(), amount.toString(), service.currency, target.name,service.billing_seconds,targetPeriod,priced.billingMonths,priced.billingSeconds,cycleChange,JSON.stringify(priced.pricingSource)])).rows[0];
            return (await connection.query(`SELECT ${fields} ${from} WHERE u.id=$1`, [saved.id])).rows[0];
        });
    }
    @Post('services/:id/upgrades')
    async create(
    @Param('id')
    id: string, 
    @Headers('idempotency-key')
    key: unknown, 
    @Body()
    body: unknown, 
    @Req()
    request: SessionRequest) {
        read(uuid, id);
        const input = read(z.object({ quoteId: uuid }).strict(), body), token = read(z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), key);
        return transaction(async (connection) => {
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${request.user.id}:${token}`]);
            const old = (await connection.query('SELECT o.id,o.request_hash,o.status,i.id AS "invoiceId",o.amount_cents::text AS "amountCents" FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.user_id=$1 AND o.idempotency_key=$2', [request.user.id, token])).rows[0];
            if (old) {
                if (old.request_hash !== `upgrade:${id}:${input.quoteId}`)
                    throw new ConflictException('这个提交标识已用于其它操作');
                const { request_hash, ...saved } = old;
                return saved;
            }
            const service = await owned(connection, id, request.user.id);
            await available(connection, service);
            const change = (await connection.query('SELECT *,due_at::text AS due_text,expires_at>clock_timestamp() AS valid FROM service_upgrades WHERE id=$1 AND user_id=$2 AND service_id=$3 FOR UPDATE', [input.quoteId, request.user.id, id])).rows[0];
            if (!change)
                throw new NotFoundException('报价不存在');
            if (change.status !== 'quoted' || !change.valid || !matches(service, change))
                throw new ConflictException('报价或原服务已变化，请重新核对');
            if (!(await connection.query('SELECT $1::jsonb=$2::jsonb AS equal', [service.configuration, change.source_configuration])).rows[0].equal)
                throw new ConflictException('服务配置已变化，请重新报价');
            if (!(await connection.query('SELECT id FROM products WHERE id=$1 AND provider=$2 AND active FOR SHARE', [change.target_product_id, change.provider])).rowCount)
                throw new ConflictException('目标商品已下架或供应商已变化，请重新报价'); // 目标商品锁阻止管理员在交付前切换实际供应商
            const paid = change.amount_cents === '0';
            const order = (await connection.query("INSERT INTO orders(user_id,product_id,idempotency_key,request_hash,amount_cents,currency,kind,items_explicit,status) VALUES($1,$2,$3,$4,$5,$6,'upgrade',true,$7) RETURNING id", [request.user.id, change.target_product_id, token, `upgrade:${id}:${change.id}`, change.amount_cents, change.currency, paid ? 'paid' : 'unpaid'])).rows[0];
            await connection.query('INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,billing_months,configuration,configuration_labels,billing_seconds,pricing_source) VALUES($1,$2,$3,1,$4,$5,$5,$6,$7,$8,$9,$10)', [order.id, change.target_product_id, change.product_name + ' · 服务变更差价', change.target_billing_period??change.billing_period, change.amount_cents, change.target_billing_months??change.billing_months, change.target_configuration, change.target_labels,change.target_billing_seconds??change.billing_seconds,change.pricing_source]);
            const invoice = (await connection.query('INSERT INTO invoices(order_id,user_id,amount_cents,currency,status,paid_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END) RETURNING id', [order.id, request.user.id, change.amount_cents, change.currency, paid ? 'paid' : 'unpaid', paid])).rows[0];
            await connection.query("UPDATE service_upgrades SET order_id=$2,status='unpaid' WHERE id=$1", [change.id, order.id]);
            if (paid)
                await fulfillUpgrade(connection, { id: invoice.id, order_id: order.id }, false);
            await record(connection, actor(request), 'upgrade.create', id, { upgradeId: change.id, orderId: order.id, invoiceId: invoice.id, amountCents: change.amount_cents, refundCents: '0' });
            return { id: order.id, invoiceId: invoice.id, status: paid ? 'paid' : 'unpaid', amountCents: change.amount_cents };
        });
    }
}
