-- 期初余额必须有且仅有一笔同币种会计事务；追加分录也不能改写已经对账的期初事实。
CREATE FUNCTION opening_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_id uuid;
  balance opening_balances%ROWTYPE;
  ledger_id uuid;
  ledger_currency text;
  entry_count bigint;
  total numeric;
  wallet_count bigint;
  equity_count bigint;
BEGIN
  IF TG_TABLE_NAME='opening_balances' THEN source_id:=NEW.id;
  ELSIF TG_TABLE_NAME='ledger_entries' THEN
    SELECT opening_balance_id INTO source_id FROM ledger_transactions WHERE id=NEW.transaction_id;
  ELSE source_id:=NEW.opening_balance_id;
  END IF;
  IF source_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT balance FROM opening_balances WHERE id=source_id;
  SELECT id,currency INTO ledger_id,ledger_currency FROM ledger_transactions WHERE opening_balance_id=source_id;
  IF ledger_id IS NULL OR ledger_currency<>balance.currency THEN
    RAISE EXCEPTION '期初余额必须有同币种的独立会计事务';
  END IF;
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='wallet:'||balance.user_id::text AND amount_cents=-balance.amount_cents),
    count(*) FILTER(WHERE account='migration:equity' AND amount_cents=balance.amount_cents)
    INTO entry_count,total,wallet_count,equity_count FROM ledger_entries WHERE transaction_id=ledger_id;
  IF entry_count<>2 OR total<>0 OR wallet_count<>1 OR equity_count<>1 THEN
    RAISE EXCEPTION '期初余额分录必须与原余额事实精确对应';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER opening_fact_complete AFTER INSERT ON opening_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_source_complete();
CREATE CONSTRAINT TRIGGER opening_entries_complete AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_source_complete();
ALTER TABLE users ADD CONSTRAINT legacy_auth_pair CHECK(
  (legacy_password IS NULL AND legacy_authcode_id IS NULL) OR
  (legacy_password IS NOT NULL AND legacy_authcode_id ~ '^[0-9A-F]{16}$')
);
