-- 3.7.6合同与开票：文本/抬头以申请时快照保留，签署与处理只推进状态并记录审计。
CREATE TABLE contract_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, content text NOT NULL,
 product_ids uuid[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 user_id uuid NOT NULL REFERENCES users, template_id uuid NOT NULL REFERENCES contract_templates,
 service_id uuid REFERENCES services, snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','signed','cancelled','voided')),
 signer text, signed_at timestamptz, sign_ip text, void_reason text,
 idempotency_key text NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key), CHECK((status IN('signed','voided'))=(signed_at IS NOT NULL))
);
CREATE INDEX contracts_customer ON contracts(user_id,created_at DESC);
CREATE UNIQUE INDEX contracts_one_active ON contracts(user_id,template_id,service_id) NULLS NOT DISTINCT WHERE status IN('pending','signed');
CREATE FUNCTION contract_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '合同记录保留历史，不能删除'; END IF;
 IF ROW(NEW.user_id,NEW.template_id,NEW.service_id,NEW.snapshot,NEW.snapshot_hash,NEW.idempotency_key,NEW.request_hash)
 IS DISTINCT FROM ROW(OLD.user_id,OLD.template_id,OLD.service_id,OLD.snapshot,OLD.snapshot_hash,OLD.idempotency_key,OLD.request_hash)
 OR (OLD.signed_at IS NOT NULL AND ROW(NEW.signer,NEW.signed_at,NEW.sign_ip) IS DISTINCT FROM ROW(OLD.signer,OLD.signed_at,OLD.sign_ip)) THEN
 RAISE EXCEPTION '合同快照与已保存的签署事实不能覆盖'; END IF;
 IF OLD.status IN('cancelled','voided') AND NEW.status<>OLD.status THEN RAISE EXCEPTION '已结束合同不能重新激活'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER contract_snapshot_immutable BEFORE UPDATE OR DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION contract_snapshot_immutable();
CREATE TABLE tax_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 title text NOT NULL, type text NOT NULL CHECK(type IN('person','company')), tax_number text NOT NULL DEFAULT '',
 invoice_type text NOT NULL CHECK(invoice_type IN('ordinary','special')), bank text NOT NULL DEFAULT '',
 bank_account text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
 email text NOT NULL, shipping_address text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tax_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 user_id uuid NOT NULL REFERENCES users, profile jsonb NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL DEFAULT 'CNY', status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','issued','rejected','cancelled')),
 note text NOT NULL DEFAULT '', invoice_number text, document_url text, tracking_number text, decision_reason text,
 handled_by uuid REFERENCES users, issued_at timestamptz, idempotency_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key),
 CHECK((status='issued')=(issued_at IS NOT NULL)), CHECK(status<>'issued' OR length(invoice_number)>0)
);
CREATE TABLE tax_request_invoices (
 request_id uuid NOT NULL REFERENCES tax_requests, invoice_id uuid NOT NULL REFERENCES invoices,
 amount_cents bigint NOT NULL CHECK(amount_cents>0), PRIMARY KEY(request_id,invoice_id)
);
CREATE INDEX tax_requests_customer ON tax_requests(user_id,created_at DESC);
CREATE TRIGGER immutable_tax_lines BEFORE UPDATE OR DELETE ON tax_request_invoices FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION tax_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.user_id,NEW.profile,NEW.amount_cents,NEW.currency,NEW.idempotency_key,NEW.request_hash)
 IS DISTINCT FROM ROW(OLD.user_id,OLD.profile,OLD.amount_cents,OLD.currency,OLD.idempotency_key,OLD.request_hash)
 OR (OLD.status IN('issued','rejected','cancelled') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION '开票申请快照与终态不能覆盖'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER tax_snapshot_immutable BEFORE UPDATE ON tax_requests FOR EACH ROW EXECUTE FUNCTION tax_snapshot_immutable();
