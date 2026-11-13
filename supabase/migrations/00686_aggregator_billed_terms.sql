-- 00686_aggregator_billed_terms.sql
-- Postpaid aggregator billing, once per term instead of monthly.
--
-- cases.rate is the fee for the whole tenure, but the monthly aggregator invoice
-- run bills it every month. With app_settings.vo_agg_billing_mode = 'once_per_tenure'
-- each case is billed once, in the period containing its term start. This table
-- records which (case, term start) pairs have been billed so a term is never
-- billed twice. A renewed term is a new case row with a new start_date, so it
-- gets its own row here.
--
-- The setting is seeded as 'legacy' (today's behaviour). Nothing changes until
-- an admin flips it. See docs/aggregator-billing-once-per-tenure.md.
--
-- Rollback:
--   DROP TABLE IF EXISTS aggregator_case_terms_billed;
--   DELETE FROM app_settings WHERE key = 'vo_agg_billing_mode';

CREATE TABLE IF NOT EXISTS aggregator_case_terms_billed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  term_start DATE NOT NULL,
  aggregator_invoice_id UUID REFERENCES aggregator_invoices(id),
  amount NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT aggregator_case_terms_billed_case_term_key UNIQUE (case_id, term_start)
);

CREATE INDEX IF NOT EXISTS idx_agg_case_terms_billed_invoice
  ON aggregator_case_terms_billed(aggregator_invoice_id)
  WHERE aggregator_invoice_id IS NOT NULL;

ALTER TABLE aggregator_case_terms_billed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "aggregator_case_terms_billed_select" ON aggregator_case_terms_billed;
CREATE POLICY "aggregator_case_terms_billed_select" ON aggregator_case_terms_billed
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "aggregator_case_terms_billed_service" ON aggregator_case_terms_billed;
CREATE POLICY "aggregator_case_terms_billed_service" ON aggregator_case_terms_billed
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON aggregator_case_terms_billed TO authenticated;
GRANT ALL ON aggregator_case_terms_billed TO service_role;

INSERT INTO app_settings (key, value)
VALUES ('vo_agg_billing_mode', 'legacy')
ON CONFLICT (key) DO NOTHING;
