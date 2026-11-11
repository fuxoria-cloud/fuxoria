-- 信用额度：授信、实际应收款与还款分开记账，不把借款当充值，也不允许循环借款还款。
CREATE TABLE credit_accounts (
 user_id uuid PRIMARY KEY REFERENCES users(id),enabled boolean NOT NULL DEFAULT false,
 limit_cents bigint NOT NULL DEFAULT 0 CHECK(limit_cents BETWEEN 0 AND 100000000000),
 billing_day integer NOT NULL DEFAULT 1 CHECK(billing_day BETWEEN 1 AND 28),
 repayment_days integer NOT NULL DEFAULT 15 CHECK(repayment_days BETWEEN 1 AND 90),
 note text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid NOT NULL UNIQUE REFERENCES invoices(id),
 user_id uuid NOT NULL REFERENCES users(id),amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),bill_at timestamptz NOT NULL,due_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_repayments (
 order_id uuid PRIMARY KEY REFERENCES orders(id),user_id uuid NOT NULL REFERENCES users(id),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_repayment_items (
 order_id uuid NOT NULL REFERENCES credit_repayments(order_id),payment_id uuid NOT NULL REFERENCES credit_payments(id),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),PRIMARY KEY(order_id,payment_id)
);
ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK(kind IN ('new','renew','recharge','upgrade','credit_repayment'));
ALTER TABLE ledger_transactions ADD COLUMN credit_payment_id uuid UNIQUE REFERENCES credit_payments(id);
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_one_source;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id,opening_balance_id,wallet_payment_id,affiliate_commission_id,affiliate_reversal_id,affiliate_transfer_id,affiliate_payout_id,credit_payment_id)=1);
CREATE TRIGGER immutable_credit_payments BEFORE UPDATE OR DELETE ON credit_payments FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_credit_repayments BEFORE UPDATE OR DELETE ON credit_repayments FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_credit_repayment_items BEFORE UPDATE OR DELETE ON credit_repayment_items FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE INDEX credit_unbilled ON credit_payments(bill_at,user_id);
CREATE FUNCTION credit_limit_respected() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('credit:'||NEW.user_id::text,0));
 IF NEW.limit_cents<(SELECT COALESCE(sum(amount_cents),0) FROM ledger_entries WHERE account='receivable:'||NEW.user_id::text) THEN RAISE EXCEPTION '信用额度不能低于实际应收款'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER credit_limit_respected AFTER INSERT OR UPDATE ON credit_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_limit_respected();
CREATE FUNCTION credit_repayment_not_refundable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id WHERE p.id=NEW.receipt_id AND o.kind='credit_repayment') THEN RAISE EXCEPTION '信用还款不能重复提取现金，请核对原业务账单'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credit_repayment_not_refundable BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION credit_repayment_not_refundable();
CREATE FUNCTION credit_payment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; payment credit_payments%ROWTYPE; bill invoices%ROWTYPE; ledger_id uuid; entries bigint; debt bigint; income bigint; source_count bigint; used numeric; available bigint;
BEGIN
 IF TG_TABLE_NAME='credit_payments' THEN target_id:=NEW.id; ELSE target_id:=NEW.credit_payment_id; END IF;
 IF target_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT payment FROM credit_payments WHERE id=target_id;
 SELECT * INTO STRICT bill FROM invoices WHERE id=payment.invoice_id;
 SELECT id INTO ledger_id FROM ledger_transactions WHERE credit_payment_id=target_id AND currency=payment.currency;
 SELECT count(*),count(*) FILTER(WHERE account='receivable:'||payment.user_id::text AND amount_cents=payment.amount_cents),
 count(*) FILTER(WHERE account='income:'||payment.user_id::text AND amount_cents=-payment.amount_cents)
 INTO entries,debt,income FROM ledger_entries WHERE transaction_id=ledger_id;
 IF ledger_id IS NULL OR bill.status<>'paid' OR bill.user_id<>payment.user_id OR bill.amount_cents<>payment.amount_cents OR bill.currency<>payment.currency
 OR entries<>2 OR debt<>1 OR income<>1 THEN RAISE EXCEPTION '信用付款必须有真实应收款和收入分录'; END IF;
 SELECT (SELECT count(*) FROM payment_receipts WHERE invoice_id=bill.id)+(SELECT count(*) FROM wallet_payments WHERE invoice_id=bill.id) INTO source_count;
 IF source_count<>0 THEN RAISE EXCEPTION '信用、现金和余额不能重复结清同一账单'; END IF;
 SELECT COALESCE(sum(amount_cents),0) INTO used FROM ledger_entries WHERE account='receivable:'||payment.user_id::text;
 SELECT limit_cents INTO available FROM credit_accounts WHERE user_id=payment.user_id;
 IF used<0 OR used>available THEN RAISE EXCEPTION '信用应收款不能为负或超过授权额度'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER credit_has_ledger AFTER INSERT ON credit_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_payment_complete();
