-- 联盟推荐：真实付款产生佣金负债；转余额、退款冲回和现金提现使用独立不可变资金来源。
CREATE TABLE affiliate_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 initial_rule jsonb NOT NULL DEFAULT '{"kind":"percent","value":"1000"}',
 renewal_rule jsonb NOT NULL DEFAULT '{"kind":"percent","value":"1000"}',
 reorder_rule jsonb NOT NULL DEFAULT '{"kind":"percent","value":"1000"}',
 hold_days integer NOT NULL DEFAULT 30 CHECK(hold_days BETWEEN 0 AND 365),
 minimum_withdraw_cents bigint NOT NULL DEFAULT 10000 CHECK(minimum_withdraw_cents BETWEEN 1 AND 999999999999),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO affiliate_settings(id) VALUES(true);
CREATE FUNCTION affiliate_entitlement(rule jsonb,basis bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
 SELECT LEAST(GREATEST(basis,0)::numeric,CASE WHEN rule->>'kind'='fixed' THEN (rule->>'value')::numeric ELSE floor(GREATEST(basis,0)::numeric*(rule->>'value')::numeric/10000) END)::bigint
$$;
CREATE FUNCTION affiliate_invoice_payment_at(target uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(t.created_at) FROM ledger_transactions t LEFT JOIN payment_receipts r ON r.id=t.receipt_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id WHERE r.invoice_id=target OR w.invoice_id=target
$$;
CREATE TABLE affiliates (
 user_id uuid PRIMARY KEY REFERENCES users, code text NOT NULL UNIQUE CHECK(code ~ '^[A-Za-z0-9_-]{22}$'),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE affiliate_referrals (
 user_id uuid PRIMARY KEY REFERENCES users, affiliate_id uuid NOT NULL REFERENCES affiliates(user_id),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(user_id<>affiliate_id)
);
CREATE INDEX affiliate_referral_owner ON affiliate_referrals(affiliate_id);
CREATE FUNCTION affiliate_referral_safe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(812455);
 IF NEW.user_id=NEW.affiliate_id OR EXISTS(WITH RECURSIVE ancestors(id) AS (SELECT NEW.affiliate_id UNION SELECT r.affiliate_id FROM affiliate_referrals r JOIN ancestors a ON r.user_id=a.id) SELECT 1 FROM ancestors WHERE id=NEW.user_id) THEN RAISE EXCEPTION '不能自我推荐或形成循环推荐'; END IF;
 IF NOT EXISTS(SELECT 1 FROM affiliates a JOIN users u ON u.id=a.user_id WHERE a.user_id=NEW.affiliate_id AND a.enabled AND NOT u.disabled) THEN RAISE EXCEPTION '推荐人当前不可用'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER affiliate_referral_safe BEFORE INSERT ON affiliate_referrals FOR EACH ROW EXECUTE FUNCTION affiliate_referral_safe();
CREATE TRIGGER immutable_affiliate_referrals BEFORE UPDATE OR DELETE ON affiliate_referrals FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE affiliate_commissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), affiliate_id uuid NOT NULL REFERENCES affiliates(user_id),
 user_id uuid NOT NULL REFERENCES users, invoice_id uuid NOT NULL UNIQUE REFERENCES invoices,
 category text NOT NULL CHECK(category IN('initial','renewal','reorder')), rule jsonb NOT NULL,
 quoted_cents bigint NOT NULL CHECK(quoted_cents>=0), release_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','released','void')),
 net_basis_cents bigint, released_cents bigint, recognized_refund_ids uuid[] NOT NULL DEFAULT '{}',
 released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='pending')=(released_at IS NULL)), CHECK(status='pending' OR (released_cents IS NOT NULL AND net_basis_cents IS NOT NULL AND released_cents>=0 AND net_basis_cents>=0)),
 CHECK(status<>'released' OR released_cents>0), CHECK(status<>'void' OR released_cents=0)
);
CREATE INDEX affiliate_commission_owner ON affiliate_commissions(affiliate_id,created_at DESC);
CREATE INDEX affiliate_commission_due ON affiliate_commissions(release_at,affiliate_id) WHERE status='pending';
CREATE UNIQUE INDEX affiliate_one_initial ON affiliate_commissions(user_id) WHERE category='initial';
CREATE TABLE affiliate_reversals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 commission_id uuid NOT NULL REFERENCES affiliate_commissions, refund_id uuid NOT NULL UNIQUE REFERENCES refunds,
 amount_cents bigint NOT NULL CHECK(amount_cents>=0), basis_before_cents bigint NOT NULL CHECK(basis_before_cents>=0),
 basis_after_cents bigint NOT NULL CHECK(basis_after_cents>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE affiliate_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES affiliates(user_id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999), currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 idempotency_key text NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE affiliate_withdrawals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES affiliates(user_id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999), currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 payee jsonb NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','rejected','cancelled')),
 decision_reason text, handled_by uuid REFERENCES users, handled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE affiliate_payouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), withdrawal_id uuid NOT NULL UNIQUE REFERENCES affiliate_withdrawals,
 user_id uuid NOT NULL REFERENCES affiliates(user_id), amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'), channel text NOT NULL CHECK(channel IN('bank','alipay','wechat')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 200), evidence_url text,
 paid_at timestamptz NOT NULL, recorded_by uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(channel,reference)
);
ALTER TABLE ledger_transactions ADD COLUMN affiliate_commission_id uuid UNIQUE REFERENCES affiliate_commissions;
ALTER TABLE ledger_transactions ADD COLUMN affiliate_reversal_id uuid UNIQUE REFERENCES affiliate_reversals;
ALTER TABLE ledger_transactions ADD COLUMN affiliate_transfer_id uuid UNIQUE REFERENCES affiliate_transfers;
ALTER TABLE ledger_transactions ADD COLUMN affiliate_payout_id uuid UNIQUE REFERENCES affiliate_payouts;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_one_source;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id,opening_balance_id,wallet_payment_id,affiliate_commission_id,affiliate_reversal_id,affiliate_transfer_id,affiliate_payout_id)=1);
CREATE FUNCTION affiliate_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE balance numeric; reserved numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('affiliate:'||NEW.user_id::text,0));
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.user_id,NEW.amount_cents,NEW.currency,NEW.payee,NEW.idempotency_key,NEW.request_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.user_id,OLD.amount_cents,OLD.currency,OLD.payee,OLD.idempotency_key,OLD.request_hash,OLD.created_at) OR OLD.status<>'pending' THEN RAISE EXCEPTION '提现原始事实及已处理结果不能覆盖'; END IF;
  RETURN NEW;
 END IF;
 SELECT -COALESCE(sum(amount_cents),0) INTO balance FROM ledger_entries WHERE account='affiliate:'||NEW.user_id::text;
 SELECT COALESCE(sum(amount_cents),0) INTO reserved FROM affiliate_withdrawals WHERE user_id=NEW.user_id AND status='pending';
 IF NEW.amount_cents>balance-reserved THEN RAISE EXCEPTION '可用佣金不足，不能重复预留或透支'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER affiliate_transfer_reserve BEFORE INSERT ON affiliate_transfers FOR EACH ROW EXECUTE FUNCTION affiliate_reserve();
