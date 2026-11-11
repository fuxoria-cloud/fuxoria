-- 服务生命周期：归属转移保留原始购货方；取消申请经批准后才排真实终止任务。
-- 调用：npm run db:migrate。审批、排队和审计由同一事务保存。
ALTER TABLE services ADD COLUMN current_owner_id uuid REFERENCES users(id);
ALTER TABLE services ADD COLUMN remark text NOT NULL DEFAULT '' CHECK(length(remark)<=1000);
ALTER TABLE services ADD COLUMN auto_renew boolean NOT NULL DEFAULT false;
CREATE INDEX services_current_owner ON services ((COALESCE(current_owner_id,user_id)),created_at DESC);
CREATE TABLE service_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),sort integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,name)
);
ALTER TABLE services ADD COLUMN group_id uuid REFERENCES service_groups(id) ON DELETE SET NULL;
CREATE TABLE service_cancellations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_id uuid NOT NULL REFERENCES services(id),
 user_id uuid NOT NULL REFERENCES users(id),mode text NOT NULL CHECK(mode IN ('immediate','end_of_period')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','executing','executed','rejected','withdrawn')),
 decision_reason text NOT NULL DEFAULT '',decided_by uuid REFERENCES users(id),decided_at timestamptz,
 execute_at timestamptz,job_id uuid REFERENCES jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_service_cancellation ON service_cancellations(service_id) WHERE status IN ('pending','approved','executing');
CREATE INDEX service_cancellation_due ON service_cancellations(execute_at) WHERE status='approved';
CREATE TABLE service_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),service_id uuid NOT NULL REFERENCES services(id),
 sender_id uuid NOT NULL REFERENCES users(id),recipient_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled','expired')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 CHECK(sender_id<>recipient_id),CHECK((status='pending')=(completed_at IS NULL))
);
CREATE UNIQUE INDEX one_service_transfer ON service_transfers(service_id) WHERE status='pending';
CREATE INDEX service_transfers_parties ON service_transfers(recipient_id,created_at DESC);
CREATE TABLE auto_renew_attempts (
 service_id uuid NOT NULL REFERENCES services(id),owner_id uuid NOT NULL REFERENCES users(id),
 due_at timestamptz NOT NULL,invoice_id uuid NOT NULL REFERENCES invoices(id),
 last_error text,notified_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(service_id,owner_id,due_at)
);
CREATE FUNCTION protect_service_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '服务转移记录不能删除'; END IF;
 IF (NEW.service_id,NEW.sender_id,NEW.recipient_id,NEW.expires_at,NEW.created_at) IS DISTINCT FROM
    (OLD.service_id,OLD.sender_id,OLD.recipient_id,OLD.expires_at,OLD.created_at) OR OLD.status<>'pending' THEN
  RAISE EXCEPTION '已保存的转移事实不能重写';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_transfer_history BEFORE UPDATE OR DELETE ON service_transfers FOR EACH ROW EXECUTE FUNCTION protect_service_transfer();
CREATE FUNCTION protect_service_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '取消申请不能删除'; END IF;
 IF (NEW.service_id,NEW.user_id,NEW.mode,NEW.reason,NEW.created_at) IS DISTINCT FROM
    (OLD.service_id,OLD.user_id,OLD.mode,OLD.reason,OLD.created_at) OR OLD.status IN ('executed','rejected','withdrawn') THEN
  RAISE EXCEPTION '取消申请历史不能重写';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER service_cancellation_history BEFORE UPDATE OR DELETE ON service_cancellations FOR EACH ROW EXECUTE FUNCTION protect_service_cancellation();
