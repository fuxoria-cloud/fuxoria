-- 资金来源与分录双向核对：空会计事务、无账本收款和同账单双通道入账都不能提交。
CREATE FUNCTION transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*)<2 OR COALESCE(sum(amount_cents),0)<>0 FROM ledger_entries WHERE transaction_id=NEW.id) THEN
    RAISE EXCEPTION '账本借贷不平衡';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER transaction_balanced AFTER INSERT ON ledger_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_balanced();

CREATE FUNCTION receipt_ledger_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  receipt payment_receipts%ROWTYPE;
  bill invoices%ROWTYPE;
  ledger_id uuid;
  ledger_currency text;
  entries bigint;
  total numeric;
  cash_entries bigint;
  income_entries bigint;
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
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='cash:'||receipt.gateway AND amount_cents=receipt.amount_cents),
    count(*) FILTER(WHERE account='income:'||bill.user_id::text AND amount_cents=-receipt.amount_cents)
    INTO entries,total,cash_entries,income_entries FROM ledger_entries WHERE transaction_id=ledger_id;
  IF entries<>2 OR total<>0 OR cash_entries<>1 OR income_entries<>1 THEN
    RAISE EXCEPTION '支付机构收款的现金与收入分录不一致';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_has_ledger AFTER INSERT ON payment_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receipt_ledger_complete();
CREATE CONSTRAINT TRIGGER ledger_has_receipt AFTER INSERT ON ledger_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receipt_ledger_complete();

CREATE FUNCTION invoice_payment_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM payment_receipts WHERE invoice_id=NEW.invoice_id)
     AND EXISTS(SELECT 1 FROM wallet_payments WHERE invoice_id=NEW.invoice_id) THEN
    RAISE EXCEPTION '一张账单不能同时通过余额和支付机构入账';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER invoice_one_receipt AFTER INSERT ON payment_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payment_unique();
CREATE CONSTRAINT TRIGGER invoice_one_wallet AFTER INSERT ON wallet_payments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payment_unique();
