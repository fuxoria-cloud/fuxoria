-- 余额支付：迁移期初余额与后续收款形成的客户负债，可以结清自己的业务账单。
CREATE TABLE wallet_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices,
  user_id uuid NOT NULL REFERENCES users,
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  currency text NOT NULL CHECK(currency='CNY'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ledger_transactions ADD COLUMN wallet_payment_id uuid UNIQUE REFERENCES wallet_payments;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_one_source;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id,opening_balance_id,wallet_payment_id)=1);
CREATE TRIGGER immutable_wallet_payments BEFORE UPDATE OR DELETE ON wallet_payments FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION wallet_payment_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment wallet_payments%ROWTYPE;
  bill invoices%ROWTYPE;
  entries bigint;
  total numeric;
  wallet_entries bigint;
  income_entries bigint;
BEGIN
  IF NEW.wallet_payment_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT payment FROM wallet_payments WHERE id=NEW.wallet_payment_id;
  SELECT * INTO STRICT bill FROM invoices WHERE id=payment.invoice_id;
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='wallet:'||payment.user_id::text AND amount_cents=payment.amount_cents),
    count(*) FILTER(WHERE account='income:'||payment.user_id::text AND amount_cents=-payment.amount_cents)
    INTO entries,total,wallet_entries,income_entries FROM ledger_entries WHERE transaction_id=NEW.id;
  IF NEW.currency<>payment.currency OR bill.currency<>payment.currency OR bill.user_id<>payment.user_id
     OR bill.amount_cents<>payment.amount_cents OR bill.status<>'paid'
     OR entries<>2 OR total<>0 OR wallet_entries<>1 OR income_entries<>1 THEN
    RAISE EXCEPTION '余额支付必须与本人账单及借贷分录一致';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER wallet_payment_balanced AFTER INSERT ON ledger_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_payment_balanced();
CREATE INDEX wallet_account_history ON ledger_entries(account,id DESC);
