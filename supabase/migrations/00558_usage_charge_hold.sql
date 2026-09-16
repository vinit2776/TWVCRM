-- Lets admin/manager pause ONE specific ad-hoc usage charge from being
-- swept into the next Generate Drafts run, without touching the rest of
-- that contract's billing (see generateUsageStatements in
-- src/lib/billing.ts, which now excludes held charges from the ad-hoc
-- charges it gathers per contract+month) — released whenever, no
-- approval workflow. The charge stays status="pending" the whole time
-- (held is a separate, orthogonal flag): a full waive is a permanent
-- "never bill this," a hold is a temporary "not yet, don't sweep this
-- one up until I say so."
--
-- Distinct from three existing, narrower/broader concepts:
--   - billing_statements.held_at (00543) holds one already-generated
--     statement from being sent/GST-issued.
--   - contract_billing_moratoriums (00310) waives one whole billing
--     month for a contract via an approval workflow.
--   - contracts.billing_hold_at (00556, reverted by 00557) paused an
--     entire contract's billing — replaced by this, scoped to one charge
--     instead, since a contract can have some charges fine to bill
--     alongside one that needs review.
--
-- held_at IS NOT NULL is the "currently held" signal — releasing nulls
-- all three columns. Full history lives in audit_trail (the PATCH
-- /api/usage-charges/[id] hold/release branch logs it as a plain
-- "update", same as every other field change on this table), so there's
-- no need to preserve past holds here.
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS held_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS hold_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_charges_held
  ON usage_charges (held_at)
  WHERE held_at IS NOT NULL;
