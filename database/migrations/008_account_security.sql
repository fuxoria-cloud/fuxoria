-- 账号安全：凭据变更通过会话版本撤销全部旧会话，TOTP密钥只保存认证加密后的密文。
-- 执行：npm run db:migrate。TOTP_KEY必须由部署环境独立提供，不写入数据库。
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0 CHECK(session_version>=0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS company text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE users ADD CONSTRAINT users_security_phone_length CHECK(length(phone)<=30);
ALTER TABLE users ADD CONSTRAINT users_security_company_length CHECK(length(company)<=120);
ALTER TABLE users ADD CONSTRAINT users_security_country CHECK(country='' OR country ~ '^[A-Z]{2}$');
ALTER TABLE users ADD CONSTRAINT users_security_address_length CHECK(length(address)<=500);
ALTER TABLE users ADD CONSTRAINT users_security_timezone_length CHECK(length(timezone)<=64);

CREATE TABLE account_security (
  user_id uuid PRIMARY KEY REFERENCES users,
  enabled boolean NOT NULL DEFAULT false,
  secret_ciphertext text,
  pending_ciphertext text,
  pending_until timestamptz,
  last_counter bigint NOT NULL DEFAULT -1 CHECK(last_counter>=-1),
  enabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT enabled OR secret_ciphertext IS NOT NULL),
  CHECK(num_nonnulls(pending_ciphertext,pending_until) IN (0,2)),
  CHECK(secret_ciphertext IS NULL OR secret_ciphertext LIKE 'v1.%'),
  CHECK(pending_ciphertext IS NULL OR pending_ciphertext LIKE 'v1.%')
);
CREATE TABLE account_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  hash text NOT NULL CHECK(hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,hash)
);
CREATE INDEX account_recovery_available ON account_recovery_codes(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
