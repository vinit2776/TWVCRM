-- ==========================================
-- Migration 00386: Procurement Recurring Bill Rules
-- ==========================================
-- Lets admin pre-approve a vendor's recurring invoices (telephone, internet,
-- electricity, etc.) so future bills auto-approve instead of waiting in the
-- manual approval queue. A rule requires an existing, already-approved bill
-- from that vendor+department as its anchor — it cannot be set up speculatively.

CREATE TABLE IF NOT EXISTS procurement_recurring_bill_rules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                UUID NOT NULL REFERENCES procurement_vendors(id),
  department               procurement_department NOT NULL,
  billing_cycle            TEXT NOT NULL
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  expected_amount          DECIMAL(12,2) NOT NULL CHECK (expected_amount > 0),
  tolerance_percent        DECIMAL(5,2) NOT NULL DEFAULT 10
    CHECK (tolerance_percent >= 0 AND tolerance_percent <= 100),
  max_auto_approve_amount  DECIMAL(12,2) NOT NULL CHECK (max_auto_approve_amount > 0),
  default_batch_type       TEXT NOT NULL
    CHECK (default_batch_type IN ('immediate', '15th', '25th')),
  status                   TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused')),
  -- The pre-existing, manually-approved bill this rule's expected_amount was seeded from.
  anchor_bill_id           UUID NOT NULL REFERENCES vendor_bills(id),
  -- Set once the first bill created while this rule is active has been manually
  -- approved. Until then, every new bill against this rule falls back to manual
  -- approval even if it would otherwise pass the variance/cap checks.
  first_bill_id            UUID REFERENCES vendor_bills(id),
  notes                    TEXT,
  created_by                UUID NOT NULL REFERENCES users(id),
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Only one active rule per vendor at a time, so auto-approval matching against
-- an incoming bill (which only carries vendor_id, not a reliable department tag)
-- is never ambiguous. `department` is informational/reporting only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recurring_bill_rules_active_vendor
  ON procurement_recurring_bill_rules(vendor_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_recurring_bill_rules_vendor ON procurement_recurring_bill_rules(vendor_id);
CREATE INDEX IF NOT EXISTS idx_recurring_bill_rules_status ON procurement_recurring_bill_rules(status);

CREATE TRIGGER update_recurring_bill_rules_updated_at
  BEFORE UPDATE ON procurement_recurring_bill_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE procurement_recurring_bill_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read recurring_bill_rules"
  ON procurement_recurring_bill_rules FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert recurring_bill_rules"
  ON procurement_recurring_bill_rules FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update recurring_bill_rules"
  ON procurement_recurring_bill_rules FOR UPDATE USING (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE ON public.procurement_recurring_bill_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.procurement_recurring_bill_rules TO service_role;

-- ─── vendor_bills: auto-approval trail ─────────────────────────────────────

ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS auto_approved      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurring_rule_id  UUID REFERENCES procurement_recurring_bill_rules(id),
  ADD COLUMN IF NOT EXISTS auto_approval_note TEXT;

CREATE INDEX IF NOT EXISTS idx_vendor_bills_recurring_rule ON vendor_bills(recurring_rule_id);
