-- 配置条件、链式选项、客户专属定价与时/日付合同。
-- 032只改变后续报价与明确确认的周期切换，既有成交行继续保留快照。
CREATE TABLE product_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid NOT NULL REFERENCES products,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),priority integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true,match text NOT NULL DEFAULT 'all' CHECK(match IN ('all','any')),
 conditions jsonb NOT NULL CHECK(jsonb_typeof(conditions)='array'),effects jsonb NOT NULL CHECK(jsonb_typeof(effects)='array'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_rules_product ON product_rules(product_id,priority,id);
CREATE TABLE product_custom_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid NOT NULL REFERENCES products,user_id uuid NOT NULL REFERENCES users,
 period text NOT NULL,currency text NOT NULL DEFAULT 'CNY' CHECK(currency~'^[A-Z]{3}$'),configuration jsonb,
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 0 AND 999999999999),setup_cents bigint NOT NULL DEFAULT 0 CHECK(setup_cents BETWEEN 0 AND 999999999999),
 active boolean NOT NULL DEFAULT true,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_custom_price_target ON product_custom_prices(product_id,user_id,period,currency,COALESCE(configuration::text,''));
ALTER TABLE order_items ADD COLUMN pricing_source jsonb NOT NULL DEFAULT '{}';
ALTER TABLE services ADD COLUMN pricing_source jsonb NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN trial_days integer NOT NULL DEFAULT 7 CHECK(trial_days BETWEEN 1 AND 365);
ALTER TABLE services ADD COLUMN billing_seconds integer NOT NULL DEFAULT 0 CHECK(billing_seconds BETWEEN 0 AND 31536000);
ALTER TABLE order_items ADD COLUMN billing_seconds integer NOT NULL DEFAULT 0 CHECK(billing_seconds BETWEEN 0 AND 31536000);
ALTER TABLE renewals ADD COLUMN period_seconds integer NOT NULL DEFAULT 0 CHECK(period_seconds BETWEEN 0 AND 31536000);
ALTER TABLE product_periods DROP CONSTRAINT product_periods_period_check;
ALTER TABLE product_periods ADD CONSTRAINT product_periods_period_check CHECK(period IN ('hour','day','ontrial','month','quarter','halfyear','year','biennium','triennium','onetime'));
ALTER TABLE order_items DROP CONSTRAINT order_items_period_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_period_check CHECK(period IN ('hour','day','ontrial','month','quarter','halfyear','year','biennium','triennium','onetime'));
ALTER TABLE services DROP CONSTRAINT services_billing_period_check;
ALTER TABLE services ADD CONSTRAINT services_billing_period_check CHECK(billing_period IN ('hour','day','ontrial','month','quarter','halfyear','year','biennium','triennium','onetime'));
ALTER TABLE services DROP CONSTRAINT service_period_months;
ALTER TABLE services ADD CONSTRAINT service_period_months CHECK(billing_months=CASE billing_period WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'halfyear' THEN 6 WHEN 'year' THEN 12 WHEN 'biennium' THEN 24 WHEN 'triennium' THEN 36 ELSE 0 END);
ALTER TABLE services ADD CONSTRAINT service_period_seconds CHECK(billing_seconds=CASE billing_period WHEN 'hour' THEN 3600 WHEN 'day' THEN 86400 WHEN 'ontrial' THEN billing_seconds ELSE 0 END AND (billing_period<>'ontrial' OR billing_seconds>=86400));
ALTER TABLE order_items ADD CONSTRAINT item_period_seconds CHECK(billing_seconds=CASE period WHEN 'hour' THEN 3600 WHEN 'day' THEN 86400 WHEN 'ontrial' THEN billing_seconds ELSE 0 END AND (period<>'ontrial' OR billing_seconds>=86400));
ALTER TABLE order_items ADD CONSTRAINT trial_zero_price CHECK(period<>'ontrial' OR quantity=1 AND unit_price_cents=0);
ALTER TABLE renewals DROP CONSTRAINT renewals_period_months_check;
ALTER TABLE renewals ADD CONSTRAINT renewals_period_months_check CHECK(period_months IN (0,1,3,6,12,24,36) AND (period_months>0 AND period_seconds=0 OR period_months=0 AND period_seconds IN(3600,86400)));
CREATE TABLE trial_claims (
 user_id uuid NOT NULL REFERENCES users,product_id uuid NOT NULL REFERENCES products,
 order_id uuid NOT NULL REFERENCES orders,order_item_id uuid NOT NULL UNIQUE REFERENCES order_items,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,product_id)
);
CREATE TRIGGER immutable_trial_claims BEFORE UPDATE OR DELETE ON trial_claims FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION trial_order_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.period='ontrial' AND NOT EXISTS(SELECT 1 FROM trial_claims c JOIN orders o ON o.id=c.order_id WHERE c.order_item_id=NEW.id AND c.product_id=NEW.product_id AND c.order_id=NEW.order_id AND c.user_id=o.user_id) THEN RAISE EXCEPTION '试用成交必须同事务登记主账号永久试用资格'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trial_order_complete AFTER INSERT ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trial_order_complete();

