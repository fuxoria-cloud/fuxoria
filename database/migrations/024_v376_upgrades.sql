-- 服务升降级：原订单关联保持不可变，当前商品和配置仅在真实任务完成后更新。
ALTER TABLE services ADD COLUMN current_product_id uuid REFERENCES products;
ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK(kind IN ('new','renew','recharge','upgrade'));
ALTER TABLE jobs DROP CONSTRAINT jobs_action_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_action_check CHECK(action IN ('provision','suspend','resume','terminate','renew','upgrade'));
CREATE TABLE service_upgrades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_id uuid NOT NULL REFERENCES services,user_id uuid NOT NULL REFERENCES users,
 source_product_id uuid NOT NULL REFERENCES products,target_product_id uuid NOT NULL REFERENCES products,provider text NOT NULL,
 source_configuration jsonb NOT NULL,target_configuration jsonb NOT NULL,target_labels jsonb NOT NULL,
 source_renew_cents bigint NOT NULL CHECK(source_renew_cents>=0),target_renew_cents bigint NOT NULL CHECK(target_renew_cents>=0),
 billing_period text NOT NULL,billing_months integer NOT NULL CHECK(billing_months IN (0,1,3,6,12,24,36)),
 due_at timestamptz,remaining_ms bigint NOT NULL CHECK(remaining_ms>0),period_ms bigint NOT NULL CHECK(period_ms>=remaining_ms),
 amount_cents bigint NOT NULL CHECK(amount_cents>=0),currency text NOT NULL CHECK(currency='CNY'),
 product_name text NOT NULL,order_id uuid UNIQUE REFERENCES orders,job_id uuid UNIQUE REFERENCES jobs,
 status text NOT NULL DEFAULT 'quoted' CHECK(status IN ('quoted','unpaid','queued','succeeded','review','cancelled')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 CHECK(amount_cents=ceil(greatest(target_renew_cents-source_renew_cents,0)::numeric*remaining_ms/period_ms))
);
CREATE INDEX upgrades_customer ON service_upgrades(user_id,created_at DESC);
CREATE INDEX upgrades_service ON service_upgrades(service_id,status);
CREATE FUNCTION upgrade_quote_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','order_id','job_id','applied_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','order_id','job_id','applied_at'])
  OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id)
  OR (OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id) THEN RAISE EXCEPTION '升降级报价快照不能修改'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER upgrade_quote_fixed BEFORE UPDATE ON service_upgrades FOR EACH ROW EXECUTE FUNCTION upgrade_quote_fixed();
CREATE TRIGGER upgrade_quote_retained BEFORE DELETE ON service_upgrades FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- Go同步/回调与后台人工确认共用同一交付规则，调用者须先将真实任务结果写成succeeded。
CREATE FUNCTION apply_service_upgrade(target_job uuid) RETURNS uuid LANGUAGE plpgsql AS $$
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
  OR resource.billing_period<>change.billing_period OR resource.billing_months<>change.billing_months
  OR resource.due_at IS DISTINCT FROM change.due_at
  OR COALESCE(resource.renew_amount_cents,(SELECT price_cents FROM products WHERE id=change.source_product_id))<>change.source_renew_cents
  OR (COALESCE(task.result->>'externalId','')<>'' AND task.result->>'externalId' IS DISTINCT FROM resource.external_id)
  THEN RAISE EXCEPTION '升降级原资源事实已变化，须人工核对真实结果'; END IF;
 UPDATE services SET current_product_id=change.target_product_id,configuration=change.target_configuration,
  configuration_labels=change.target_labels,renew_amount_cents=change.target_renew_cents WHERE id=change.service_id;
 UPDATE service_upgrades SET status='succeeded',applied_at=now() WHERE id=change.id;
 INSERT INTO notifications(user_id,title,message,link) VALUES(change.user_id,'服务配置已更新','供应商已确认本次服务变更，可以查看新的配置和续费价格。','/console/services/'||change.service_id::text);
 RETURN change.service_id;
END;
$$;