CREATE CONSTRAINT TRIGGER ledger_has_credit AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_payment_complete();
CREATE OR REPLACE FUNCTION invoice_payment_unique() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE count_sources bigint;
BEGIN
 PERFORM id FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
 SELECT (SELECT count(*) FROM payment_receipts WHERE invoice_id=NEW.invoice_id)+(SELECT count(*) FROM wallet_payments WHERE invoice_id=NEW.invoice_id)+(SELECT count(*) FROM credit_payments WHERE invoice_id=NEW.invoice_id) INTO count_sources;
 IF count_sources>1 THEN RAISE EXCEPTION '一张账单不能同时通过余额、信用和支付机构入账'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER invoice_one_credit AFTER INSERT ON credit_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payment_unique();
CREATE FUNCTION credit_repayment_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; expected bigint; actual numeric; bill_kind text; owner_id uuid;
BEGIN
 IF TG_TABLE_NAME='credit_repayments' THEN target_id:=NEW.order_id; ELSE target_id:=NEW.order_id; END IF;
 SELECT amount_cents,user_id INTO STRICT expected,owner_id FROM credit_repayments WHERE order_id=target_id;
 SELECT kind INTO bill_kind FROM orders WHERE id=target_id AND user_id=owner_id AND amount_cents=expected;
 SELECT COALESCE(sum(i.amount_cents),0) INTO actual FROM credit_repayment_items i JOIN credit_payments p ON p.id=i.payment_id AND p.user_id=owner_id WHERE i.order_id=target_id;
 IF bill_kind IS DISTINCT FROM 'credit_repayment' OR actual<>expected THEN RAISE EXCEPTION '还款账单必须等于同一客户的真实信用占用'; END IF;
 IF EXISTS(SELECT 1 FROM credit_payments p WHERE p.id IN (SELECT payment_id FROM credit_repayment_items WHERE order_id=target_id)
  AND p.amount_cents<(SELECT COALESCE(sum(i.amount_cents),0) FROM credit_repayment_items i JOIN orders o ON o.id=i.order_id WHERE i.payment_id=p.id AND o.status<>'cancelled')) THEN RAISE EXCEPTION '同一信用欠款不能重复开还款单'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER credit_repayment_complete AFTER INSERT ON credit_repayments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_repayment_complete();
CREATE CONSTRAINT TRIGGER credit_repayment_items_complete AFTER INSERT ON credit_repayment_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_repayment_complete();
-- 还款收入冲销应收款，不能重复计收入。充值仍贷记客户钱包负债。
CREATE OR REPLACE FUNCTION receipt_ledger_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; receipt payment_receipts%ROWTYPE; bill invoices%ROWTYPE; ledger_id uuid;
 ledger_currency text; entries bigint; total numeric; cash_entries bigint; credit_entries bigint; account_name text;