ALTER TABLE service_upgrades ADD COLUMN billing_seconds integer NOT NULL DEFAULT 0 CHECK(billing_seconds BETWEEN 0 AND 31536000);
ALTER TABLE service_upgrades ADD COLUMN target_billing_period text;
ALTER TABLE service_upgrades ADD COLUMN target_billing_months integer;
ALTER TABLE service_upgrades ADD COLUMN target_billing_seconds integer;
ALTER TABLE service_upgrades ADD COLUMN cycle_change boolean NOT NULL DEFAULT false;
ALTER TABLE service_upgrades ADD COLUMN pricing_source jsonb NOT NULL DEFAULT '{}';
ALTER TABLE service_upgrades DROP CONSTRAINT service_upgrades_remaining_ms_check;
ALTER TABLE service_upgrades ADD CONSTRAINT service_upgrades_remaining_ms_check CHECK(remaining_ms>=0);
ALTER TABLE service_upgrades ADD CONSTRAINT service_upgrades_period_positive CHECK(period_ms>0);
ALTER TABLE service_upgrades DROP CONSTRAINT service_upgrades_check;
ALTER TABLE service_upgrades ADD CONSTRAINT service_upgrade_amount CHECK(amount_cents=CASE WHEN cycle_change THEN greatest(target_renew_cents-floor(source_renew_cents::numeric*remaining_ms/period_ms),0) ELSE ceil(greatest(target_renew_cents-source_renew_cents,0)::numeric*remaining_ms/period_ms) END);

CREATE OR REPLACE FUNCTION apply_service_upgrade(target_job uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE change service_upgrades%ROWTYPE; resource services%ROWTYPE; task jobs%ROWTYPE; target_service uuid;
BEGIN
 SELECT service_id INTO target_service FROM service_upgrades WHERE job_id=target_job;
 IF target_service IS NULL THEN RAISE EXCEPTION '升降级任务没有对应报价'; END IF;
 SELECT * INTO STRICT resource FROM services WHERE id=target_service FOR UPDATE;
 SELECT * INTO STRICT change FROM service_upgrades WHERE job_id=target_job FOR UPDATE;
 SELECT * INTO STRICT task FROM jobs WHERE id=target_job;
 IF task.action<>'upgrade' OR task.state<>'succeeded' OR task.service_id<>change.service_id OR task.provider<>change.provider
  OR NOT EXISTS(SELECT 1 FROM products WHERE id=change.target_product_id AND provider=change.provider)
  OR NOT EXISTS(SELECT 1 FROM orders o JOIN invoices i ON i.order_id=o.id WHERE o.id=change.order_id AND o.status='paid' AND i.status='paid' AND i.amount_cents=change.amount_cents AND i.currency=change.currency)
  THEN RAISE EXCEPTION '升降级尚无实际付款和执行成功事实'; END IF;
 IF change.status='succeeded' THEN RETURN change.service_id; END IF;
 IF change.status<>'queued' OR resource.status NOT IN ('active','suspended') OR resource.termination_requested_at IS NOT NULL
  OR COALESCE(resource.current_owner_id,resource.user_id)<>change.user_id
  OR COALESCE(resource.current_product_id,resource.product_id)<>change.source_product_id
  OR resource.configuration<>change.source_configuration
  OR resource.billing_period<>change.billing_period OR resource.billing_months<>change.billing_months OR resource.billing_seconds<>change.billing_seconds
  OR resource.due_at IS DISTINCT FROM change.due_at
  OR COALESCE(resource.renew_amount_cents,(SELECT price_cents FROM products WHERE id=change.source_product_id))<>change.source_renew_cents
  OR (COALESCE(task.result->>'externalId','')<>'' AND task.result->>'externalId' IS DISTINCT FROM resource.external_id)
  THEN RAISE EXCEPTION '升降级原资源事实已变化，须人工核对真实结果'; END IF;
 UPDATE services SET current_product_id=change.target_product_id,configuration=change.target_configuration,
  configuration_labels=change.target_labels,renew_amount_cents=change.target_renew_cents,pricing_source=change.pricing_source,
  billing_period=COALESCE(change.target_billing_period,change.billing_period),
  billing_months=COALESCE(change.target_billing_months,change.billing_months),
  billing_seconds=COALESCE(change.target_billing_seconds,change.billing_seconds),
  due_at=CASE WHEN change.cycle_change THEN now()+make_interval(months=>change.target_billing_months,secs=>change.target_billing_seconds) ELSE due_at END
  WHERE id=change.service_id;
 IF change.cycle_change AND resource.status='suspended' AND resource.suspend_type='overdue' THEN
  INSERT INTO jobs(service_id,action,provider,payload,dedup_key)
   SELECT change.service_id,'resume',change.provider,jsonb_build_object('reason','cycle_conversion_paid','upgradeId',change.id),'resume:cycle:'||change.id::text
   WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE service_id=change.service_id AND action='resume' AND state IN('queued','running','waiting','manual_review')) ON CONFLICT(dedup_key) DO NOTHING;
 END IF;
 UPDATE service_upgrades SET status='succeeded',applied_at=now() WHERE id=change.id;
 INSERT INTO notifications(user_id,title,message,link) VALUES(change.user_id,'服务配置已更新','供应商已确认本次变更，可以查看配置、周期和续费价格。','/console/services/'||change.service_id::text);
 RETURN change.service_id;
END;
$$;
