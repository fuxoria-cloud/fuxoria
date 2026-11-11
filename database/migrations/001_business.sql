-- 云奏业务数据：npm run db:migrate 自动按文件名顺序执行，每个文件只执行一次。
-- 金额以分保存；约束在数据库里守住资金、库存、幂等和任务租约的边界。
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK(email = lower(email)),
  name text NOT NULL,
  password text NOT NULL,
  role text NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin','support')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents bigint NOT NULL CHECK(price_cents > 0 AND price_cents <= 999999999999),
  currency text NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
  stock integer CHECK(stock >= 0),
  provider text NOT NULL DEFAULT 'manual',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  product_id uuid NOT NULL REFERENCES products,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0),
  currency text NOT NULL DEFAULT 'CNY',
  kind text NOT NULL DEFAULT 'new' CHECK(kind IN ('new','renew')),
  status text NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key)
);
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders,
  user_id uuid NOT NULL REFERENCES users,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0),
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid','cancelled')),
  due_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  product_id uuid NOT NULL REFERENCES products,
  order_id uuid NOT NULL UNIQUE REFERENCES orders,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','provisioning','active','suspended','cancelled','failed')),
  due_at timestamptz,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE renewals (
  order_id uuid PRIMARY KEY REFERENCES orders,
  service_id uuid NOT NULL REFERENCES services
);
CREATE TABLE payment_attempts (
  invoice_id uuid NOT NULL REFERENCES invoices,
  gateway text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(invoice_id,gateway)
);
CREATE TABLE payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices,
  gateway text NOT NULL,
  transaction_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(gateway,transaction_id),
  FOREIGN KEY(invoice_id,gateway) REFERENCES payment_attempts(invoice_id,gateway)
);
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL UNIQUE REFERENCES payment_receipts,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions,
  account text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) < 2 OR COALESCE(sum(amount_cents),0) <> 0
      FROM ledger_entries WHERE transaction_id=NEW.transaction_id) THEN
    RAISE EXCEPTION '账本借贷不平衡';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '资金及审计记录只能追加';
END;
$$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_transactions BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_receipts BEFORE UPDATE OR DELETE ON payment_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES services,
  action text NOT NULL CHECK(action IN ('provision','suspend','resume','terminate','renew')),
  provider text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedup_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs(run_at) WHERE state IN ('queued','running');
CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  subject text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','low')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ticket_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets,
  user_id uuid NOT NULL REFERENCES users,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  content text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('news','help','page')),
  published boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  details jsonb NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE INDEX invoices_user ON invoices(user_id,created_at DESC);
CREATE INDEX services_user ON services(user_id,created_at DESC);
CREATE INDEX tickets_user ON tickets(user_id,updated_at DESC);
CREATE INDEX orders_user ON orders(user_id,created_at DESC);
