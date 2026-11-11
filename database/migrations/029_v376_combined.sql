-- 合并支付：保留子账单和成交快照，用一笔父单收款作为子账单的真实支付来源。
ALTER TABLE orders DROP CONSTRAINT orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK(kind IN('new','renew','recharge','upgrade','credit_repayment','combined'));
CREATE TABLE combined_invoices (
 parent_invoice_id uuid PRIMARY KEY REFERENCES invoices(id),user_id uuid NOT NULL REFERENCES users(id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','paid','cancelled')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE combined_invoice_items (
 parent_invoice_id uuid NOT NULL REFERENCES combined_invoices,invoice_id uuid NOT NULL REFERENCES invoices,
 amount_cents bigint NOT NULL CHECK(amount_cents>0),position integer NOT NULL CHECK(position BETWEEN 1 AND 50),
 locked boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(parent_invoice_id,invoice_id),UNIQUE(parent_invoice_id,position),CHECK(parent_invoice_id<>invoice_id)
);
CREATE UNIQUE INDEX combined_child_locked ON combined_invoice_items(invoice_id) WHERE locked;
CREATE FUNCTION combined_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '合并账单和子单关系保留历史'; END IF;
 IF TG_TABLE_NAME='combined_invoices' THEN
  IF OLD.status<>'pending' OR ROW(NEW.parent_invoice_id,NEW.user_id,NEW.amount_cents,NEW.currency,NEW.created_at) IS DISTINCT FROM ROW(OLD.parent_invoice_id,OLD.user_id,OLD.amount_cents,OLD.currency,OLD.created_at) THEN RAISE EXCEPTION '已处理合并账单和原始金额不能覆盖'; END IF;
 ELSE
  IF ROW(NEW.parent_invoice_id,NEW.invoice_id,NEW.amount_cents,NEW.position,NEW.created_at) IS DISTINCT FROM ROW(OLD.parent_invoice_id,OLD.invoice_id,OLD.amount_cents,OLD.position,OLD.created_at) OR NOT OLD.locked OR NEW.locked OR NOT EXISTS(SELECT 1 FROM combined_invoices g WHERE g.parent_invoice_id=NEW.parent_invoice_id AND g.status='cancelled') THEN RAISE EXCEPTION '合并关系只可在取消父单时解除锁定'; END IF;
 END IF;RETURN NEW;
END; $$;
CREATE TRIGGER combined_fixed BEFORE UPDATE OR DELETE ON combined_invoices FOR EACH ROW EXECUTE FUNCTION combined_fixed();
CREATE TRIGGER combined_item_fixed BEFORE UPDATE OR DELETE ON combined_invoice_items FOR EACH ROW EXECUTE FUNCTION combined_fixed();
CREATE FUNCTION combined_child_protected() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='orders' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status<>'cancelled' THEN RETURN NEW; END IF;
  SELECT i.id INTO target FROM invoices i WHERE i.order_id=NEW.id;
 ELSE target:=NEW.invoice_id; END IF;
 IF EXISTS(SELECT 1 FROM combined_invoice_items item WHERE item.invoice_id=target AND item.locked) THEN RAISE EXCEPTION '子账单已合并，请从合并父单付款或取消未发起付款的父单'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER combined_child_attempt BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE TRIGGER combined_child_receipt BEFORE INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE TRIGGER combined_child_wallet BEFORE INSERT ON wallet_payments FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE TRIGGER combined_child_credit BEFORE INSERT ON credit_payments FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE TRIGGER combined_child_tax BEFORE INSERT ON tax_request_invoices FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE TRIGGER combined_child_order BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION combined_child_protected();
CREATE FUNCTION combined_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; g combined_invoices%ROWTYPE; bill invoices%ROWTYPE; item_count bigint; total numeric;
BEGIN
 IF TG_TABLE_NAME='combined_invoices' OR TG_TABLE_NAME='combined_invoice_items' THEN target:=NEW.parent_invoice_id;
 ELSIF TG_TABLE_NAME='orders' THEN SELECT parent_invoice_id INTO target FROM combined_invoices x JOIN invoices b ON b.id=x.parent_invoice_id WHERE b.order_id=NEW.id;
 ELSE
  SELECT COALESCE((SELECT parent_invoice_id FROM combined_invoices WHERE parent_invoice_id=NEW.id),(SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=NEW.id AND locked)) INTO target;
 END IF;
 IF target IS NULL THEN RETURN NEW; END IF; SELECT * INTO STRICT g FROM combined_invoices WHERE parent_invoice_id=target;SELECT * INTO STRICT bill FROM invoices WHERE id=target;
 SELECT count(*),COALESCE(sum(amount_cents),0) INTO item_count,total FROM combined_invoice_items WHERE parent_invoice_id=target;
 IF item_count<2 OR item_count>50 OR total<>g.amount_cents OR bill.amount_cents<>g.amount_cents OR bill.user_id<>g.user_id OR bill.currency<>g.currency OR NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=bill.order_id AND o.kind='combined' AND o.user_id=g.user_id AND o.amount_cents=g.amount_cents AND o.status=bill.status) THEN RAISE EXCEPTION '合并父单必须与本人同币种子单金额及原始订单一致'; END IF;
 IF EXISTS(SELECT 1 FROM combined_invoice_items x JOIN invoices child ON child.id=x.invoice_id JOIN orders o ON o.id=child.order_id WHERE x.parent_invoice_id=target AND (child.user_id<>g.user_id OR child.currency<>g.currency OR child.amount_cents<>x.amount_cents OR o.kind NOT IN('new','renew','upgrade') OR x.locked<>(g.status<>'cancelled') OR (g.status='pending' AND (child.status<>'unpaid' OR o.status<>'unpaid')) OR (g.status='paid' AND (child.status<>'paid' OR o.status<>'paid')))) THEN RAISE EXCEPTION '合并子账单必须保留原金额、归属和一致付款状态'; END IF;
 IF (g.status='pending' AND bill.status<>'unpaid') OR (g.status='paid' AND bill.status<>'paid') OR (g.status='cancelled' AND bill.status<>'cancelled') THEN RAISE EXCEPTION '合并组状态与父账单不一致'; END IF;
 IF g.status<>'cancelled' AND EXISTS(SELECT 1 FROM combined_invoice_items x WHERE x.parent_invoice_id=target AND (EXISTS(SELECT 1 FROM payment_attempts WHERE invoice_id=x.invoice_id) OR EXISTS(SELECT 1 FROM payment_receipts WHERE invoice_id=x.invoice_id) OR EXISTS(SELECT 1 FROM wallet_payments WHERE invoice_id=x.invoice_id) OR EXISTS(SELECT 1 FROM credit_payments WHERE invoice_id=x.invoice_id))) THEN RAISE EXCEPTION '合并子单不能另外发起付款、收款或信用支付'; END IF;
 IF g.status='paid' AND NOT EXISTS(SELECT 1 FROM ledger_transactions t LEFT JOIN payment_receipts r ON r.id=t.receipt_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id WHERE r.invoice_id=target OR w.invoice_id=target) THEN RAISE EXCEPTION '已付合并账单必须有一笔真实现金或余额资金来源'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER combined_group_complete AFTER INSERT OR UPDATE ON combined_invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION combined_complete();
