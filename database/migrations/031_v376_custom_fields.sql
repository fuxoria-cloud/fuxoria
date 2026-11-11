-- 客户资料/工单自定义字段：权限由主体核对，工单保留创建时定义，变更历史只追加。
CREATE TABLE custom_fields (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope text NOT NULL CHECK(scope IN ('profile','ticket')),
 key text NOT NULL CHECK(key~'^[a-z][a-z0-9_]{0,39}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 description text NOT NULL DEFAULT '',kind text NOT NULL CHECK(kind IN ('text','textarea','select','number','boolean','date')),
 format text NOT NULL DEFAULT 'plain' CHECK(format IN ('plain','email','url','phone','ipv4','domain')),
 options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(options)='array'),required boolean NOT NULL DEFAULT false,
 access text NOT NULL DEFAULT 'customer' CHECK(access IN ('customer','staff','admin')),customer_editable boolean NOT NULL DEFAULT true,
 minimum integer NOT NULL DEFAULT 0,maximum integer NOT NULL DEFAULT 2000 CHECK(maximum>=minimum),
 department_id uuid REFERENCES support_departments,position integer NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(scope,key),
 CHECK(scope='ticket' OR department_id IS NULL),CHECK(kind IN ('text','textarea') OR format='plain')
);
ALTER TABLE users ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN custom_field_revision integer NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN field_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN custom_field_revision integer NOT NULL DEFAULT 0;
CREATE TABLE custom_field_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope text NOT NULL CHECK(scope IN ('profile','ticket')),target_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users,revision integer NOT NULL,values jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope,target_id,revision)
);
CREATE TRIGGER immutable_custom_field_changes BEFORE UPDATE OR DELETE ON custom_field_changes FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE INDEX custom_fields_scope ON custom_fields(scope,department_id,position,id) WHERE active;
