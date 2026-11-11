-- 终止资源的旧续费款进入明确核对队列，真实收款照实记账，资源不被悄悄续费复活。
ALTER TABLE services ADD COLUMN termination_requested_at timestamptz;
CREATE TABLE billing_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL UNIQUE REFERENCES invoices,
  service_id uuid NOT NULL REFERENCES services,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX billing_reviews_open ON billing_reviews(created_at) WHERE status='open';