CREATE CONSTRAINT TRIGGER combined_items_complete AFTER INSERT OR UPDATE ON combined_invoice_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION combined_complete();
CREATE CONSTRAINT TRIGGER combined_invoice_complete AFTER INSERT OR UPDATE ON invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION combined_complete();
CREATE CONSTRAINT TRIGGER combined_order_complete AFTER UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION combined_complete();

-- 佣金仍归原始业务子单，收款时间来自真实父收款；保留信用足额还款条件。
CREATE OR REPLACE FUNCTION affiliate_invoice_payment_at(target uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(source.paid_at) FROM (
  SELECT t.created_at AS paid_at FROM payment_receipts r JOIN ledger_transactions t ON t.receipt_id=r.id WHERE r.invoice_id=target
  UNION ALL
  SELECT t.created_at FROM wallet_payments w JOIN ledger_transactions t ON t.wallet_payment_id=w.id WHERE w.invoice_id=target
  UNION ALL
  SELECT t.created_at FROM combined_invoice_items item JOIN combined_invoices g ON g.parent_invoice_id=item.parent_invoice_id AND g.status='paid' JOIN payment_receipts r ON r.invoice_id=g.parent_invoice_id JOIN ledger_transactions t ON t.receipt_id=r.id WHERE item.invoice_id=target AND item.locked
  UNION ALL
  SELECT t.created_at FROM combined_invoice_items item JOIN combined_invoices g ON g.parent_invoice_id=item.parent_invoice_id AND g.status='paid' JOIN wallet_payments w ON w.invoice_id=g.parent_invoice_id JOIN ledger_transactions t ON t.wallet_payment_id=w.id WHERE item.invoice_id=target AND item.locked
  UNION ALL
  SELECT bill.paid_at FROM credit_payments p JOIN credit_repayment_items item ON item.payment_id=p.id AND item.amount_cents=p.amount_cents JOIN credit_repayments repayment ON repayment.order_id=item.order_id AND repayment.user_id=p.user_id JOIN invoices bill ON bill.order_id=repayment.order_id AND bill.status='paid' AND bill.user_id=p.user_id JOIN orders purchase ON purchase.id=bill.order_id AND purchase.kind='credit_repayment' AND purchase.status='paid' WHERE p.invoice_id=target AND EXISTS(SELECT 1 FROM ledger_transactions t LEFT JOIN payment_receipts r ON r.id=t.receipt_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id WHERE r.invoice_id=bill.id OR w.invoice_id=bill.id)
 ) source
$$;

-- 父退款逐笔按不可变会计分录顺序累计，依合并时子单顺序冲减；每一分只分配一次。
CREATE FUNCTION affiliate_invoice_refunds(target uuid) RETURNS TABLE(id uuid,amount_cents bigint,status text,completed_at timestamptz,ordinal bigint) LANGUAGE sql STABLE AS $$
 WITH refunds_ordered AS (
  SELECT f.*,p.invoice_id,(SELECT min(e.id) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.refund_id=f.id) AS ordinal
  FROM refunds f JOIN payment_receipts p ON p.id=f.receipt_id WHERE p.invoice_id=target OR p.invoice_id IN(SELECT parent_invoice_id FROM combined_invoice_items WHERE invoice_id=target AND locked)
 ), membership AS (
  SELECT item.*,(SELECT COALESCE(sum(older.amount_cents),0) FROM combined_invoice_items older WHERE older.parent_invoice_id=item.parent_invoice_id AND older.position<item.position)::bigint AS before_cents
  FROM combined_invoice_items item WHERE item.invoice_id=target AND item.locked
 ), allocated AS (
  SELECT f.*,m.amount_cents AS child_cents,m.before_cents,
  COALESCE(sum(f.amount_cents) FILTER(WHERE f.status='succeeded') OVER(ORDER BY f.ordinal NULLS LAST,f.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS prior_cents
  FROM refunds_ordered f JOIN membership m ON m.parent_invoice_id=f.invoice_id
 )
 SELECT f.id,f.amount_cents,f.status,f.completed_at,f.ordinal FROM refunds_ordered f WHERE f.invoice_id=target
 UNION ALL
 SELECT a.id,CASE WHEN a.status='succeeded' THEN LEAST(a.child_cents,GREATEST(a.prior_cents+a.amount_cents-a.before_cents,0))-LEAST(a.child_cents,GREATEST(a.prior_cents-a.before_cents,0)) ELSE 0 END::bigint,a.status,a.completed_at,a.ordinal FROM allocated a
$$;
ALTER TABLE affiliate_reversals DROP CONSTRAINT affiliate_reversals_refund_id_key;
ALTER TABLE affiliate_reversals ADD CONSTRAINT affiliate_reversal_commission_refund UNIQUE(commission_id,refund_id);

-- 原资金守卫保留；仅扩展佣金退款来源，使父退款可分别冲回多个原子佣金。
CREATE OR REPLACE FUNCTION affiliate_source_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target uuid; ledger uuid; amount bigint; owner uuid; debit text; credit text; entry_count bigint; debit_count bigint; credit_count bigint; total numeric;
 c affiliate_commissions%ROWTYPE; r affiliate_reversals%ROWTYPE; t affiliate_transfers%ROWTYPE; p affiliate_payouts%ROWTYPE; w affiliate_withdrawals%ROWTYPE; bill invoices%ROWTYPE; rf refunds%ROWTYPE; previous_basis bigint; refunded bigint; allocated bigint; ledger_currency text;
BEGIN
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.affiliate_commission_id IS NOT NULL THEN kind:='commission';target:=NEW.affiliate_commission_id;
  ELSIF NEW.affiliate_reversal_id IS NOT NULL THEN kind:='reversal';target:=NEW.affiliate_reversal_id;
  ELSIF NEW.affiliate_transfer_id IS NOT NULL THEN kind:='transfer';target:=NEW.affiliate_transfer_id;
  ELSIF NEW.affiliate_payout_id IS NOT NULL THEN kind:='payout';target:=NEW.affiliate_payout_id; ELSE RETURN NEW; END IF;
 ELSE kind:=CASE TG_TABLE_NAME WHEN 'affiliate_commissions' THEN 'commission' WHEN 'affiliate_reversals' THEN 'reversal' WHEN 'affiliate_transfers' THEN 'transfer' WHEN 'affiliate_payouts' THEN 'payout' ELSE 'withdrawal' END;target:=NEW.id; END IF;
 IF kind='withdrawal' THEN
  SELECT * INTO STRICT w FROM affiliate_withdrawals WHERE id=target;
  IF (w.status='paid')<>EXISTS(SELECT 1 FROM affiliate_payouts WHERE withdrawal_id=w.id) THEN RAISE EXCEPTION '已支付提现必须有真实打款记录，其他状态不能有打款'; END IF; RETURN NEW;
 ELSIF kind='commission' THEN
  SELECT * INTO STRICT c FROM affiliate_commissions WHERE id=target; SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_commission_id=target;
  IF c.status='pending' THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '等待期佣金不能提前记可用负债'; END IF;RETURN NEW;END IF;
  SELECT * INTO STRICT bill FROM invoices WHERE id=c.invoice_id;
  SELECT COALESCE(sum(f.amount_cents),0)::bigint INTO refunded FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.status='succeeded';
  IF EXISTS(SELECT 1 FROM affiliate_invoice_refunds(c.invoice_id) f WHERE (f.status NOT IN('rejected','failed','succeeded') OR (f.status='succeeded' AND NOT f.id=ANY(c.recognized_refund_ids)))) THEN RAISE EXCEPTION '等待退款确认并完整记录已退款来源后才能释放佣金'; END IF;
  IF bill.status<>'paid' OR bill.user_id<>c.user_id OR c.release_at>now() OR affiliate_invoice_payment_at(bill.id) IS NULL OR c.release_at<affiliate_invoice_payment_at(bill.id) OR c.net_basis_cents<>GREATEST(bill.amount_cents-refunded,0) OR c.released_cents<>affiliate_entitlement(c.rule,c.net_basis_cents) OR NOT EXISTS(SELECT 1 FROM orders business WHERE business.id=bill.order_id AND business.kind IN('new','renew','upgrade')) OR NOT EXISTS(SELECT 1 FROM affiliate_referrals WHERE user_id=c.user_id AND affiliate_id=c.affiliate_id AND created_at<=bill.paid_at) THEN RAISE EXCEPTION '佣金必须来自已付款账单、真实来源、注册归因和净退款金额'; END IF;
  amount:=c.released_cents;owner:=c.affiliate_id;debit:='expense:affiliate';credit:='affiliate:'||owner::text;
 ELSIF kind='reversal' THEN
  SELECT * INTO STRICT r FROM affiliate_reversals WHERE id=target;SELECT * INTO STRICT c FROM affiliate_commissions WHERE id=r.commission_id;SELECT * INTO STRICT rf FROM refunds WHERE id=r.refund_id;
  SELECT COALESCE((SELECT x.basis_after_cents FROM affiliate_reversals x WHERE x.commission_id=c.id AND x.position<r.position ORDER BY x.position DESC LIMIT 1),c.net_basis_cents) INTO previous_basis;
  SELECT f.amount_cents INTO allocated FROM affiliate_invoice_refunds(c.invoice_id) f WHERE f.id=r.refund_id;
  IF c.status<>'released' OR rf.status<>'succeeded' OR rf.id=ANY(c.recognized_refund_ids) OR allocated IS NULL OR r.basis_before_cents<>previous_basis OR r.basis_after_cents<>GREATEST(previous_basis-allocated,0) OR r.amount_cents<>affiliate_entitlement(c.rule,r.basis_before_cents)-affiliate_entitlement(c.rule,r.basis_after_cents) THEN RAISE EXCEPTION '佣金冲回必须对应真实退款及净额差值'; END IF;
  SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_reversal_id=target;amount:=r.amount_cents;owner:=c.affiliate_id;debit:='affiliate:'||owner::text;credit:='expense:affiliate';
 ELSIF kind='transfer' THEN
  SELECT * INTO STRICT t FROM affiliate_transfers WHERE id=target;SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_transfer_id=target;amount:=t.amount_cents;owner:=t.user_id;debit:='affiliate:'||owner::text;credit:='wallet:'||owner::text;
 ELSE
  SELECT * INTO STRICT p FROM affiliate_payouts WHERE id=target;SELECT * INTO STRICT w FROM affiliate_withdrawals WHERE id=p.withdrawal_id;
  IF w.status<>'paid' OR p.user_id<>w.user_id OR p.amount_cents<>w.amount_cents OR p.channel<>(w.payee->>'method') OR p.paid_at>now()+interval '5 minutes' THEN RAISE EXCEPTION '实际打款必须与提现本人、金额、收款方式和时间一致'; END IF;
  SELECT lt.id,lt.currency INTO ledger,ledger_currency FROM ledger_transactions lt WHERE affiliate_payout_id=target;amount:=p.amount_cents;owner:=p.user_id;debit:='affiliate:'||owner::text;credit:='cash:affiliate-payout:'||p.channel;
 END IF;
 IF amount=0 THEN IF ledger IS NOT NULL THEN RAISE EXCEPTION '零佣金不能产生资金分录'; END IF; RETURN NEW; END IF;
 SELECT count(*),COALESCE(sum(amount_cents),0),count(*) FILTER(WHERE account=debit AND amount_cents=amount),count(*) FILTER(WHERE account=credit AND amount_cents=-amount) INTO entry_count,total,debit_count,credit_count FROM ledger_entries WHERE transaction_id=ledger;
 IF ledger IS NULL OR ledger_currency<>'CNY' OR entry_count<>2 OR total<>0 OR debit_count<>1 OR credit_count<>1 THEN RAISE EXCEPTION '联盟资金来源必须有同币种、同本人、相同金额的平衡双分录'; END IF;
 RETURN NEW;
END; $$;
