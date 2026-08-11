-- Join table recording which specific cases were included in a billing
-- statement. Primary use: postpaid Virtual Office consolidated invoices
-- (one billing_statements row per aggregator per period, many cases inside
-- it) — replaces the JSONB-only snapshot aggregator_invoices.items provides
-- today with a queryable relation. A case is "billed for a period" iff a
-- non-voided billing_statement_cases row exists for it.

CREATE TABLE billing_statement_cases (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  billing_statement_id UUID NOT NULL REFERENCES billing_statements(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  amount DECIMAL(12,2) NOT NULL,
  pro_rated_days INTEGER,
  total_days INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(billing_statement_id, case_id)
);

CREATE INDEX idx_bsc_statement ON billing_statement_cases(billing_statement_id);
CREATE INDEX idx_bsc_case ON billing_statement_cases(case_id);

ALTER TABLE billing_statement_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read billing_statement_cases"
  ON billing_statement_cases FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert billing_statement_cases"
  ON billing_statement_cases FOR INSERT TO authenticated WITH CHECK (true);
