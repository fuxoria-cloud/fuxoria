-- 3.7.6商品分组、周期、配置与优惠：报价只用整数分，成交与续费保存自己的合同快照。
CREATE TABLE product_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),parent_id uuid REFERENCES product_groups,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),description text NOT NULL DEFAULT '',
 sort integer NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_groups_parent ON product_groups(parent_id,sort,id);
ALTER TABLE products ADD COLUMN group_id uuid REFERENCES product_groups;
CREATE INDEX products_group ON products(group_id,id);
CREATE TABLE product_periods (
 product_id uuid NOT NULL REFERENCES products,period text NOT NULL,
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 0 AND 999999999999),
 setup_cents bigint NOT NULL DEFAULT 0 CHECK(setup_cents BETWEEN 0 AND 999999999999),
 active boolean NOT NULL DEFAULT true,PRIMARY KEY(product_id,period),
 CHECK(period IN ('month','quarter','halfyear','year','biennium','triennium','onetime'))
);
CREATE TABLE product_options (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid NOT NULL REFERENCES products,
 key text NOT NULL CHECK(key~'^[a-z][a-z0-9_]{0,39}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('select','quantity','boolean')),required boolean NOT NULL DEFAULT true,
 minimum integer NOT NULL DEFAULT 0 CHECK(minimum>=0),maximum integer NOT NULL DEFAULT 100 CHECK(maximum>=minimum AND maximum<=100000),
 prices jsonb NOT NULL DEFAULT '{}',setup_cents bigint NOT NULL DEFAULT 0 CHECK(setup_cents>=0),
 choices jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(choices)='array'),sort integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true,UNIQUE(product_id,key)
);
CREATE TABLE promotions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE CHECK(code=upper(code) AND code~'^[A-Z0-9_-]{3,40}$'),
 name text NOT NULL,kind text NOT NULL CHECK(kind IN ('percent','fixed','override','free')),
 value bigint NOT NULL CHECK(value BETWEEN 0 AND 999999999999),recurring boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,starts_at timestamptz,ends_at timestamptz,
 max_uses integer CHECK(max_uses>0),per_user_limit integer CHECK(per_user_limit>0),
 minimum_cents bigint NOT NULL DEFAULT 0 CHECK(minimum_cents>=0),product_ids uuid[] NOT NULL DEFAULT '{}',
 periods text[] NOT NULL DEFAULT '{}',first_order_only boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at),
 CHECK(kind<>'percent' OR value<=10000)
);
CREATE TABLE promotion_uses (
 promotion_id uuid NOT NULL REFERENCES promotions,order_id uuid NOT NULL UNIQUE REFERENCES orders,
 user_id uuid NOT NULL REFERENCES users,discount_cents bigint NOT NULL CHECK(discount_cents>=0),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(promotion_id,order_id)
);
CREATE TRIGGER immutable_promotion_uses BEFORE UPDATE OR DELETE ON promotion_uses FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE INDEX promotion_uses_customer ON promotion_uses(promotion_id,user_id,order_id);
ALTER TABLE orders ADD COLUMN promotion_id uuid REFERENCES promotions;
ALTER TABLE orders ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK(discount_cents>=0);
ALTER TABLE order_items DROP CONSTRAINT order_items_period_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_period_check CHECK(period IN ('month','quarter','halfyear','year','biennium','triennium','onetime'));
ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_product_id_period_key;
ALTER TABLE order_items ADD COLUMN line_key text NOT NULL DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX order_items_line ON order_items(order_id,line_key);
ALTER TABLE order_items ADD COLUMN original_unit_price_cents bigint CHECK(original_unit_price_cents IS NULL OR original_unit_price_cents>=0);
ALTER TABLE order_items ADD COLUMN setup_cents bigint NOT NULL DEFAULT 0 CHECK(setup_cents>=0);
ALTER TABLE order_items ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK(discount_cents>=0);
ALTER TABLE order_items ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN configuration_labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE order_items ADD COLUMN billing_months integer NOT NULL DEFAULT 1 CHECK(billing_months IN (0,1,3,6,12,24,36));
ALTER TABLE order_items ADD CONSTRAINT item_discount_snapshot CHECK(original_unit_price_cents IS NULL OR original_unit_price_cents=unit_price_cents+discount_cents);
ALTER TABLE order_items ADD CONSTRAINT item_period_months CHECK(billing_months=CASE period WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'halfyear' THEN 6 WHEN 'year' THEN 12 WHEN 'biennium' THEN 24 WHEN 'triennium' THEN 36 ELSE 0 END);
ALTER TABLE services ADD COLUMN billing_period text NOT NULL DEFAULT 'month' CHECK(billing_period IN ('month','quarter','halfyear','year','biennium','triennium','onetime'));
ALTER TABLE services ADD COLUMN billing_months integer NOT NULL DEFAULT 1 CHECK(billing_months IN (0,1,3,6,12,24,36));
ALTER TABLE services ADD CONSTRAINT service_period_months CHECK(billing_months=CASE billing_period WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'halfyear' THEN 6 WHEN 'year' THEN 12 WHEN 'biennium' THEN 24 WHEN 'triennium' THEN 36 ELSE 0 END);
ALTER TABLE services ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
ALTER TABLE services ADD COLUMN configuration_labels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE renewals ADD COLUMN period_months integer NOT NULL DEFAULT 1 CHECK(period_months IN (1,3,6,12,24,36));
CREATE OR REPLACE FUNCTION legacy_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,created_at,line_key,original_unit_price_cents)
 SELECT NEW.id,NEW.product_id,p.name,1,'month',NEW.amount_cents,NEW.amount_cents,NEW.created_at,
 encode(sha256(convert_to(NEW.product_id::text||':month:{}','UTF8')),'hex'),NEW.amount_cents FROM products p WHERE p.id=NEW.product_id;
 RETURN NEW;
END;
$$;

-- 折扣是成交事实：订单头、明细和优惠占额在同一次提交中互相核对。
CREATE FUNCTION catalogue_discount_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; purchase orders%ROWTYPE; actual numeric;
BEGIN
 IF TG_TABLE_NAME='orders' THEN target_id:=NEW.id; ELSE target_id:=NEW.order_id; END IF;
 SELECT * INTO STRICT purchase FROM orders WHERE id=target_id;
 SELECT COALESCE(sum(discount_cents*quantity),0) INTO actual FROM order_items WHERE order_id=target_id;
 IF actual<>purchase.discount_cents THEN RAISE EXCEPTION '订单优惠总额必须等于成交项优惠'; END IF;
 IF purchase.promotion_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM promotion_uses WHERE order_id=target_id AND promotion_id=purchase.promotion_id AND discount_cents<=purchase.discount_cents) THEN RAISE EXCEPTION '优惠订单必须有同事务保存的真实占额'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_discount_complete AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalogue_discount_complete();
CREATE CONSTRAINT TRIGGER item_discount_complete AFTER INSERT ON order_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalogue_discount_complete();
CREATE CONSTRAINT TRIGGER promotion_discount_complete AFTER INSERT ON promotion_uses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalogue_discount_complete();
CREATE FUNCTION catalogue_discount_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.promotion_id,NEW.discount_cents) IS DISTINCT FROM ROW(OLD.promotion_id,OLD.discount_cents) THEN RAISE EXCEPTION '成交优惠只能在创建订单时确定'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER catalogue_discount_fixed BEFORE UPDATE OF promotion_id,discount_cents ON orders FOR EACH ROW EXECUTE FUNCTION catalogue_discount_fixed();
