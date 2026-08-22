-- Backfills cases.status from what actually happened to each case, now that
-- the pipeline is event-derived (see 00521 for the mapping and the audit that
-- prompted it).
--
-- Separate file from 00521 on purpose: Postgres cannot use an enum value in
-- the same transaction that added it, and 'paid' is added there.
--
-- Dry-run against production, 22 Aug 2026 (58 cases):
--   docs_received 41 · intake_received 11 · invoiced 3 · paid 2 · active 1
-- 11 unchanged, 46 move forward, 1 moves back (TWV-CASE-0002, manually placed
-- at under_review with no compliance pass — a state retired here, so it could
-- not stay there under any mapping).
--
-- Highest stage wins; each statement excludes the stages above it.
--
-- Rollback: there is no automatic restore of the previous per-case values.
-- Capture them first if that matters:
--   CREATE TABLE cases_status_backup_00522 AS SELECT id, status FROM cases;

-- active: L&L executed, and paid for anyone not billed monthly in arrears.
-- Postpaid aggregators bill after the fact, so execution alone activates them.
UPDATE cases c SET status = 'active'
WHERE c.ll_agreement_status = 'executed'
  AND (
    (c.aggregator_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM aggregators a
      WHERE a.id = c.aggregator_id AND a.billing_method = 'postpaid'))
    OR EXISTS (
      SELECT 1 FROM billing_statements bs
      WHERE bs.case_id = c.id AND bs.statement_type = 'vo_case'
        AND bs.voided_at IS NULL AND bs.payment_status = 'paid')
  );

-- paid: invoice settled, agreement not yet executed.
UPDATE cases c SET status = 'paid'
WHERE c.status <> 'active'
  AND EXISTS (
    SELECT 1 FROM billing_statements bs
    WHERE bs.case_id = c.id AND bs.statement_type = 'vo_case'
      AND bs.voided_at IS NULL AND bs.payment_status = 'paid');

-- invoiced: invoice raised, not yet settled.
UPDATE cases c SET status = 'invoiced'
WHERE c.status NOT IN ('active', 'paid')
  AND EXISTS (
    SELECT 1 FROM billing_statements bs
    WHERE bs.case_id = c.id AND bs.statement_type = 'vo_case'
      AND bs.voided_at IS NULL);

-- internal_approved: compliance signed off, nothing billed yet.
UPDATE cases SET status = 'internal_approved'
WHERE status NOT IN ('active', 'paid', 'invoiced')
  AND compliance_passed IS TRUE;

-- docs_received: at least one document actually on file.
UPDATE cases c SET status = 'docs_received'
WHERE c.status NOT IN ('active', 'paid', 'invoiced', 'internal_approved')
  AND EXISTS (
    SELECT 1 FROM case_documents d
    WHERE d.case_id = c.id AND d.status <> 'pending');

-- Anything still sitting on a retired hand-off state falls back to intake,
-- so no case is stranded on a value the UI no longer offers.
UPDATE cases SET status = 'intake_received'
WHERE status IN ('docs_requested', 'under_review', 'compliance_check',
                 'sent_for_client_approval', 'client_approved',
                 'signing_in_progress', 'executed');
