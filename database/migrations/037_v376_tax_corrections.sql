-- 已开票更正：登记商户实际已开具的全额红字票据，原始发票和签署事实保留。
CREATE TABLE tax_red_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL UNIQUE REFERENCES tax_requests(id),
 invoice_number text NOT NULL CHECK(length(invoice_number) BETWEEN 1 AND 100),
 document_url text CHECK(document_url IS NULL OR document_url~'^https://'),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 recorded_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_tax_red_documents BEFORE UPDATE OR DELETE ON tax_red_documents FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION tax_red_document_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM tax_requests WHERE id=NEW.request_id AND status='issued') THEN RAISE EXCEPTION '只能为实际已开具的发票登记红冲'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tax_red_document_valid BEFORE INSERT ON tax_red_documents FOR EACH ROW EXECUTE FUNCTION tax_red_document_valid();
CREATE INDEX tax_request_invoice_lookup ON tax_request_invoices(invoice_id,request_id);
