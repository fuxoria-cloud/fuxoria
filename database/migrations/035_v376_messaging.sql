-- 模板、批量通知与关怀：意图先入持久队列，外部结果未知不自动冒充成功或盲目重发。
CREATE TABLE message_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 channel text NOT NULL CHECK(channel IN ('site','email','sms')),category text NOT NULL CHECK(category IN ('transactional','marketing')),
 scope text NOT NULL DEFAULT 'account' CHECK(scope IN ('account','service')),subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 160),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),link text,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE message_preferences (
 user_id uuid PRIMARY KEY REFERENCES users,email_marketing boolean NOT NULL DEFAULT false,sms_marketing boolean NOT NULL DEFAULT false,
 site_marketing boolean NOT NULL DEFAULT false,quiet_enabled boolean NOT NULL DEFAULT false,
 quiet_start integer NOT NULL DEFAULT 1260 CHECK(quiet_start BETWEEN 0 AND 1439),quiet_end integer NOT NULL DEFAULT 480 CHECK(quiet_end BETWEEN 0 AND 1439),
 updated_at timestamptz NOT NULL DEFAULT now(),CHECK(NOT quiet_enabled OR quiet_start<>quiet_end)
);
CREATE TABLE message_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),template_id uuid NOT NULL REFERENCES message_templates,created_by uuid NOT NULL REFERENCES users,
 idempotency_key text NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(created_by,idempotency_key)
);
CREATE TABLE client_care_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),template_id uuid NOT NULL REFERENCES message_templates,
 trigger text NOT NULL CHECK(trigger IN ('registered_days','inactive_days','service_created_days','service_due_days','service_overdue_days')),
 days integer NOT NULL CHECK(days BETWEEN 0 AND 365),product_ids uuid[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),last_checked_at timestamptz
);
CREATE TABLE message_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid REFERENCES message_batches,rule_id uuid REFERENCES client_care_rules,
 user_id uuid NOT NULL REFERENCES users,template_id uuid NOT NULL REFERENCES message_templates,
 channel text NOT NULL CHECK(channel IN ('site','email','sms')),category text NOT NULL CHECK(category IN ('transactional','marketing')),
 subject text NOT NULL,body text NOT NULL,link text,destination text,service_id uuid REFERENCES services,service_due_at timestamptz,
 dedup_key text NOT NULL UNIQUE,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','sent','failed','uncertain','skipped','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
 run_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,last_error text,sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX message_jobs_ready ON message_jobs(run_at,id) WHERE state='queued';
CREATE INDEX message_jobs_batch ON message_jobs(batch_id,state);
CREATE INDEX message_jobs_user ON message_jobs(user_id,created_at DESC);
CREATE INDEX message_jobs_running ON message_jobs(lease_until) WHERE state='running';
