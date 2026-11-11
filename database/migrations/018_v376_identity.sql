-- 3.7.6身份能力：客户组、联系人子账户、管理员角色、一次显示的可撤销API密钥。
CREATE TABLE client_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT '#61afef' CHECK(color ~ '^#[0-9a-fA-F]{6}$'),
  discount_percent integer NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
  suspend_exempt boolean NOT NULL DEFAULT false,
  separate_invoices boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=500),
  permissions text[] NOT NULL DEFAULT '{}',
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN client_group_id uuid REFERENCES client_groups ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN admin_role_id uuid REFERENCES admin_roles;
ALTER TABLE users ADD COLUMN admin_notes text NOT NULL DEFAULT '' CHECK(length(admin_notes)<=10000);
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users,
  child_user_id uuid UNIQUE REFERENCES users,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  email text NOT NULL CHECK(length(email)<=254 AND email=lower(email)),
  phone text NOT NULL DEFAULT '' CHECK(length(phone)<=40),
  company text NOT NULL DEFAULT '' CHECK(length(company)<=120),
  address text NOT NULL DEFAULT '' CHECK(length(address)<=500),
  notifications text[] NOT NULL DEFAULT '{}',
  permissions text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(child_user_id IS NULL OR child_user_id<>owner_id)
);
CREATE UNIQUE INDEX contacts_owner_email ON contacts(owner_id,email) WHERE deleted_at IS NULL;
CREATE INDEX contacts_owner ON contacts(owner_id,created_at);
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  prefix text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  session_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_owner ON api_keys(user_id,created_at);
CREATE FUNCTION contact_owner_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.owner_id,NEW.child_user_id) IS DISTINCT FROM ROW(OLD.owner_id,OLD.child_user_id)
     AND OLD.child_user_id IS NOT NULL THEN RAISE EXCEPTION '联系人登录归属创建后不能转给其他账号'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contact_owner_fixed BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION contact_owner_fixed();
