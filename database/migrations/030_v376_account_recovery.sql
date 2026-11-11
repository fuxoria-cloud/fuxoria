-- 手机主账号不生成虚构邮箱；登录、验证注册与找回使用一次性摘要挑战。
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT account_has_verified_identity CHECK(email IS NOT NULL OR phone_verified_at IS NOT NULL);
CREATE TABLE account_challenges (
 id uuid PRIMARY KEY,user_id uuid REFERENCES users,purpose text NOT NULL CHECK(purpose IN ('login','register','reset')),
 channel text NOT NULL CHECK(channel IN ('email','sms')),destination text NOT NULL CHECK(length(destination) BETWEEN 3 AND 254),
 session_version integer,code_hash text NOT NULL CHECK(length(code_hash)=64),ip_hash text NOT NULL CHECK(length(ip_hash)=64),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',sent_at timestamptz,consumed_at timestamptz,
 CHECK((user_id IS NULL)=(session_version IS NULL)),CHECK(purpose<>'login' OR channel='sms')
);
CREATE INDEX account_challenge_destination ON account_challenges(destination,created_at DESC);
CREATE INDEX account_challenge_ip ON account_challenges(ip_hash,created_at DESC);
