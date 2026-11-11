-- 资源回调：异步供应商确认只改变资源任务，不处理资金支付通知。
-- 执行：npm run db:migrate。waiting与人工核对都阻挡同一服务的后续动作。
ALTER TABLE jobs DROP CONSTRAINT jobs_state_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_state_check CHECK(state IN ('queued','running','waiting','manual_review','succeeded','failed'));
ALTER TABLE jobs ADD COLUMN callback_reference text CHECK(callback_reference IS NULL OR callback_reference ~ '^[0-9a-f]{64}$');
ALTER TABLE jobs ADD COLUMN callback_deadline timestamptz;
ALTER TABLE jobs ADD CONSTRAINT jobs_waiting_reference CHECK(state<>'waiting' OR (callback_reference IS NOT NULL AND callback_deadline IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL));
DROP INDEX jobs_one_running_per_service;
CREATE UNIQUE INDEX jobs_one_running_per_service ON jobs(service_id) WHERE state IN ('running','waiting','manual_review');
CREATE INDEX jobs_callbacks_due ON jobs(callback_deadline) WHERE state='waiting';

CREATE TABLE resource_callbacks (
  provider text NOT NULL,
  nonce text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs,
  body_hash text NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'),
  reference_hash text NOT NULL CHECK(reference_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,nonce)
);
CREATE TRIGGER immutable_resource_callbacks BEFORE UPDATE OR DELETE ON resource_callbacks
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
