-- 在线资源模块：任务载荷与私有结果使用独立RESOURCE_KEY，不保存供应商任意HTML。
-- 调用：npm run db:migrate；能力来自90秒内实际运行节点，执行仍检查租约与当前归属。
ALTER TABLE jobs DROP CONSTRAINT jobs_action_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_action_check CHECK(action IN ('provision','suspend','resume','terminate','renew','upgrade','resource'));
CREATE TABLE resource_requests (
 job_id uuid PRIMARY KEY REFERENCES jobs(id),service_id uuid NOT NULL REFERENCES services(id),
 user_id uuid NOT NULL REFERENCES users(id),actor_id uuid NOT NULL REFERENCES users(id),actor_version integer NOT NULL,api_key_id uuid REFERENCES api_keys(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 100),request_hash text NOT NULL CHECK(length(request_hash)=64),
 operation text NOT NULL CHECK(operation IN ('action','inspect','metrics','console','credentials')),
 action_id text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,idempotency_key)
);
CREATE INDEX resource_requests_service ON resource_requests(service_id,created_at DESC);
CREATE TABLE resource_private_outputs (
 job_id uuid PRIMARY KEY REFERENCES resource_requests(job_id),ciphertext text NOT NULL CHECK(ciphertext ~ '^v1\.' AND length(ciphertext)<=100000),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revealed_at timestamptz
);
CREATE FUNCTION protect_resource_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION '资源授权记录只追加'; END $$;
CREATE TRIGGER resource_request_history BEFORE UPDATE OR DELETE ON resource_requests FOR EACH ROW EXECUTE FUNCTION protect_resource_request();
CREATE FUNCTION protect_resource_private() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.job_id,NEW.ciphertext,NEW.expires_at,NEW.created_at) IS DISTINCT FROM (OLD.job_id,OLD.ciphertext,OLD.expires_at,OLD.created_at)
 OR OLD.revealed_at IS NOT NULL OR NEW.revealed_at IS NULL THEN RAISE EXCEPTION '资源私有结果不能重写'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER resource_private_history BEFORE UPDATE OR DELETE ON resource_private_outputs FOR EACH ROW EXECUTE FUNCTION protect_resource_private();
CREATE FUNCTION resource_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE j jobs; r resource_requests; BEGIN
 IF TG_TABLE_NAME='resource_requests' THEN SELECT * INTO j FROM jobs WHERE id=NEW.job_id; ELSE SELECT * INTO j FROM jobs WHERE id=NEW.id; END IF;
 IF j.action<>'resource' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM resource_requests WHERE job_id=j.id;
 IF r.job_id IS NULL OR r.service_id<>j.service_id OR j.payload->>'operation' IS DISTINCT FROM r.operation
 OR j.payload->>'actionId' IS DISTINCT FROM r.action_id OR COALESCE(j.payload->>'encryptedInput','') !~ '^v1\.'
 OR j.payload ? 'input' OR NOT(j.payload ? 'capability') THEN RAISE EXCEPTION '资源任务必须关联加密授权'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER resource_job_authorized AFTER INSERT OR UPDATE ON jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_job_guard();
CREATE CONSTRAINT TRIGGER resource_request_job AFTER INSERT ON resource_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION resource_job_guard();

CREATE INDEX audit_customer_activity ON audit(target,id DESC) INCLUDE(action,created_at,actor);
