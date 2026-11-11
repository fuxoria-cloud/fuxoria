-- 退款申请：原收款金额是唯一可退额度，同收款下的申请串行预留。
-- 执行：npm run db:migrate。此迁移只新增退款记录和反向分录，不修改原收款或原分录。
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES payment_receipts,
  user_id uuid NOT NULL REFERENCES users,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0 AND amount_cents <= 999999999999),
  currency text NOT NULL CHECK(currency = 'CNY'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','processing','succeeded','rejected','failed','manual_review')),
  provider_status text NOT NULL DEFAULT 'not_requested',
  provider_reference text,
  last_error text,
  approved_by uuid REFERENCES users,
  approved_at timestamptz,
  rejected_by uuid REFERENCES users,
  decision_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX refunds_receipt ON refunds(receipt_id);
CREATE INDEX refunds_user ON refunds(user_id,created_at DESC);
CREATE INDEX refunds_pending ON refunds(updated_at) WHERE status IN ('processing','manual_review');

-- 额度约束也放在数据库边界，其他入口不能绕开累计退款限额。
CREATE FUNCTION reserve_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid payment_receipts%ROWTYPE;
  owner_id uuid;
  reserved numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.receipt_id,NEW.user_id,NEW.amount_cents,NEW.currency,NEW.reason,NEW.idempotency_key,NEW.request_hash,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.receipt_id,OLD.user_id,OLD.amount_cents,OLD.currency,OLD.reason,OLD.idempotency_key,OLD.request_hash,OLD.created_at) THEN
      RAISE EXCEPTION '退款申请的原始事实不能修改';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status='requested' AND NEW.status IN ('approved','processing','rejected')) OR
      (OLD.status='approved' AND NEW.status IN ('processing','rejected')) OR
      (OLD.status='processing' AND NEW.status IN ('succeeded','manual_review','failed')) OR
      (OLD.status='manual_review' AND NEW.status IN ('processing','succeeded','failed'))
    ) THEN
      RAISE EXCEPTION '退款状态不能执行此变更';
    END IF;
  END IF;
  SELECT * INTO STRICT paid FROM payment_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  SELECT user_id INTO STRICT owner_id FROM invoices WHERE id=paid.invoice_id;
  IF NEW.user_id<>owner_id OR NEW.currency<>paid.currency THEN
    RAISE EXCEPTION '退款账号或币种与原收款不一致';
  END IF;
  IF NEW.status NOT IN ('rejected','failed') THEN
    SELECT COALESCE(sum(amount_cents),0) INTO reserved FROM refunds
      WHERE receipt_id=NEW.receipt_id AND id<>NEW.id AND status NOT IN ('rejected','failed');
    IF reserved + NEW.amount_cents > paid.amount_cents THEN
      RAISE EXCEPTION '累计退款申请不能超过原收款金额';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reserve_refund BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION reserve_refund();
CREATE TRIGGER immutable_refunds BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION immutable_record();

-- 每次退款有自己的不可变会计事务，原收款事务的唯一约束继续保留。
ALTER TABLE ledger_transactions ALTER COLUMN receipt_id DROP NOT NULL;
ALTER TABLE ledger_transactions ADD COLUMN refund_id uuid UNIQUE REFERENCES refunds;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_one_source CHECK(num_nonnulls(receipt_id,refund_id)=1);

-- 提交时复核退款状态与反向分录，阻止“已退款但没有记账”或“处理中先记已退款”。
CREATE FUNCTION refund_ledger_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  application refunds%ROWTYPE;
  gateway_name text;
  ledger_id uuid;
  transaction_currency text;
  entry_count bigint;
  total numeric;
  cash_count bigint;
  income_count bigint;
BEGIN
  IF TG_TABLE_NAME='refunds' THEN target_id:=NEW.id; ELSE target_id:=NEW.refund_id; END IF;
  IF target_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT application FROM refunds WHERE id=target_id;
  SELECT id,currency INTO ledger_id,transaction_currency FROM ledger_transactions WHERE refund_id=target_id;
  IF application.status<>'succeeded' THEN
    IF ledger_id IS NOT NULL THEN RAISE EXCEPTION '退款未确认成功前不能记反向分录'; END IF;
    RETURN NEW;
  END IF;
  IF ledger_id IS NULL OR transaction_currency<>application.currency THEN
    RAISE EXCEPTION '成功退款必须有同币种的独立会计事务';
  END IF;
  SELECT gateway INTO STRICT gateway_name FROM payment_receipts WHERE id=application.receipt_id;
  SELECT count(*),COALESCE(sum(amount_cents),0),
    count(*) FILTER(WHERE account='cash:'||gateway_name AND amount_cents=-application.amount_cents),
    count(*) FILTER(WHERE account='income:'||application.user_id::text AND amount_cents=application.amount_cents)
    INTO entry_count,total,cash_count,income_count FROM ledger_entries WHERE transaction_id=ledger_id;
  IF entry_count<>2 OR total<>0 OR cash_count<>1 OR income_count<>1 THEN
    RAISE EXCEPTION '退款反向分录的账号或金额不正确';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER refund_has_ledger AFTER INSERT OR UPDATE ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_ledger_complete();
CREATE CONSTRAINT TRIGGER ledger_has_refund AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_ledger_complete();
