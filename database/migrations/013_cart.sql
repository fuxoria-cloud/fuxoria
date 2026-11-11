-- 购物车与多项订单：一张汇总账单，每行固定成交单价与数量，每件对应独立服务。
-- 执行：npm run db:migrate；旧单项回填后允许一单多项，原收款与退款仍要求正金额。
ALTER TABLE products DROP CONSTRAINT products_price_cents_check;
ALTER TABLE products ADD CONSTRAINT products_price_cents_check CHECK(price_cents>=0 AND price_cents<=999999999999);
ALTER TABLE orders DROP CONSTRAINT orders_amount_cents_check;
ALTER TABLE orders ADD CONSTRAINT orders_amount_cents_check CHECK(amount_cents>=0);
ALTER TABLE invoices DROP CONSTRAINT invoices_amount_cents_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amount_cents_check CHECK(amount_cents>=0);
ALTER TABLE services DROP CONSTRAINT services_renew_amount_cents_check;
ALTER TABLE services ADD CONSTRAINT services_renew_amount_cents_check CHECK(renew_amount_cents IS NULL OR renew_amount_cents>=0);
ALTER TABLE orders ADD COLUMN checkout_revision uuid;
ALTER TABLE orders ADD COLUMN items_explicit boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX orders_checkout_revision ON orders(user_id,checkout_revision) WHERE checkout_revision IS NOT NULL;
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders,
  product_id uuid NOT NULL REFERENCES products,
  product_name text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  period text NOT NULL CHECK(period='month'),
  unit_price_cents bigint NOT NULL CHECK(unit_price_cents>=0),
  amount_cents bigint NOT NULL CHECK(amount_cents=unit_price_cents*quantity),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id,product_id,period)
);
CREATE INDEX order_items_order ON order_items(order_id,id);
INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,created_at)
 SELECT o.id,o.product_id,p.name,1,'month',o.amount_cents,o.amount_cents,o.created_at FROM orders o JOIN products p ON p.id=o.product_id;
ALTER TABLE services ADD COLUMN order_item_id uuid REFERENCES order_items;
ALTER TABLE services ADD COLUMN item_number integer NOT NULL DEFAULT 1 CHECK(item_number BETWEEN 1 AND 20);
UPDATE services s SET order_item_id=i.id FROM order_items i WHERE i.order_id=s.order_id AND i.product_id=s.product_id;
ALTER TABLE services DROP CONSTRAINT services_order_id_key;
CREATE INDEX services_order ON services(order_id,id);
CREATE UNIQUE INDEX services_item_slot ON services(order_item_id,item_number);

-- 现有单项头、续费与严格单项导入保持兼容；purchase明确设置items_explicit并主动写完整明细。
CREATE FUNCTION legacy_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO order_items(order_id,product_id,product_name,quantity,period,unit_price_cents,amount_cents,created_at)
    SELECT NEW.id,NEW.product_id,p.name,1,'month',NEW.amount_cents,NEW.amount_cents,NEW.created_at FROM products p WHERE p.id=NEW.product_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legacy_order_item AFTER INSERT ON orders FOR EACH ROW
 WHEN(NOT NEW.items_explicit) EXECUTE FUNCTION legacy_order_item();

-- CTE内不同写入共享命令快照；归属在提交时补全，避免误读同命令刚创建的成交行。
CREATE FUNCTION service_item_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_service services%ROWTYPE;
  item order_items%ROWTYPE;
  customer_id uuid;
BEGIN
  UPDATE services s SET order_item_id=i.id FROM order_items i
    WHERE s.order_id=NEW.order_id AND s.order_item_id IS NULL
      AND i.order_id=s.order_id AND i.product_id=s.product_id;
  SELECT * INTO STRICT current_service FROM services WHERE id=NEW.id;
  SELECT * INTO item FROM order_items WHERE id=current_service.order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION '服务无法找到对应的真实成交项'; END IF;
  SELECT user_id INTO STRICT customer_id FROM orders WHERE id=item.order_id;
  IF current_service.order_id<>item.order_id OR current_service.product_id<>item.product_id
     OR current_service.user_id<>customer_id OR current_service.item_number>item.quantity THEN
    RAISE EXCEPTION '服务必须属于对应客户订单的真实成交项';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER service_item_binding AFTER INSERT ON services
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_item_binding();
CREATE FUNCTION service_item_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.order_id,NEW.product_id,NEW.user_id,NEW.item_number)
       IS DISTINCT FROM ROW(OLD.order_id,OLD.product_id,OLD.user_id,OLD.item_number)
     OR (OLD.order_item_id IS NOT NULL AND NEW.order_item_id IS DISTINCT FROM OLD.order_item_id) THEN
    RAISE EXCEPTION '服务的成交归属创建后不能修改';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER service_item_identity BEFORE UPDATE OF order_id,product_id,user_id,order_item_id,item_number
 ON services FOR EACH ROW EXECUTE FUNCTION service_item_identity();
CREATE TRIGGER immutable_order_items BEFORE UPDATE OR DELETE ON order_items
 FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- 汇总金额和每件服务数量在提交时核对，避免出现半张账单或少开资源。
CREATE FUNCTION order_items_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  purchase orders%ROWTYPE;
  total numeric;
  lines bigint;
BEGIN
  IF TG_TABLE_NAME='orders' THEN target_id:=NEW.id;
  ELSIF TG_OP='DELETE' THEN target_id:=OLD.order_id;
  ELSE target_id:=NEW.order_id;
  END IF;
  SELECT * INTO STRICT purchase FROM orders WHERE id=target_id;
  SELECT count(*),COALESCE(sum(amount_cents),0) INTO lines,total FROM order_items WHERE order_id=target_id;
  IF lines=0 OR total<>purchase.amount_cents THEN RAISE EXCEPTION '订单总额必须等于全部成交项金额'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER order_items_complete AFTER INSERT OR UPDATE OF amount_cents ON orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_items_complete();
CREATE CONSTRAINT TRIGGER order_item_total AFTER INSERT ON order_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION order_items_complete();
CREATE FUNCTION service_items_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN target_id:=OLD.order_id; ELSE target_id:=NEW.order_id; END IF;
  IF EXISTS(SELECT 1 FROM orders WHERE id=target_id AND kind='new') AND EXISTS(
    SELECT 1 FROM order_items i WHERE i.order_id=target_id
      AND i.quantity<>(SELECT count(*) FROM services s WHERE s.order_item_id=i.id)
  ) THEN RAISE EXCEPTION '新购每件成交数量必须有对应的独立服务'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER service_item_count AFTER INSERT OR DELETE ON services
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_items_complete();
