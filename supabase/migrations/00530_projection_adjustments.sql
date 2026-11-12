-- Manual revenue adjustments for the Center Analytics Projections tab.
--
-- Covers the case where real revenue exists for a month but isn't captured
-- by a contract's start_date/rate_phases — e.g. an early invoice processed
-- offline before the contract was set up in the CRM, with payment already
-- received. The contract record itself is intentionally left unchanged
-- (start_date reflects when the CRM began tracking it, which is accurate);
-- this table lets an admin add the missing month as a one-off line item that
-- Projections folds into "Confirmed" for that contract's location, without
-- touching billing_statements, collections, or New MRR — those already
-- correctly reflect the real (offline) invoice/payment history separately,
-- so this stays scoped to the Projections tab only.

CREATE TABLE IF NOT EXISTS projection_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),

  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (contract_id, month)
);

CREATE INDEX IF NOT EXISTS idx_projection_adjustments_contract ON projection_adjustments(contract_id);

ALTER TABLE projection_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read projection_adjustments"
  ON projection_adjustments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

CREATE POLICY "Admins can insert projection_adjustments"
  ON projection_adjustments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );

CREATE POLICY "Admins can delete projection_adjustments"
  ON projection_adjustments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_id = auth.uid()
        AND role = 'admin'
        AND is_active = true
    )
  );
