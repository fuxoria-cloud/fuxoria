-- 币种与有理数汇率；账务余额、占额与额度始终按币种分别计算。
CREATE TABLE currencies (
 code text PRIMARY KEY CHECK(code~'^[A-Z]{3}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 symbol text NOT NULL CHECK(length(symbol) BETWEEN 1 AND 12),decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 8),
 rate_numerator bigint NOT NULL CHECK(rate_numerator BETWEEN 1 AND 999999999999),rate_denominator bigint NOT NULL CHECK(rate_denominator BETWEEN 1 AND 999999999999),
 active boolean NOT NULL DEFAULT true,is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(code<>'CNY' OR rate_numerator=1 AND rate_denominator=1 AND decimals=2)
);
CREATE UNIQUE INDEX currencies_default ON currencies(is_default) WHERE is_default;
INSERT INTO currencies(code,name,symbol,decimals,rate_numerator,rate_denominator,is_default) VALUES('CNY','人民币','¥',2,1,1,true);
CREATE TABLE currency_rates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),currency text NOT NULL REFERENCES currencies(code),
 numerator bigint NOT NULL CHECK(numerator>0),denominator bigint NOT NULL CHECK(denominator>0),
 actor uuid REFERENCES users,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_currency_rates BEFORE UPDATE OR DELETE ON currency_rates FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION currency_definition_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN IF OLD.code='CNY' OR OLD.is_default THEN RAISE EXCEPTION '锚币与默认币种不能删除';END IF;RETURN OLD;END IF;
 IF ROW(NEW.code,NEW.decimals,NEW.created_at) IS DISTINCT FROM ROW(OLD.code,OLD.decimals,OLD.created_at) THEN RAISE EXCEPTION '币种代码与最小单位定义不能修改';END IF;
 IF NEW.is_default AND NOT NEW.active THEN RAISE EXCEPTION '默认币种必须启用';END IF;RETURN NEW;
END $$;
CREATE TRIGGER currency_definition_fixed BEFORE UPDATE OR DELETE ON currencies FOR EACH ROW EXECUTE FUNCTION currency_definition_fixed();
ALTER TABLE products DROP CONSTRAINT products_currency_check;
ALTER TABLE refunds DROP CONSTRAINT refunds_currency_check;
ALTER TABLE wallet_payments DROP CONSTRAINT wallet_payments_currency_check;
ALTER TABLE opening_balances DROP CONSTRAINT opening_balances_currency_check;
ALTER TABLE credit_payments DROP CONSTRAINT credit_payments_currency_check;
ALTER TABLE combined_invoices DROP CONSTRAINT combined_invoices_currency_check;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['products','orders','invoices','payment_receipts','ledger_transactions','refunds','wallet_payments','opening_balances','credit_payments','combined_invoices','product_custom_prices','service_upgrades','tax_requests'] LOOP
 EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(currency) REFERENCES currencies(code)',target,target||'_currency_fk');
 END LOOP;
END $$;
ALTER TABLE services ADD COLUMN billing_currency text;
UPDATE services s SET renew_amount_cents=p.price_cents FROM products p WHERE p.id=COALESCE(s.current_product_id,s.product_id) AND s.renew_amount_cents IS NULL;
UPDATE services s SET billing_currency=o.currency FROM orders o WHERE o.id=s.order_id;
ALTER TABLE services ALTER COLUMN billing_currency SET DEFAULT 'CNY';
ALTER TABLE services ALTER COLUMN billing_currency SET NOT NULL;
ALTER TABLE services ADD CONSTRAINT service_currency_fk FOREIGN KEY(billing_currency) REFERENCES currencies(code);
CREATE FUNCTION service_currency_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.billing_currency<>OLD.billing_currency THEN RAISE EXCEPTION '服务合同币种不能随商品换价修改';END IF;RETURN NEW;END $$;
CREATE TRIGGER service_currency_fixed BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION service_currency_fixed();
ALTER TABLE promotions ADD COLUMN currency text NOT NULL DEFAULT 'CNY' REFERENCES currencies(code);
ALTER TABLE credit_accounts ADD COLUMN currency text NOT NULL DEFAULT 'CNY' REFERENCES currencies(code);
ALTER TABLE credit_accounts DROP CONSTRAINT credit_accounts_pkey;
ALTER TABLE credit_accounts ADD PRIMARY KEY(user_id,currency);
ALTER TABLE credit_repayments ADD COLUMN currency text NOT NULL DEFAULT 'CNY' REFERENCES currencies(code);
-- 以下守卫以会计事务币种为分桶依据，账户名称保持旧版兼容。