CREATE TRIGGER affiliate_withdrawal_reserve BEFORE INSERT OR UPDATE ON affiliate_withdrawals FOR EACH ROW EXECUTE FUNCTION affiliate_reserve();
CREATE FUNCTION affiliate_commission_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '佣金记录保留历史'; END IF;
 IF OLD.status<>'pending' OR ROW(NEW.affiliate_id,NEW.user_id,NEW.invoice_id,NEW.category,NEW.rule,NEW.quoted_cents,NEW.release_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.affiliate_id,OLD.user_id,OLD.invoice_id,OLD.category,OLD.rule,OLD.quoted_cents,OLD.release_at,OLD.created_at) THEN RAISE EXCEPTION '佣金原始规则和已释放事实不能覆盖'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER affiliate_commission_fixed BEFORE UPDATE OR DELETE ON affiliate_commissions FOR EACH ROW EXECUTE FUNCTION affiliate_commission_fixed();
CREATE TRIGGER immutable_affiliate_reversals BEFORE UPDATE OR DELETE ON affiliate_reversals FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_affiliate_transfers BEFORE UPDATE OR DELETE ON affiliate_transfers FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_affiliate_payouts BEFORE UPDATE OR DELETE ON affiliate_payouts FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_affiliate_withdrawals BEFORE DELETE ON affiliate_withdrawals FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- 每种新增资金来源都从来源表和会计事务两端延迟复核，保留全部旧守卫。
CREATE FUNCTION affiliate_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target uuid; ledger uuid; amount bigint; owner uuid; debit text; credit text; entry_count bigint; debit_count bigint; credit_count bigint; total numeric;
 c affiliate_commissions%ROWTYPE; r affiliate_reversals%ROWTYPE; t affiliate_transfers%ROWTYPE; p affiliate_payouts%ROWTYPE; w affiliate_withdrawals%ROWTYPE; bill invoices%ROWTYPE; rf refunds%ROWTYPE; previous_basis bigint; refunded bigint; ledger_currency text;
