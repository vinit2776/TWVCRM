-- Point the upload actor columns at public.users(id) instead of auth.users(id).
--
-- gst_invoice_uploads (00255) and credit_note_uploads (00406) declared their
-- actor columns as REFERENCES auth.users(id). Every other actor column in the
-- schema — documents, facility_issue_attachments, asset_documents,
-- vendor_documents, material_request_quotations, lease_documents, amc_service_tokens —
-- references public.users(id). The stored values are therefore Supabase auth ids,
-- and the obvious PostgREST join
--
--     users!gst_invoice_uploads_uploaded_by_fkey(full_name)
--
-- resolves against the wrong table and silently yields nothing. That is not
-- hypothetical: the AR history timeline (#495) had to look the actor up by BOTH
-- users.id and users.auth_id to render "who uploaded this invoice".
--
-- The data is unambiguous — all 187 gst_invoice_uploads rows carry an auth id
-- that maps to exactly one users row, and credit_note_uploads is empty — so the
-- backfill is a clean one-to-one remap.
--
-- Safe with respect to RLS: the policies on both tables (00263, 00407) are pure
-- role checks of the form `users.auth_id = auth.uid()`. Neither references the
-- actor columns, so retargeting them changes no access decision.
--
-- Rollback: reverse the two UPDATEs by joining users on id and writing auth_id
-- back, then swap the constraints to reference auth.users(id) again.

BEGIN;

-- ── gst_invoice_uploads ─────────────────────────────────────────────────────
ALTER TABLE gst_invoice_uploads
  DROP CONSTRAINT IF EXISTS gst_invoice_uploads_uploaded_by_fkey,
  DROP CONSTRAINT IF EXISTS gst_invoice_uploads_name_check_decided_by_fkey;

-- Join on auth_id, so a value that is already a users.id is left untouched and
-- the migration stays idempotent.
UPDATE gst_invoice_uploads g
   SET uploaded_by = u.id
  FROM users u
 WHERE u.auth_id = g.uploaded_by;

UPDATE gst_invoice_uploads g
   SET name_check_decided_by = u.id
  FROM users u
 WHERE u.auth_id = g.name_check_decided_by;

-- Any row that failed to remap would now violate this and abort the migration,
-- which is the intended outcome — a silent partial backfill is worse.
ALTER TABLE gst_invoice_uploads
  ADD CONSTRAINT gst_invoice_uploads_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES users(id),
  ADD CONSTRAINT gst_invoice_uploads_name_check_decided_by_fkey
    FOREIGN KEY (name_check_decided_by) REFERENCES users(id);

-- ── credit_note_uploads ─────────────────────────────────────────────────────
ALTER TABLE credit_note_uploads
  DROP CONSTRAINT IF EXISTS credit_note_uploads_uploaded_by_fkey;

UPDATE credit_note_uploads c
   SET uploaded_by = u.id
  FROM users u
 WHERE u.auth_id = c.uploaded_by;

ALTER TABLE credit_note_uploads
  ADD CONSTRAINT credit_note_uploads_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES users(id);

COMMENT ON COLUMN gst_invoice_uploads.uploaded_by IS
  'public.users(id) of the accountant who uploaded the invoice. Was auth.users(id) until 00514.';
COMMENT ON COLUMN gst_invoice_uploads.name_check_decided_by IS
  'public.users(id) of whoever decided the name check. Was auth.users(id) until 00514.';
COMMENT ON COLUMN credit_note_uploads.uploaded_by IS
  'public.users(id) of the accountant who uploaded the credit note. Was auth.users(id) until 00514.';

COMMIT;
