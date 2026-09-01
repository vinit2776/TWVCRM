-- Correct nine cases where the client was recorded as their own aggregator.
--
-- Until 00399 added case_source, cases.aggregator_id was NOT NULL — a walk-in
-- customer's case could not be saved without inventing an aggregator. People
-- typed the client's own name, or their contact person's name, into that
-- field. The result is aggregator records that are not referral partners at
-- all, and cases that bill the wrong party.
--
-- Each case below was confirmed against at least one identity field shared
-- between the aggregator record and the case's own client — email, phone, or
-- GSTIN — not name alone. A shared GSTIN is conclusive: a person and a company
-- on one GST registration are the same legal entity.
--
-- Deliberately NOT included, though a name/contact match flags them:
--   TWV-CASE-0003  Anushka is QuickOffice24, a genuine aggregator. It matched
--                  only because the aggregator's email was copied into
--                  client_email. That is a separate defect; converting this
--                  case would destroy a real referral relationship.
--   TWV-CASE-0001/0043 (Test), TWV-CASE-0002 (Instaspaces Testing) — test
--                  data, handled separately.
--
-- Safe to run now: none of these nine has a billing statement, and their
-- agreements are all draft or internally_approved — none executed. So no
-- invoice has gone to the wrong party. Conversion changes billing from the
-- aggregator to the client, which is the correct outcome, and stops being a
-- simple data edit the moment any of them is invoiced.
--
-- Reversible per case from cases_source_backup_00531, written below.

-- Snapshot first, so any single case can be put back exactly as it was.
CREATE TABLE IF NOT EXISTS cases_source_backup_00531 AS
SELECT id, case_number, case_source, aggregator_id, bill_to, NOW() AS captured_at
FROM cases
WHERE case_number IN (
  'TWV-CASE-0025', 'TWV-CASE-0030', 'TWV-CASE-0035', 'TWV-CASE-0037',
  'TWV-CASE-0048', 'TWV-CASE-0049', 'TWV-CASE-0050', 'TWV-CASE-0051',
  'TWV-CASE-0052'
);

-- case_source and aggregator_id must move together: the
-- cases_source_aggregator_consistency check (00399) requires
-- (direct AND aggregator_id IS NULL) or (aggregator AND aggregator_id NOT NULL).
--
-- bill_to is cleared too. It only applies to prepaid-aggregator cases and is
-- meaningless on a direct one, where the client is always the billed party.
UPDATE cases
SET case_source  = 'direct',
    aggregator_id = NULL,
    bill_to      = NULL
WHERE case_number IN (
  'TWV-CASE-0025', 'TWV-CASE-0030', 'TWV-CASE-0035', 'TWV-CASE-0037',
  'TWV-CASE-0048', 'TWV-CASE-0049', 'TWV-CASE-0050', 'TWV-CASE-0051',
  'TWV-CASE-0052'
)
-- Guard: only convert a case that still looks like the problem. If any of
-- these has been invoiced or already corrected since the audit, leave it
-- alone rather than overwriting a decision someone else made.
AND case_source = 'aggregator'
AND aggregator_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM billing_statements bs
  WHERE bs.case_id = cases.id AND bs.voided_at IS NULL
);

-- The aggregator records themselves are left in place. Deleting them would
-- break the FK from any row that still references them, and they are harmless
-- once no case points at them — they are retired in a follow-up once the list
-- of genuinely-unused records is confirmed.
--
-- Rollback:
--   UPDATE cases c
--   SET case_source = b.case_source, aggregator_id = b.aggregator_id, bill_to = b.bill_to
--   FROM cases_source_backup_00531 b
--   WHERE c.id = b.id;
