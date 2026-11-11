-- 3.7.6支持中心：部门、客服分配、内部记录、知识分类、私有文件及站内通知。
CREATE TABLE support_departments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 100),
 description text NOT NULL DEFAULT '',active boolean NOT NULL DEFAULT true,position integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE support_department_members (
 department_id uuid NOT NULL REFERENCES support_departments ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users,PRIMARY KEY(department_id,user_id)
);
ALTER TABLE tickets ADD COLUMN department_id uuid REFERENCES support_departments;
ALTER TABLE tickets ADD COLUMN assigned_to uuid REFERENCES users;
ALTER TABLE tickets ADD COLUMN service_id uuid REFERENCES services;
ALTER TABLE tickets ADD COLUMN merged_into uuid REFERENCES tickets;
ALTER TABLE tickets ADD COLUMN rating integer CHECK(rating BETWEEN 1 AND 5);
ALTER TABLE tickets ADD COLUMN rating_comment text;
ALTER TABLE tickets ADD COLUMN rated_at timestamptz;
ALTER TABLE ticket_replies ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE TABLE support_reply_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 100)
);
CREATE TABLE support_reply_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),category_id uuid REFERENCES support_reply_categories ON DELETE SET NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),message text NOT NULL CHECK(length(message) BETWEEN 1 AND 20000),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE content_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('help','news','page','download')),parent_id uuid REFERENCES content_categories,
 position integer NOT NULL DEFAULT 0,UNIQUE(kind,name)
);
ALTER TABLE articles ADD COLUMN category_id uuid REFERENCES content_categories ON DELETE SET NULL;
CREATE TABLE support_files (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,
 ticket_id uuid REFERENCES tickets,reply_id uuid REFERENCES ticket_replies,internal boolean NOT NULL DEFAULT false,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),media_type text NOT NULL,
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),sha256 text NOT NULL CHECK(length(sha256)=64),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE downloads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),file_id uuid NOT NULL REFERENCES support_files,
 category_id uuid REFERENCES content_categories ON DELETE SET NULL,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 description text NOT NULL DEFAULT '',access text NOT NULL DEFAULT 'account' CHECK(access IN ('public','account','service')),
 product_id uuid REFERENCES products,published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((access='service' AND product_id IS NOT NULL) OR access<>'service')
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),message text NOT NULL CHECK(length(message) BETWEEN 1 AND 20000),
 link text CHECK(link IS NULL OR (link LIKE '/%' AND link NOT LIKE '//%' AND position(E'\\' in link)=0)),
 read_at timestamptz,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tickets_department ON tickets(department_id,updated_at DESC);
CREATE INDEX support_files_ticket ON support_files(ticket_id,created_at);
