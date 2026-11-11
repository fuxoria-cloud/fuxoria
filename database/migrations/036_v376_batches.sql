-- 批量续费：用户命令持久化，逐项复用单服务幂等续费，进程退出后可从租约恢复。
CREATE TABLE renewal_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),session_version integer NOT NULL,
 idempotency_key text NOT NULL,request_hash text NOT NULL,items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','cancelled')),
 results jsonb NOT NULL DEFAULT '[]',lease_token uuid,lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key),CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX renewal_batches_queue ON renewal_batches(status,lease_until,created_at);
CREATE FUNCTION renewal_batch_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '批量续费记录保留历史'; END IF;
 IF (NEW.user_id,NEW.session_version,NEW.idempotency_key,NEW.request_hash,NEW.items,NEW.created_at) IS DISTINCT FROM
 (OLD.user_id,OLD.session_version,OLD.idempotency_key,OLD.request_hash,OLD.items,OLD.created_at)
 OR (OLD.status IN ('completed','cancelled') AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION '批量续费原始命令与终态不能覆盖'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER renewal_batch_identity BEFORE UPDATE OR DELETE ON renewal_batches FOR EACH ROW EXECUTE FUNCTION renewal_batch_identity();
