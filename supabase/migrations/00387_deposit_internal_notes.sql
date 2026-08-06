-- ─────────────────────────────────────────────────────────────────────────────
-- 00387_deposit_internal_notes.sql
-- Security deposit requests/collections on proposals have no dedicated
-- internal-notes field for accounts. Add one so staff can explain why a
-- deposit request/collection exists (e.g. renewal top-up vs new proposal,
-- shortfall explanation) — never sent to the customer in any deposit email.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_internal_notes TEXT;
