-- 原系统迁移：固定源快照与ID映射；旧密码和期初余额使用独立字段及账本来源。
CREATE TABLE imports (
  id uuid PRIMARY KEY,
  source_id text NOT NULL UNIQUE,
  source_key text NOT NULL CHECK(source_key ~ '^[0-9A-F]{16}$'),
  snapshot_hash text NOT NULL UNIQUE CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_ids (
  import_id uuid NOT NULL REFERENCES imports,
  entity text NOT NULL,
  legacy_id text NOT NULL,
  new_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(import_id,entity,legacy_id)
);
ALTER TABLE users ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE users ADD COLUMN legacy_id text;
ALTER TABLE users ADD COLUMN legacy_password text CHECK(legacy_password IS NULL OR legacy_password ~ '^###[0-9a-f]{32}$');
ALTER TABLE users ADD COLUMN legacy_authcode_id text;
ALTER TABLE users ADD COLUMN phone_code text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN company text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN country text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN address text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'zh-cn';
ALTER TABLE users ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN client_notes text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
ALTER TABLE users ADD COLUMN last_login_ip text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN updated_at timestamptz;
ALTER TABLE products ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE products ADD COLUMN legacy_id text;
ALTER TABLE products ADD COLUMN legacy_group_id text;
ALTER TABLE products ADD COLUMN legacy_pay_type text;
ALTER TABLE products ADD COLUMN legacy_cycle text;
ALTER TABLE orders ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE orders ADD COLUMN legacy_id text;
ALTER TABLE orders ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE invoices ADD COLUMN legacy_id text;
ALTER TABLE services ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE services ADD COLUMN legacy_id text;
ALTER TABLE services ADD COLUMN legacy_server_id text;
ALTER TABLE services ADD COLUMN legacy_module text;
ALTER TABLE services ADD COLUMN renew_amount_cents bigint CHECK(renew_amount_cents IS NULL OR renew_amount_cents>0);
ALTER TABLE services ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN client_notes text NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN suspend_type text NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN suspend_reason text NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN suspended_at timestamptz;
ALTER TABLE payment_receipts ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE payment_receipts ADD COLUMN legacy_id text;
ALTER TABLE payment_receipts ADD COLUMN legacy_gateway text;
ALTER TABLE tickets ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE tickets ADD COLUMN legacy_id text;
ALTER TABLE tickets ADD COLUMN legacy_number text;
ALTER TABLE tickets ADD COLUMN legacy_type_id text;
ALTER TABLE tickets ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN assigned_user_id uuid REFERENCES users;
ALTER TABLE ticket_replies ADD COLUMN import_id uuid REFERENCES imports;
ALTER TABLE ticket_replies ADD COLUMN legacy_id text;
CREATE TABLE wallet_history (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports,
  legacy_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL,
  amount_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL,
  order_id uuid REFERENCES orders,
  service_id uuid REFERENCES services,
  notes text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(import_id,legacy_id)
);
CREATE TABLE opening_balances (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports,
  user_id uuid NOT NULL REFERENCES users,
  currency text NOT NULL CHECK(currency='CNY'),
  amount_cents bigint NOT NULL CHECK(amount_cents>0),
  created_at timestamptz NOT NULL,
  UNIQUE(import_id,user_id,currency)
);
ALTER TABLE ledger_transactions ADD COLUMN opening_balance_id uuid UNIQUE REFERENCES opening_balances;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_one_source;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id,opening_balance_id)=1);
CREATE FUNCTION opening_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  balance opening_balances%ROWTYPE;
  cash_entries bigint;
  wallet_entries bigint;
  total numeric;
  entries bigint;
BEGIN
  IF NEW.opening_balance_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT balance FROM opening_balances WHERE id=NEW.opening_balance_id;
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='wallet:'||balance.user_id::text AND amount_cents=-balance.amount_cents),
    count(*) FILTER(WHERE account='migration:equity' AND amount_cents=balance.amount_cents)
    INTO entries,total,wallet_entries,cash_entries FROM ledger_entries WHERE transaction_id=NEW.id;
  IF NEW.currency<>balance.currency OR entries<>2 OR total<>0 OR wallet_entries<>1 OR cash_entries<>1 THEN
    RAISE EXCEPTION '期初余额必须使用负债钱包与迁移权益的平衡双分录';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER opening_balanced AFTER INSERT ON ledger_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_balanced();
CREATE TRIGGER immutable_openings BEFORE UPDATE OR DELETE ON opening_balances FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_wallet_history BEFORE UPDATE OR DELETE ON wallet_history FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_imports BEFORE UPDATE OR DELETE ON imports FOR EACH ROW EXECUTE FUNCTION immutable_record();
