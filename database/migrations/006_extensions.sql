-- 业务与开通插件的运行发现信息：每个Go节点保留自身公开能力和最近心跳，不保存凭据。
CREATE TABLE agent_presence (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  plugins jsonb NOT NULL CHECK(jsonb_typeof(plugins)='array'),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
