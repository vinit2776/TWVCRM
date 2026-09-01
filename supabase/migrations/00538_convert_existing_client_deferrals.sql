-- Convert the "Existing Client" deferrals into waivers.
--
-- Deferral was the only way to say "not now", so it became the way to say
-- "not ever". 196 of the 242 deferred required contract documents give a
-- reason that is a permanent decision — "Existing Client", "Active Client",
-- "old client" and their misspellings — recorded in a field that carries an
-- expiry date. They duly expired, and the weekly KYC digest has been
-- reporting them as overdue ever since, burying the genuinely outstanding
-- items among them.
--
-- 00535 gave that decision somewhere proper to live. This moves them.
--
-- The decision stays attributed to whoever made it: waived_by takes the
-- original deferred_by (all 242 are Noorul), waived_at takes the original
-- deferred_at, and waived_reason keeps the original wording verbatim,
-- misspellings and all. Nothing is rewritten to look like it was decided
-- today by someone who was not there.
--
-- Matching is on the reason normalised to letters only, against an explicit
-- allow-list rather than a fuzzy pattern. A LIKE '%client%' would also catch
-- "Partial document pending" cases on a client record; enumerating the exact
-- observed spellings means the set is auditable and cannot over-reach.
--
-- NOT converted (46 rows, left deferred deliberately):
--   21  "Partial document pending" variants — genuinely temporary, still owed
--   16  "Managed Services" variants        — a different reason; not asked for
--    7  "NA" / "Not applicable" / "Does not have" / "Properitor ship"
--    2  "old"                              — too vague to read as a decision
--
-- Rollback:
--   UPDATE contract_documents d SET status = 'deferred',
--     deferred_by = b.deferred_by, deferred_at = b.deferred_at,
--     deferred_reason = b.deferred_reason, deferred_until = b.deferred_until,
--     waived_by = NULL, waived_at = NULL, waived_reason = NULL
--   FROM contract_documents_deferral_backup_00538 b WHERE d.id = b.id;

-- Every row this migration touches, exactly as it was.
CREATE TABLE IF NOT EXISTS contract_documents_deferral_backup_00538 AS
SELECT id, contract_id, label, status,
       deferred_by, deferred_at, deferred_reason, deferred_until
FROM contract_documents
WHERE status = 'deferred'
  AND regexp_replace(lower(deferred_reason), '[^a-z]', '', 'g') IN (
    'existingclient',  'existingclients',
    'exisitingclient', 'exisitingclients',
    'exisitngclient',  'exisitngclients',
    'activeclient',    'activeclients',
    'acitveclient',    'acitveclients',
    'oldclient',       'oldclients'
  );

COMMENT ON TABLE contract_documents_deferral_backup_00538 IS
  'Pre-conversion snapshot of the 196 "Existing Client" deferrals turned into waivers by 00538. Drop once the conversion has been reviewed in production.';

UPDATE contract_documents d
SET status         = 'waived',
    waived_by      = d.deferred_by,
    waived_at      = COALESCE(d.deferred_at, NOW()),
    waived_reason  = d.deferred_reason,
    deferred_by    = NULL,
    deferred_at    = NULL,
    deferred_reason = NULL,
    deferred_until = NULL,
    updated_at     = NOW()
FROM contract_documents_deferral_backup_00538 b
WHERE d.id = b.id
  AND d.status = 'deferred';
