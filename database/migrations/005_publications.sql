-- 公共内容的差异发布：同一路径只保留最新修订，发布器成功后推进published_revision。
CREATE TABLE publications (
  path text PRIMARY KEY CHECK(path ~ '^/(news|help|page)/[a-z0-9][a-z0-9-]{0,99}$'),
  revision bigint NOT NULL DEFAULT 1,
  published_revision bigint NOT NULL DEFAULT 0,
  content_hash text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
