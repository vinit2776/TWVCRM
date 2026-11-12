-- Usage Charges redesign, Phase 1 ("the engine") — see the plan discussed
-- with Vinit for the full rationale. Three additions, all additive:
--
-- 1. Hold support for print (service_usage_records) and facility
--    (facility_usage_records) usage, mirroring usage_charges.held_at
--    (00558_usage_charge_hold.sql). Previously only manual charges could be
--    excluded from a Generate & Send sweep without waiving them outright.
ALTER TABLE service_usage_records
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

ALTER TABLE facility_usage_records
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_service_usage_records_held
  ON service_usage_records (held_at) WHERE held_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facility_usage_records_held
  ON facility_usage_records (held_at) WHERE held_at IS NOT NULL;

-- 2. billing_statement_id on facility_usage_records, mirroring
--    usage_charges' own column. Facility usage previously had no way to
--    tell "already on an invoice" apart from "still outstanding" other
--    than "does this contract have ANY statement for this exact period" —
--    which is exactly what made it unsafe to sweep up across months (a
--    late-logged row for an already-invoiced period would either be
--    invisible forever, or double-billed if the sweep window were widened
--    naively). This column lets generateUsageStatements() treat facility
--    usage the same safe way it already treats usage_charges: fetch
--    anything with billing_statement_id IS NULL, regardless of how old,
--    and set it the moment a row goes out on a statement.
ALTER TABLE facility_usage_records
  ADD COLUMN IF NOT EXISTS billing_statement_id UUID REFERENCES billing_statements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_facility_usage_records_billing_statement
  ON facility_usage_records (billing_statement_id);

-- 3. reviewed_at / reviewed_by on all three charge tables — backs the
--    "Bill anyway" action. A charge older than the review-required window
--    (see REVIEW_REQUIRED_AFTER_DAYS in src/lib/billing.ts) is excluded
--    from the automatic Generate & Send sweep unless someone has
--    explicitly clicked "Bill anyway" on that exact row, which just stamps
--    these two columns — same idea as held_at/waived_at, but "yes, still
--    charge for this" instead of "exclude" or "resolve."
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);

ALTER TABLE service_usage_records
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);

ALTER TABLE facility_usage_records
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);