CREATE OR REPLACE FUNCTION wallet_nonnegative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account LIKE 'wallet:%' AND NEW.amount_cents>0 THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account,0));END IF;
 IF NEW.account LIKE 'wallet:%' AND NEW.amount_cents>0 AND (SELECT COALESCE(sum(amount_cents),0)>0 FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account=NEW.account AND t.currency=(SELECT currency FROM ledger_transactions WHERE id=NEW.transaction_id)) THEN RAISE EXCEPTION '账户余额不能透支'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION recharge_refund_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_kind text; available numeric; held numeric;
BEGIN
 PERFORM id FROM payment_receipts WHERE id=NEW.receipt_id FOR UPDATE;
 SELECT o.kind INTO STRICT bill_kind FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id WHERE p.id=NEW.receipt_id;
 IF bill_kind<>'recharge' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wallet:'||NEW.user_id::text,0));
 SELECT -COALESCE(sum(amount_cents),0) INTO available FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='wallet:'||NEW.user_id::text AND t.currency=NEW.currency;
 SELECT COALESCE(sum(r.amount_cents),0) INTO held FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id
 JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id
 WHERE r.user_id=NEW.user_id AND r.currency=NEW.currency AND o.kind='recharge' AND r.status NOT IN ('rejected','failed','succeeded');
 IF available-held<NEW.amount_cents THEN RAISE EXCEPTION '充值余额已使用或已预留退款，不能重复支出'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION credit_limit_respected() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('credit:'||NEW.user_id::text,0));
 IF NEW.limit_cents<(SELECT COALESCE(sum(amount_cents),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='receivable:'||NEW.user_id::text AND t.currency=NEW.currency) THEN RAISE EXCEPTION '信用额度不能低于实际应收款'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION credit_payment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; payment credit_payments%ROWTYPE; bill invoices%ROWTYPE; ledger_id uuid; entries bigint; debt bigint; income bigint; source_count bigint; used numeric; available bigint;
BEGIN
 IF TG_TABLE_NAME='credit_payments' THEN target_id:=NEW.id; ELSE target_id:=NEW.credit_payment_id; END IF;
 IF target_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT payment FROM credit_payments WHERE id=target_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit:'||payment.user_id::text,0));
 SELECT * INTO STRICT bill FROM invoices WHERE id=payment.invoice_id;
 SELECT id INTO ledger_id FROM ledger_transactions WHERE credit_payment_id=target_id AND currency=payment.currency;
 SELECT count(*),count(*) FILTER(WHERE account='receivable:'||payment.user_id::text AND amount_cents=payment.amount_cents),
 count(*) FILTER(WHERE account='income:'||payment.user_id::text AND amount_cents=-payment.amount_cents)
 INTO entries,debt,income FROM ledger_entries WHERE transaction_id=ledger_id;
 IF ledger_id IS NULL OR bill.status<>'paid' OR bill.user_id<>payment.user_id OR bill.amount_cents<>payment.amount_cents OR bill.currency<>payment.currency
 OR entries<>2 OR debt<>1 OR income<>1 THEN RAISE EXCEPTION '信用付款必须有真实应收款和收入分录'; END IF;
 SELECT (SELECT count(*) FROM payment_receipts WHERE invoice_id=bill.id)+(SELECT count(*) FROM wallet_payments WHERE invoice_id=bill.id) INTO source_count;
 IF source_count<>0 THEN RAISE EXCEPTION '信用、现金和余额不能重复结清同一账单'; END IF;
 SELECT COALESCE(sum(amount_cents),0) INTO used FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='receivable:'||payment.user_id::text AND t.currency=payment.currency;
 SELECT limit_cents INTO available FROM credit_accounts WHERE user_id=payment.user_id AND currency=payment.currency;
 IF available IS NULL OR used<0 OR used>available THEN RAISE EXCEPTION '信用应收款不能为负或超过授权额度'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION credit_repayment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; expected bigint; actual numeric; bill_kind text; owner_id uuid; repayment_currency text;
BEGIN
 IF TG_TABLE_NAME='credit_repayments' THEN target_id:=NEW.order_id; ELSE target_id:=NEW.order_id; END IF;
 SELECT amount_cents,user_id,currency INTO STRICT expected,owner_id,repayment_currency FROM credit_repayments WHERE order_id=target_id;
 SELECT kind INTO bill_kind FROM orders WHERE id=target_id AND user_id=owner_id AND amount_cents=expected AND currency=repayment_currency;
 SELECT COALESCE(sum(i.amount_cents),0) INTO actual FROM credit_repayment_items i JOIN credit_payments p ON p.id=i.payment_id AND p.user_id=owner_id AND p.currency=repayment_currency WHERE i.order_id=target_id;
 IF bill_kind IS DISTINCT FROM 'credit_repayment' OR actual<>expected THEN RAISE EXCEPTION '还款账单必须等于同一客户的真实信用占用'; END IF;
 IF EXISTS(SELECT 1 FROM credit_payments p WHERE p.id IN (SELECT payment_id FROM credit_repayment_items WHERE order_id=target_id)
  AND p.amount_cents<(SELECT COALESCE(sum(i.amount_cents),0) FROM credit_repayment_items i JOIN orders o ON o.id=i.order_id WHERE i.payment_id=p.id AND o.status<>'cancelled')) THEN RAISE EXCEPTION '同一信用欠款不能重复开还款单'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION affiliate_cny_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (SELECT currency FROM invoices WHERE id=NEW.invoice_id)<>'CNY' THEN RAISE EXCEPTION '联盟推荐佣金仅支持CNY实收来源';END IF;RETURN NEW;END $$;
CREATE TRIGGER affiliate_cny_source BEFORE INSERT ON affiliate_commissions FOR EACH ROW EXECUTE FUNCTION affiliate_cny_source();

CREATE OR REPLACE FUNCTION affiliate_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance numeric; reserved numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('affiliate:'||NEW.user_id::text,0));
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.user_id,NEW.amount_cents,NEW.currency,NEW.payee,NEW.idempotency_key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.user_id,OLD.amount_cents,OLD.currency,OLD.payee,OLD.idempotency_key,OLD.request_hash,OLD.created_at) OR OLD.status<>'pending' THEN RAISE EXCEPTION '提现原始事实及已处理结果不能覆盖'; END IF;
  RETURN NEW;
 END IF;
 SELECT -COALESCE(sum(amount_cents),0) INTO balance FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='affiliate:'||NEW.user_id::text AND t.currency='CNY';
 SELECT COALESCE(sum(amount_cents),0) INTO reserved FROM affiliate_withdrawals WHERE user_id=NEW.user_id AND status='pending';
 IF NEW.amount_cents>balance-reserved THEN RAISE EXCEPTION '可用佣金不足，不能重复预留或透支'; END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION order_invoice_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=NEW.order_id AND o.user_id=NEW.user_id AND o.currency=NEW.currency AND o.amount_cents=NEW.amount_cents) THEN RAISE EXCEPTION '账单必须与本人订单的币种金额一致';END IF;RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER order_invoice_currency AFTER INSERT OR UPDATE ON invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_invoice_currency();