BEGIN
 IF TG_TABLE_NAME='payment_receipts' THEN target_id:=NEW.id; ELSE target_id:=NEW.receipt_id; END IF;
 IF target_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT receipt FROM payment_receipts WHERE id=target_id;
 SELECT * INTO STRICT bill FROM invoices WHERE id=receipt.invoice_id;
 SELECT id,currency INTO ledger_id,ledger_currency FROM ledger_transactions WHERE receipt_id=receipt.id;
 IF ledger_id IS NULL OR ledger_currency<>receipt.currency OR bill.status<>'paid' OR bill.currency<>receipt.currency OR bill.amount_cents<>receipt.amount_cents THEN RAISE EXCEPTION '支付机构收款必须与已付账单和同币种会计事务一致'; END IF;
 SELECT CASE kind WHEN 'recharge' THEN 'wallet:' WHEN 'credit_repayment' THEN 'receivable:' ELSE 'income:' END||bill.user_id::text INTO account_name FROM orders WHERE id=bill.order_id;
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account='cash:'||receipt.gateway AND amount_cents=receipt.amount_cents),count(*) FILTER(WHERE account=account_name AND amount_cents=-receipt.amount_cents)
 INTO entries,total,cash_entries,credit_entries FROM ledger_entries WHERE transaction_id=ledger_id;
 IF entries<>2 OR total<>0 OR cash_entries<>1 OR credit_entries<>1 THEN RAISE EXCEPTION '支付机构收款的现金与收入/负债/应收分录不一致'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION wallet_payment_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment wallet_payments%ROWTYPE; bill invoices%ROWTYPE; entries bigint; total numeric; wallet_entries bigint; income_entries bigint; account_name text;
BEGIN
 IF NEW.wallet_payment_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT payment FROM wallet_payments WHERE id=NEW.wallet_payment_id;
 SELECT * INTO STRICT bill FROM invoices WHERE id=payment.invoice_id;
 SELECT CASE WHEN kind='credit_repayment' THEN 'receivable:' ELSE 'income:' END||payment.user_id::text INTO account_name FROM orders WHERE id=bill.order_id AND kind<>'recharge';
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account='wallet:'||payment.user_id::text AND amount_cents=payment.amount_cents),count(*) FILTER(WHERE account=account_name AND amount_cents=-payment.amount_cents)
 INTO entries,total,wallet_entries,income_entries FROM ledger_entries WHERE transaction_id=NEW.id;
 IF NEW.currency<>payment.currency OR bill.currency<>payment.currency OR bill.user_id<>payment.user_id OR bill.amount_cents<>payment.amount_cents OR bill.status<>'paid' OR entries<>2 OR total<>0 OR wallet_entries<>1 OR income_entries<>1 THEN RAISE EXCEPTION '余额支付必须与本人账单及借贷分录一致'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION wallet_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ledger_id uuid; bill invoices%ROWTYPE; entries bigint; total numeric; wallet_entries bigint; income_entries bigint; account_name text;
BEGIN
 SELECT id INTO ledger_id FROM ledger_transactions WHERE wallet_payment_id=NEW.id AND currency=NEW.currency;
 SELECT * INTO STRICT bill FROM invoices WHERE id=NEW.invoice_id;
 IF ledger_id IS NULL OR bill.status<>'paid' OR bill.user_id<>NEW.user_id OR bill.currency<>NEW.currency OR bill.amount_cents<>NEW.amount_cents THEN RAISE EXCEPTION '余额支付必须有真实已付账单和独立会计事务'; END IF;
 SELECT CASE WHEN kind='credit_repayment' THEN 'receivable:' ELSE 'income:' END||NEW.user_id::text INTO account_name FROM orders WHERE id=bill.order_id AND kind<>'recharge';
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account='wallet:'||NEW.user_id::text AND amount_cents=NEW.amount_cents),count(*) FILTER(WHERE account=account_name AND amount_cents=-NEW.amount_cents)
 INTO entries,total,wallet_entries,income_entries FROM ledger_entries WHERE transaction_id=ledger_id;
 IF entries<>2 OR total<>0 OR wallet_entries<>1 OR income_entries<>1 THEN RAISE EXCEPTION '余额支付标记必须与实际借贷分录一致'; END IF;
 RETURN NEW;
END $$;
