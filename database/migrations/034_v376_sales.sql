-- 员工销售分工、组阶梯和实收提成：保留客户归属历史与每次实际结算快照。
CREATE INDEX ledger_reporting_period ON ledger_transactions(created_at,currency,id);
CREATE INDEX jobs_reporting_period ON jobs(created_at,state);
CREATE INDEX users_reporting_period ON users(role,created_at,id);
CREATE TABLE sales_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 100),
 product_ids uuid[] NOT NULL DEFAULT '{}',new_bps integer NOT NULL DEFAULT 0 CHECK(new_bps BETWEEN 0 AND 10000),
 renew_bps integer NOT NULL DEFAULT 0 CHECK(renew_bps BETWEEN 0 AND 10000),upgrade_bps integer NOT NULL DEFAULT 0 CHECK(upgrade_bps BETWEEN 0 AND 10000),
 hold_days integer NOT NULL DEFAULT 30 CHECK(hold_days BETWEEN 0 AND 365),active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_tiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),group_id uuid NOT NULL REFERENCES sales_groups,
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),category text NOT NULL CHECK(category IN('new','renew','upgrade')),
 threshold_cents bigint NOT NULL CHECK(threshold_cents BETWEEN 0 AND 999999999999),rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 active boolean NOT NULL DEFAULT true,UNIQUE(group_id,currency,category,threshold_cents)
);
CREATE TABLE sales_people (
 user_id uuid PRIMARY KEY REFERENCES users,group_id uuid NOT NULL REFERENCES sales_groups,
 enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES users,staff_id uuid NOT NULL REFERENCES sales_people(user_id),
 assigned_by uuid NOT NULL REFERENCES users,starts_at timestamptz NOT NULL DEFAULT now(),ends_at timestamptz,
 CHECK(customer_id<>staff_id),CHECK(ends_at IS NULL OR ends_at>=starts_at)
);
CREATE UNIQUE INDEX sales_customer_current ON sales_assignments(customer_id) WHERE ends_at IS NULL;
CREATE INDEX sales_staff_customer ON sales_assignments(staff_id,starts_at);
CREATE TABLE sales_commissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_id uuid NOT NULL REFERENCES sales_people(user_id),assignment_id uuid NOT NULL REFERENCES sales_assignments,
 group_id uuid NOT NULL REFERENCES sales_groups,invoice_id uuid NOT NULL REFERENCES invoices,line_id uuid NOT NULL UNIQUE REFERENCES order_items,
 product_name text NOT NULL,currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),category text NOT NULL CHECK(category IN('new','renew','upgrade')),
 month_key text NOT NULL CHECK(month_key~'^[0-9]{4}-[0-9]{2}$'),basis_cents bigint NOT NULL CHECK(basis_cents>=0),before_cents bigint NOT NULL CHECK(before_cents>=0),
 rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),hold_days integer NOT NULL CHECK(hold_days BETWEEN 0 AND 365),
 paid_at timestamptz NOT NULL,release_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','released','void')),
 net_basis_cents bigint,released_cents bigint,recognized_refund_ids uuid[] NOT NULL DEFAULT '{}',released_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='pending')=(released_at IS NULL)),CHECK(status='pending' OR (net_basis_cents IS NOT NULL AND net_basis_cents>=0 AND released_cents IS NOT NULL AND released_cents>=0)),CHECK(status<>'released' OR released_cents>0),CHECK(status<>'void' OR released_cents=0)
);
CREATE INDEX sales_commission_staff ON sales_commissions(staff_id,currency,month_key);
CREATE INDEX sales_commission_due ON sales_commissions(release_at,staff_id) WHERE status='pending';
CREATE TABLE sales_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 commission_id uuid NOT NULL REFERENCES sales_commissions,refund_id uuid NOT NULL REFERENCES refunds,
 amount_cents bigint NOT NULL CHECK(amount_cents>=0),basis_before_cents bigint NOT NULL CHECK(basis_before_cents>=0),basis_after_cents bigint NOT NULL CHECK(basis_after_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(commission_id,refund_id)
);
CREATE TABLE sales_withdrawals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_id uuid NOT NULL REFERENCES sales_people(user_id),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),payee jsonb NOT NULL,
 idempotency_key text NOT NULL,request_hash text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','rejected','cancelled')),
 reason text,handled_by uuid REFERENCES users,handled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(staff_id,idempotency_key)
);
CREATE TABLE sales_payouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),withdrawal_id uuid NOT NULL UNIQUE REFERENCES sales_withdrawals,
 staff_id uuid NOT NULL REFERENCES sales_people(user_id),amount_cents bigint NOT NULL CHECK(amount_cents>0),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 channel text NOT NULL CHECK(channel IN('bank','alipay','wechat')),reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200),
 evidence_url text,paid_at timestamptz NOT NULL,recorded_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(channel,reference)
);
ALTER TABLE ledger_transactions ADD COLUMN sales_commission_id uuid UNIQUE REFERENCES sales_commissions;
ALTER TABLE ledger_transactions ADD COLUMN sales_reversal_id uuid UNIQUE REFERENCES sales_reversals;
ALTER TABLE ledger_transactions ADD COLUMN sales_payout_id uuid UNIQUE REFERENCES sales_payouts;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_one_source;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id,opening_balance_id,wallet_payment_id,affiliate_commission_id,affiliate_reversal_id,affiliate_transfer_id,affiliate_payout_id,credit_payment_id,sales_commission_id,sales_reversal_id,sales_payout_id)=1);
CREATE FUNCTION sales_line_refunded(target uuid,refund_ids uuid[] DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT LEAST(c.basis_cents,GREATEST(COALESCE(sum(f.amount_cents),0)-c.before_cents,0))::bigint FROM sales_commissions c LEFT JOIN LATERAL affiliate_invoice_refunds(c.invoice_id) f ON f.status='succeeded' AND (refund_ids IS NULL OR f.id=ANY(refund_ids)) WHERE c.id=target GROUP BY c.basis_cents,c.before_cents
$$;
CREATE FUNCTION sales_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '销售归属和财务记录保留历史'; END IF;
 IF TG_TABLE_NAME='sales_assignments' THEN
  IF OLD.ends_at IS NOT NULL OR NEW.ends_at IS NULL OR ROW(NEW.customer_id,NEW.staff_id,NEW.assigned_by,NEW.starts_at) IS DISTINCT FROM ROW(OLD.customer_id,OLD.staff_id,OLD.assigned_by,OLD.starts_at) THEN RAISE EXCEPTION '销售归属只能结束旧记录，不能改写历史'; END IF;
 ELSE
  IF OLD.status<>'pending' OR (to_jsonb(NEW)-ARRAY['status','net_basis_cents','released_cents','recognized_refund_ids','released_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','net_basis_cents','released_cents','recognized_refund_ids','released_at']) THEN RAISE EXCEPTION '计提规则和已释放销售提成不能覆盖'; END IF;
 END IF;RETURN NEW;
END; $$;
CREATE TRIGGER sales_assignment_fixed BEFORE UPDATE OR DELETE ON sales_assignments FOR EACH ROW EXECUTE FUNCTION sales_fixed();
CREATE TRIGGER sales_commission_fixed BEFORE UPDATE OR DELETE ON sales_commissions FOR EACH ROW EXECUTE FUNCTION sales_fixed();
CREATE TRIGGER immutable_sales_reversals BEFORE UPDATE OR DELETE ON sales_reversals FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_sales_payouts BEFORE UPDATE OR DELETE ON sales_payouts FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_sales_withdrawals BEFORE DELETE ON sales_withdrawals FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION sales_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance numeric; reserved numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('sales:'||NEW.staff_id::text||':'||NEW.currency,0));
 IF TG_OP='UPDATE' THEN IF OLD.status<>'pending' OR ROW(NEW.staff_id,NEW.currency,NEW.amount_cents,NEW.payee,NEW.idempotency_key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.staff_id,OLD.currency,OLD.amount_cents,OLD.payee,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN RAISE EXCEPTION '销售兑现原始申请和已处理结果不能覆盖'; END IF; RETURN NEW; END IF;
 SELECT -COALESCE(sum(e.amount_cents),0) INTO balance FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE e.account='sales:'||NEW.staff_id::text AND t.currency=NEW.currency;
 SELECT COALESCE(sum(amount_cents),0) INTO reserved FROM sales_withdrawals WHERE staff_id=NEW.staff_id AND currency=NEW.currency AND status='pending';
 IF NEW.amount_cents>balance-reserved THEN RAISE EXCEPTION '可用销售提成不足，不能重复预留'; END IF;RETURN NEW;
END; $$;
CREATE TRIGGER sales_withdrawal_reserve BEFORE INSERT OR UPDATE ON sales_withdrawals FOR EACH ROW EXECUTE FUNCTION sales_reserve();
CREATE FUNCTION sales_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; source_kind text; c sales_commissions%ROWTYPE; r sales_reversals%ROWTYPE;p sales_payouts%ROWTYPE;w sales_withdrawals%ROWTYPE;
 bill invoices%ROWTYPE;item order_items%ROWTYPE;ledger uuid;ledger_currency text;currency_code text;amount bigint;debit text;credit text;entry_count bigint;debit_count bigint;credit_count bigint;total numeric;prior_refunds uuid[];previous_basis bigint;current_basis bigint;
BEGIN
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.sales_commission_id IS NOT NULL THEN source_kind:='commission';target:=NEW.sales_commission_id;ELSIF NEW.sales_reversal_id IS NOT NULL THEN source_kind:='reversal';target:=NEW.sales_reversal_id;ELSIF NEW.sales_payout_id IS NOT NULL THEN source_kind:='payout';target:=NEW.sales_payout_id;ELSE RETURN NEW;END IF;
 ELSE source_kind:=CASE TG_TABLE_NAME WHEN 'sales_commissions' THEN 'commission' WHEN 'sales_reversals' THEN 'reversal' WHEN 'sales_payouts' THEN 'payout' ELSE 'withdrawal' END;target:=NEW.id;END IF;
 IF source_kind='withdrawal' THEN SELECT * INTO STRICT w FROM sales_withdrawals WHERE id=target;IF (w.status='paid')<>EXISTS(SELECT 1 FROM sales_payouts WHERE withdrawal_id=target) THEN RAISE EXCEPTION '销售兑现必须有实际打款记录';END IF;RETURN NEW;
 ELSIF source_kind='commission' THEN
  SELECT * INTO STRICT c FROM sales_commissions WHERE id=target;SELECT t.id,t.currency INTO ledger,ledger_currency FROM ledger_transactions t WHERE sales_commission_id=target;
  IF c.status='pending' THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '等待期销售提成不能提前入账';END IF;RETURN NEW;END IF;
  SELECT * INTO STRICT bill FROM invoices WHERE id=c.invoice_id;SELECT * INTO STRICT item FROM order_items WHERE id=c.line_id;
  IF affiliate_invoice_payment_at(bill.id) IS NULL OR bill.status<>'paid' OR item.order_id<>bill.order_id OR item.amount_cents<>c.basis_cents OR c.before_cents<>(SELECT COALESCE(sum(earlier.amount_cents),0) FROM order_items earlier WHERE earlier.order_id=item.order_id AND earlier.id<item.id) OR bill.currency<>c.currency OR c.release_at>now() OR c.release_at<affiliate_invoice_payment_at(bill.id)+make_interval(days=>c.hold_days) OR c.net_basis_cents<>c.basis_cents-sales_line_refunded(c.id,c.recognized_refund_ids) OR c.released_cents<>floor(c.net_basis_cents::numeric*c.rate_bps/10000)::bigint OR NOT EXISTS(SELECT 1 FROM sales_assignments a WHERE a.id=c.assignment_id AND a.staff_id=c.staff_id AND a.customer_id=bill.user_id AND a.starts_at<=c.paid_at AND (a.ends_at IS NULL OR a.ends_at>c.paid_at)) THEN RAISE EXCEPTION '销售提成必须对应当时员工归属、真实业务实收、等待期和净额';END IF;
  IF EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.status NOT IN('rejected','failed') AND (f.status<>'succeeded' OR NOT f.id=ANY(c.recognized_refund_ids))) THEN RAISE EXCEPTION '销售提成须等退款确认并完整记录来源';END IF;
  amount:=c.released_cents;currency_code:=c.currency;debit:='expense:sales';credit:='sales:'||c.staff_id::text;
 ELSIF source_kind='reversal' THEN
  SELECT * INTO STRICT r FROM sales_reversals WHERE id=target;SELECT * INTO STRICT c FROM sales_commissions WHERE id=r.commission_id;
  SELECT COALESCE(array_agg(refund_id),'{}') INTO prior_refunds FROM sales_reversals WHERE commission_id=c.id AND position<r.position;
  previous_basis:=c.basis_cents-sales_line_refunded(c.id,c.recognized_refund_ids||prior_refunds);current_basis:=c.basis_cents-sales_line_refunded(c.id,c.recognized_refund_ids||prior_refunds||ARRAY[r.refund_id]);
  IF c.status<>'released' OR NOT EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.id=r.refund_id AND f.status='succeeded') OR r.refund_id=ANY(c.recognized_refund_ids) OR r.basis_before_cents<>previous_basis OR r.basis_after_cents<>current_basis OR r.amount_cents<>floor(previous_basis::numeric*c.rate_bps/10000)::bigint-floor(current_basis::numeric*c.rate_bps/10000)::bigint THEN RAISE EXCEPTION '销售冲回必须对应真实退款和精确净额差值';END IF;
  SELECT t.id,t.currency INTO ledger,ledger_currency FROM ledger_transactions t WHERE sales_reversal_id=target;amount:=r.amount_cents;currency_code:=c.currency;debit:='sales:'||c.staff_id::text;credit:='expense:sales';
 ELSE
  SELECT * INTO STRICT p FROM sales_payouts WHERE id=target;SELECT * INTO STRICT w FROM sales_withdrawals WHERE id=p.withdrawal_id;
  IF w.status<>'paid' OR w.staff_id<>p.staff_id OR w.currency<>p.currency OR w.amount_cents<>p.amount_cents OR p.channel<>(w.payee->>'method') OR p.paid_at>now()+interval '5 minutes' THEN RAISE EXCEPTION '销售实际打款须与申请本人、币种、金额和时间一致';END IF;
  SELECT t.id,t.currency INTO ledger,ledger_currency FROM ledger_transactions t WHERE sales_payout_id=target;amount:=p.amount_cents;currency_code:=p.currency;debit:='sales:'||p.staff_id::text;credit:='cash:sales-payout:'||p.channel;
 END IF;
 IF amount=0 THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '零提成不能产生分录';END IF;RETURN NEW;END IF;
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account=debit AND amount_cents=amount),count(*) FILTER(WHERE account=credit AND amount_cents=-amount) INTO entry_count,total,debit_count,credit_count FROM ledger_entries WHERE transaction_id=ledger;
 IF ledger IS NULL OR ledger_currency<>currency_code OR entry_count<>2 OR total<>0 OR debit_count<>1 OR credit_count<>1 THEN RAISE EXCEPTION '销售资金来源须有同币种、同本人、同金额的平衡分录';END IF;RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER sales_commission_source AFTER INSERT OR UPDATE ON sales_commissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_source_complete();
CREATE CONSTRAINT TRIGGER sales_reversal_source AFTER INSERT ON sales_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_source_complete();
CREATE CONSTRAINT TRIGGER sales_payout_source AFTER INSERT ON sales_payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_source_complete();
CREATE CONSTRAINT TRIGGER sales_withdrawal_source AFTER INSERT OR UPDATE ON sales_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_source_complete();
CREATE CONSTRAINT TRIGGER ledger_sales_source AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales_source_complete();
