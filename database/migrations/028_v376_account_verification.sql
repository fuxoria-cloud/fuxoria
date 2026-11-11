-- 邮箱/手机验证：验证码仅保存带外置密钥的摘要，已验证手机号全局唯一。
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
CREATE UNIQUE INDEX unique_verified_phone ON users(phone) WHERE phone_verified_at IS NOT NULL;
ALTER TABLE users ADD CONSTRAINT verified_phone_canonical CHECK(phone_verified_at IS NULL OR phone~'^\+[1-9][0-9]{6,14}$');
CREATE TABLE verification_challenges (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users,channel text NOT NULL CHECK(channel IN ('email','sms')),
 destination text NOT NULL CHECK(length(destination) BETWEEN 3 AND 254),code_hash text NOT NULL CHECK(length(code_hash)=64),
 session_version integer NOT NULL,ip_hash text NOT NULL CHECK(length(ip_hash)=64),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 sent_at timestamptz,consumed_at timestamptz
);
CREATE INDEX verification_rate_user ON verification_challenges(user_id,created_at DESC);
CREATE INDEX verification_rate_destination ON verification_challenges(destination,created_at DESC);
CREATE INDEX verification_rate_ip ON verification_challenges(ip_hash,created_at DESC);