ALTER TABLE currencies ADD CONSTRAINT currency_default_active CHECK(NOT is_default OR active);

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
  OR resource.billing_currency<>change.currency OR resource.billing_period<>change.billing_period OR resource.billing_months<>change.billing_months OR resource.billing_seconds<>change.billing_seconds
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

CREATE FUNCTION promotion_currency_respected() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS(SELECT 1 FROM promotions p JOIN orders o ON o.id=NEW.order_id WHERE p.id=NEW.promotion_id AND (p.kind IN('fixed','override') OR p.minimum_cents>0) AND p.currency<>o.currency) THEN RAISE EXCEPTION '金额优惠必须与订单使用同一币种';END IF;RETURN NEW;END $$;
CREATE TRIGGER promotion_currency_respected BEFORE INSERT ON promotion_uses FOR EACH ROW EXECUTE FUNCTION promotion_currency_respected();

CREATE FUNCTION financial_currency_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.currency<>OLD.currency THEN RAISE EXCEPTION '已创建订单与账单的币种不能改写';END IF;RETURN NEW;END $$;
CREATE TRIGGER financial_currency_fixed BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION financial_currency_fixed();
CREATE TRIGGER financial_currency_fixed BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION financial_currency_fixed();

CREATE FUNCTION service_contract_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE contract_currency text;
BEGIN
 SELECT currency INTO STRICT contract_currency FROM orders WHERE id=NEW.order_id;
 IF NEW.billing_currency<>contract_currency THEN RAISE EXCEPTION '服务合同币种必须等于原购买订单币种';END IF;
 IF NEW.renew_amount_cents IS NULL THEN SELECT price_cents INTO NEW.renew_amount_cents FROM products WHERE id=COALESCE(NEW.current_product_id,NEW.product_id);END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_contract_defaults BEFORE INSERT ON services FOR EACH ROW EXECUTE FUNCTION service_contract_defaults();
