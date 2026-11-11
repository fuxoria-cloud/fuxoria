-- 余额充值：真实收款计入客户负债；退款预留阻止同一笔余额同时消费和退回。
-- 调用：npm run db:migrate。充值没有虚构商品或开通资源。
ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK(kind IN ('new','renew','recharge'));
ALTER TABLE orders ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE order_items ALTER COLUMN product_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION receipt_ledger_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; receipt payment_receipts%ROWTYPE; bill invoices%ROWTYPE; ledger_id uuid;
 ledger_currency text; entries bigint; total numeric; cash_entries bigint; credit_entries bigint; account_name text;
BEGIN
 IF TG_TABLE_NAME='payment_receipts' THEN target_id:=NEW.id; ELSE target_id:=NEW.receipt_id; END IF;
 IF target_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT receipt FROM payment_receipts WHERE id=target_id;
 SELECT * INTO STRICT bill FROM invoices WHERE id=receipt.invoice_id;
 SELECT id,currency INTO ledger_id,ledger_currency FROM ledger_transactions WHERE receipt_id=receipt.id;
 IF ledger_id IS NULL OR ledger_currency<>receipt.currency OR bill.status<>'paid'
 OR bill.currency<>receipt.currency OR bill.amount_cents<>receipt.amount_cents THEN
  RAISE EXCEPTION '支付机构收款必须与已付账单和同币种会计事务一致';
 END IF;
 SELECT CASE WHEN kind='recharge' THEN 'wallet:' ELSE 'income:' END||bill.user_id::text INTO account_name FROM orders WHERE id=bill.order_id;
 SELECT count(*),COALESCE(sum(amount_cents),0),
 count(*) FILTER(WHERE account='cash:'||receipt.gateway AND amount_cents=receipt.amount_cents),
 count(*) FILTER(WHERE account=account_name AND amount_cents=-receipt.amount_cents)
 INTO entries,total,cash_entries,credit_entries FROM ledger_entries WHERE transaction_id=ledger_id;
 IF entries<>2 OR total<>0 OR cash_entries<>1 OR credit_entries<>1 THEN RAISE EXCEPTION '支付机构收款的现金与收入/充值负债分录不一致'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION refund_ledger_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; application refunds%ROWTYPE; gateway_name text; ledger_id uuid; transaction_currency text;
 entry_count bigint; total numeric; cash_count bigint; credit_count bigint; account_name text;
BEGIN
 IF TG_TABLE_NAME='refunds' THEN target_id:=NEW.id; ELSE target_id:=NEW.refund_id; END IF;
 IF target_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT application FROM refunds WHERE id=target_id;
 SELECT id,currency INTO ledger_id,transaction_currency FROM ledger_transactions WHERE refund_id=target_id;
 IF application.status<>'succeeded' THEN
  IF ledger_id IS NOT NULL THEN RAISE EXCEPTION '退款未确认成功前不能记反向分录'; END IF;RETURN NEW;
 END IF;
 IF ledger_id IS NULL OR transaction_currency<>application.currency THEN RAISE EXCEPTION '成功退款必须有同币种的独立会计事务'; END IF;
 SELECT p.gateway,CASE WHEN o.kind='recharge' THEN 'wallet:' ELSE 'income:' END||application.user_id::text INTO STRICT gateway_name,account_name
 FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id WHERE p.id=application.receipt_id;
 SELECT count(*),COALESCE(sum(amount_cents),0),
 count(*) FILTER(WHERE account='cash:'||gateway_name AND amount_cents=-application.amount_cents),
 count(*) FILTER(WHERE account=account_name AND amount_cents=application.amount_cents)
 INTO entry_count,total,cash_count,credit_count FROM ledger_entries WHERE transaction_id=ledger_id;
 IF entry_count<>2 OR total<>0 OR cash_count<>1 OR credit_count<>1 THEN RAISE EXCEPTION '退款反向分录的账号或金额不正确'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION recharge_refund_reserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill_kind text; available numeric; held numeric;
BEGIN
 PERFORM id FROM payment_receipts WHERE id=NEW.receipt_id FOR UPDATE;
 SELECT o.kind INTO STRICT bill_kind FROM payment_receipts p JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id WHERE p.id=NEW.receipt_id;
 IF bill_kind<>'recharge' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('wallet:'||NEW.user_id::text,0));
 SELECT -COALESCE(sum(amount_cents),0) INTO available FROM ledger_entries WHERE account='wallet:'||NEW.user_id::text;
 SELECT COALESCE(sum(r.amount_cents),0) INTO held FROM refunds r JOIN payment_receipts p ON p.id=r.receipt_id
 JOIN invoices i ON i.id=p.invoice_id JOIN orders o ON o.id=i.order_id
 WHERE r.user_id=NEW.user_id AND o.kind='recharge' AND r.status NOT IN ('rejected','failed','succeeded');
 IF available-held<NEW.amount_cents THEN RAISE EXCEPTION '充值余额已使用或已预留退款，不能重复支出'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recharge_refund_reserve BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION recharge_refund_reserve();
CREATE FUNCTION wallet_nonnegative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account LIKE 'wallet:%' AND (SELECT COALESCE(sum(amount_cents),0)>0 FROM ledger_entries WHERE account=NEW.account) THEN RAISE EXCEPTION '账户余额不能透支'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER wallet_nonnegative AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_nonnegative();
