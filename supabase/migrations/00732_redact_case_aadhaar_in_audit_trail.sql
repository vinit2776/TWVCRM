-- A case's signer Aadhaar was copied in full into audit_trail.changes by the
-- case create / update / delete entries. New entries are masked in code
-- (src/lib/case-pii.ts); this masks the ones already written, to the same
-- "XXXX XXXX 1234" form. Only values that are exactly 12 digits are touched
-- (a PAN is never all digits), so it is safe to re-run and leaves already
-- masked values alone. The cases table itself is not changed — the agreement
-- still prints the full number.
--
-- Rollback: none possible by design; the full numbers are not kept anywhere
-- but cases.represented_by_id_number.

-- create: changes.record.new
UPDATE audit_trail
SET changes = jsonb_set(
  changes,
  '{record,new,represented_by_id_number}',
  to_jsonb('XXXX XXXX ' || right(regexp_replace(changes #>> '{record,new,represented_by_id_number}', '\s|-', '', 'g'), 4))
)
WHERE entity_type = 'case'
  AND changes #>> '{record,new,represented_by_id_number}' ~ '^\s*\d{4}[\s-]?\d{4}[\s-]?\d{4}\s*$';

-- delete: changes.record.old
UPDATE audit_trail
SET changes = jsonb_set(
  changes,
  '{record,old,represented_by_id_number}',
  to_jsonb('XXXX XXXX ' || right(regexp_replace(changes #>> '{record,old,represented_by_id_number}', '\s|-', '', 'g'), 4))
)
WHERE entity_type = 'case'
  AND changes #>> '{record,old,represented_by_id_number}' ~ '^\s*\d{4}[\s-]?\d{4}[\s-]?\d{4}\s*$';

-- update: changes.represented_by_id_number.{old,new}
UPDATE audit_trail
SET changes = jsonb_set(
  changes,
  '{represented_by_id_number,old}',
  to_jsonb('XXXX XXXX ' || right(regexp_replace(changes #>> '{represented_by_id_number,old}', '\s|-', '', 'g'), 4))
)
WHERE entity_type = 'case'
  AND changes #>> '{represented_by_id_number,old}' ~ '^\s*\d{4}[\s-]?\d{4}[\s-]?\d{4}\s*$';

UPDATE audit_trail
SET changes = jsonb_set(
  changes,
  '{represented_by_id_number,new}',
  to_jsonb('XXXX XXXX ' || right(regexp_replace(changes #>> '{represented_by_id_number,new}', '\s|-', '', 'g'), 4))
)
WHERE entity_type = 'case'
  AND changes #>> '{represented_by_id_number,new}' ~ '^\s*\d{4}[\s-]?\d{4}[\s-]?\d{4}\s*$';