BEGIN
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.affiliate_commission_id IS NOT NULL THEN kind:='commission';target:=NEW.affiliate_commission_id;
  ELSIF NEW.affiliate_reversal_id IS NOT NULL THEN kind:='reversal';target:=NEW.affiliate_reversal_id;
  ELSIF NEW.affiliate_transfer_id IS NOT NULL THEN kind:='transfer';target:=NEW.affiliate_transfer_id;
  ELSIF NEW.affiliate_payout_id IS NOT NULL THEN kind:='payout';target:=NEW.affiliate_payout_id; ELSE RETURN NEW; END IF;
 ELSE kind:=CASE TG_TABLE_NAME WHEN 'affiliate_commissions' THEN 'commission' WHEN 'affiliate_reversals' THEN 'reversal' WHEN 'affiliate_transfers' THEN 'transfer' WHEN 'affiliate_payouts' THEN 'payout' ELSE 'withdrawal' END;target:=NEW.id; END IF;
 IF kind='withdrawal' THEN
  SELECT * INTO STRICT w FROM affiliate_withdrawals WHERE id=target;
  IF (w.status='paid')<>EXISTS(SELECT 1 FROM affiliate_payouts WHERE withdrawal_id=w.id) THEN RAISE EXCEPTION '已支付提现必须有真实打款记录，其他状态不能有打款'; END IF; RETURN NEW;
 ELSIF kind='commission' THEN
  SELECT * INTO STRICT c FROM affiliate_commissions WHERE id=target; SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_commission_id=target;
  IF c.status='pending' THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '等待期佣金不能提前记可用负债'; END IF;RETURN NEW;END IF;
  SELECT * INTO STRICT bill FROM invoices WHERE id=c.invoice_id;
  SELECT COALESCE(sum(f.amount_cents),0)::bigint INTO refunded FROM refunds f JOIN payment_receipts pr ON pr.id=f.receipt_id WHERE f.status='succeeded' AND pr.invoice_id=c.invoice_id;
  IF EXISTS(SELECT 1 FROM refunds f JOIN payment_receipts pr ON pr.id=f.receipt_id WHERE pr.invoice_id=c.invoice_id AND (f.status NOT IN('rejected','failed','succeeded') OR (f.status='succeeded' AND NOT f.id=ANY(c.recognized_refund_ids)))) THEN RAISE EXCEPTION '等待退款确认并完整记录已退款来源后才能释放佣金'; END IF;
  IF bill.status<>'paid' OR bill.user_id<>c.user_id OR c.release_at>now() OR affiliate_invoice_payment_at(bill.id) IS NULL OR c.release_at<affiliate_invoice_payment_at(bill.id) OR c.net_basis_cents<>GREATEST(bill.amount_cents-refunded,0) OR c.released_cents<>affiliate_entitlement(c.rule,c.net_basis_cents) OR NOT EXISTS(SELECT 1 FROM orders business WHERE business.id=bill.order_id AND business.kind IN('new','renew','upgrade')) OR NOT EXISTS(SELECT 1 FROM affiliate_referrals WHERE user_id=c.user_id AND affiliate_id=c.affiliate_id AND created_at<=bill.paid_at) THEN RAISE EXCEPTION '佣金必须来自已付款账单、真实来源、注册归因和净退款金额'; END IF;
  amount:=c.released_cents;owner:=c.affiliate_id;debit:='expense:affiliate';credit:='affiliate:'||owner::text;
 ELSIF kind='reversal' THEN
  SELECT * INTO STRICT r FROM affiliate_reversals WHERE id=target;SELECT * INTO STRICT c FROM affiliate_commissions WHERE id=r.commission_id;SELECT * INTO STRICT rf FROM refunds WHERE id=r.refund_id;
  SELECT GREATEST(c.net_basis_cents-COALESCE(sum(f.amount_cents),0),0)::bigint INTO previous_basis FROM affiliate_reversals x JOIN refunds f ON f.id=x.refund_id WHERE x.commission_id=c.id AND x.position<r.position;
  IF c.status<>'released' OR rf.status<>'succeeded' OR rf.id=ANY(c.recognized_refund_ids) OR NOT EXISTS(SELECT 1 FROM payment_receipts WHERE id=rf.receipt_id AND invoice_id=c.invoice_id) OR r.basis_before_cents<>previous_basis OR r.basis_after_cents<>GREATEST(previous_basis-rf.amount_cents,0) OR r.amount_cents<>affiliate_entitlement(c.rule,r.basis_before_cents)-affiliate_entitlement(c.rule,r.basis_after_cents) THEN RAISE EXCEPTION '佣金冲回必须对应真实退款及净额差值'; END IF;
  SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_reversal_id=target;amount:=r.amount_cents;owner:=c.affiliate_id;debit:='affiliate:'||owner::text;credit:='expense:affiliate';
 ELSIF kind='transfer' THEN
  SELECT * INTO STRICT t FROM affiliate_transfers WHERE id=target;SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_transfer_id=target;amount:=t.amount_cents;owner:=t.user_id;debit:='affiliate:'||owner::text;credit:='wallet:'||owner::text;
 ELSE
  SELECT * INTO STRICT p FROM affiliate_payouts WHERE id=target;SELECT * INTO STRICT w FROM affiliate_withdrawals WHERE id=p.withdrawal_id;
  IF w.status<>'paid' OR p.user_id<>w.user_id OR p.amount_cents<>w.amount_cents OR p.channel<>(w.payee->>'method') OR p.paid_at>now()+interval '5 minutes' THEN RAISE EXCEPTION '实际打款必须与提现本人、金额、收款方式和时间一致'; END IF;
  SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_payout_id=target;amount:=p.amount_cents;owner:=p.user_id;debit:='affiliate:'||owner::text;credit:='cash:affiliate-payout:'||p.channel;
 END IF;
 IF amount=0 THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '零佣金不能产生资金分录'; END IF; RETURN NEW; END IF;
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account=debit AND amount_cents=amount),count(*) FILTER(WHERE account=credit AND amount_cents=-amount) INTO entry_count,total,debit_count,credit_count FROM ledger_entries WHERE transaction_id=ledger;
 IF ledger IS NULL OR ledger_currency<>'CNY' OR entry_count<>2 OR total<>0 OR debit_count<>1 OR credit_count<>1 THEN RAISE EXCEPTION '联盟资金来源必须有同币种、同本人、相同金额的平衡双分录'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER affiliate_commission_ledger AFTER INSERT OR UPDATE ON affiliate_commissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
CREATE CONSTRAINT TRIGGER affiliate_reversal_ledger AFTER INSERT ON affiliate_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
CREATE CONSTRAINT TRIGGER affiliate_transfer_ledger AFTER INSERT ON affiliate_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
CREATE CONSTRAINT TRIGGER affiliate_payout_ledger AFTER INSERT ON affiliate_payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
CREATE CONSTRAINT TRIGGER affiliate_withdrawal_ledger AFTER INSERT OR UPDATE ON affiliate_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
CREATE CONSTRAINT TRIGGER ledger_affiliate_source AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION affiliate_source_complete();
