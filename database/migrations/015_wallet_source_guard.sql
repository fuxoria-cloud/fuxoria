-- 钱包来源双向约束：不能只插一行支付标记而没有真实平衡分录。
CREATE FUNCTION wallet_has_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_id uuid;
  bill invoices%ROWTYPE;
  entries bigint;
  total numeric;
  wallet_entries bigint;
  income_entries bigint;
BEGIN
  SELECT id INTO ledger_id FROM ledger_transactions WHERE wallet_payment_id=NEW.id AND currency=NEW.currency;
  SELECT * INTO STRICT bill FROM invoices WHERE id=NEW.invoice_id;
  IF ledger_id IS NULL OR bill.status<>'paid' OR bill.user_id<>NEW.user_id
     OR bill.currency<>NEW.currency OR bill.amount_cents<>NEW.amount_cents THEN
    RAISE EXCEPTION '余额支付必须有真实已付账单和独立会计事务';
  END IF;
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='wallet:'||NEW.user_id::text AND amount_cents=NEW.amount_cents),
    count(*) FILTER(WHERE account='income:'||NEW.user_id::text AND amount_cents=-NEW.amount_cents)
    INTO entries,total,wallet_entries,income_entries FROM ledger_entries WHERE transaction_id=ledger_id;
  IF entries<>2 OR total<>0 OR wallet_entries<>1 OR income_entries<>1 THEN
    RAISE EXCEPTION '余额支付标记必须与实际借贷分录一致';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER wallet_has_ledger AFTER INSERT ON wallet_payments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_has_ledger();
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM wallet_payments w LEFT JOIN ledger_transactions t ON t.wallet_payment_id=w.id
    JOIN invoices i ON i.id=w.invoice_id WHERE t.id IS NULL OR i.status<>'paid' OR i.user_id<>w.user_id
    OR i.currency<>w.currency OR i.amount_cents<>w.amount_cents) THEN
    RAISE EXCEPTION '已有余额支付记录缺少匹配账本，请先核对历史资金事实';
  END IF;
END;
$$;
