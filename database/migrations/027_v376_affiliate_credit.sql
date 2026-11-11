-- 信用业务佣金：原账单仅有应收款时不计佣，完整真实还款后从实际入账时间开始等待期。
CREATE OR REPLACE FUNCTION affiliate_invoice_payment_at(target uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT min(source.paid_at) FROM (
  SELECT t.created_at AS paid_at FROM ledger_transactions t
  LEFT JOIN payment_receipts r ON r.id=t.receipt_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id
  WHERE r.invoice_id=target OR w.invoice_id=target
  UNION ALL
  SELECT bill.paid_at FROM credit_payments p
  JOIN credit_repayment_items item ON item.payment_id=p.id AND item.amount_cents=p.amount_cents
  JOIN credit_repayments repayment ON repayment.order_id=item.order_id AND repayment.user_id=p.user_id
  JOIN invoices bill ON bill.order_id=repayment.order_id AND bill.status='paid' AND bill.user_id=p.user_id
  JOIN orders purchase ON purchase.id=bill.order_id AND purchase.kind='credit_repayment' AND purchase.status='paid'
  WHERE p.invoice_id=target AND EXISTS(SELECT 1 FROM ledger_transactions t
    LEFT JOIN payment_receipts r ON r.id=t.receipt_id LEFT JOIN wallet_payments w ON w.id=t.wallet_payment_id
    WHERE r.invoice_id=bill.id OR w.invoice_id=bill.id)
 ) source
$$;
