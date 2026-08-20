-- Payment reports can now be raised on a security deposit, not just an invoice.
--
-- 00510 assumed every report ends in a billing_payments row, and enforced it:
--   CHECK (status <> 'verified' OR billing_payment_id IS NOT NULL)
-- That invariant is the point of the feature — a verified report must point
-- at the money it produced — but it only describes invoices. A security
-- deposit is recorded on the proposal itself (deposit_payment_status,
-- deposit_payment_amount, deposit_payment_medium); there is no payment row
-- and so no id to store.
--
-- Rather than weaken the constraint for everyone, the report now says what
-- kind of thing it settles against, and the constraint applies where it
-- means something. For a deposit the equivalent proof is the proposal's own
-- deposit_payment_status flipping to 'paid', which the verify route checks
-- before it will mark a report verified.

ALTER TABLE query_payment_reports
  ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'invoice'
    CHECK (target_kind IN ('invoice', 'deposit'));

-- Widen the invariant rather than drop it: still impossible to have a
-- verified invoice report with nothing recorded against it.
ALTER TABLE query_payment_reports
  DROP CONSTRAINT IF EXISTS query_payment_reports_verified_has_payment;

ALTER TABLE query_payment_reports
  ADD CONSTRAINT query_payment_reports_verified_has_payment CHECK (
    status <> 'verified'
    OR target_kind <> 'invoice'
    OR billing_payment_id IS NOT NULL
  );

-- A deposit report has no invoice to allocate to, and an invoice report has
-- no business pointing at one it doesn't own. Keeps the two shapes honest.
ALTER TABLE query_payment_reports
  ADD CONSTRAINT query_payment_reports_deposit_has_no_invoice CHECK (
    target_kind <> 'deposit'
    OR (claimed_statement_id IS NULL AND billing_payment_id IS NULL)
  );

CREATE INDEX idx_qpr_target_kind ON query_payment_reports (target_kind);

COMMENT ON COLUMN query_payment_reports.target_kind IS
  'invoice = settles a billing statement, proved by billing_payment_id; deposit = settles a proposal security deposit, proved by that proposal''s deposit_payment_status becoming paid.';

NOTIFY pgrst, 'reload schema';
