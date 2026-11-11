-- 实名申请保留历史，敏感正文与证据加密；OAuth绑定以供应商稳定subject识别身份。
CREATE TABLE certifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('personal','enterprise')),method text NOT NULL DEFAULT 'manual',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 encrypted_details text NOT NULL,masked_name text NOT NULL,masked_document text NOT NULL,document_hash text NOT NULL,
 previous_id uuid REFERENCES certifications,decision_reason text NOT NULL DEFAULT '',review_reference text NOT NULL DEFAULT '',
 decided_by uuid REFERENCES users,decided_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status IN ('pending','withdrawn') OR decided_by IS NOT NULL AND decided_at IS NOT NULL AND length(decision_reason)>=3 AND length(review_reference)>=3)
);
CREATE UNIQUE INDEX one_pending_certification ON certifications(user_id) WHERE status='pending';
CREATE INDEX certifications_user ON certifications(user_id,created_at DESC);
CREATE TABLE certification_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),certification_id uuid NOT NULL REFERENCES certifications,
 name text NOT NULL,media_type text NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_certification_files BEFORE UPDATE OR DELETE ON certification_files FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE oauth_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,provider text NOT NULL,subject text NOT NULL,
 display_name text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(provider,subject),UNIQUE(user_id,provider)
);
CREATE FUNCTION certification_history_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.user_id,NEW.kind,NEW.method,NEW.encrypted_details,NEW.masked_name,NEW.masked_document,NEW.document_hash,NEW.previous_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.user_id,OLD.kind,OLD.method,OLD.encrypted_details,OLD.masked_name,OLD.masked_document,OLD.document_hash,OLD.previous_id,OLD.created_at) OR OLD.status<>'pending' THEN RAISE EXCEPTION '实名认证历史只能追加且结论只能确认一次'; END IF;
 IF NEW.status='approved' AND NOT EXISTS(SELECT 1 FROM certification_files WHERE certification_id=NEW.id) THEN RAISE EXCEPTION '人工核验通过必须有真实证明材料'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER certification_history_fixed BEFORE UPDATE OR DELETE ON certifications FOR EACH ROW EXECUTE FUNCTION certification_history_fixed();
