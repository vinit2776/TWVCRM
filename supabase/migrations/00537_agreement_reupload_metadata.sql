-- Contracts and virtual-office leave & license agreements each track a
-- single "current" executed document (contracts.signed_document_id /
-- case_agreements.signed_document_id or generated_document_id). There was no
-- way to swap that document — e.g. a customer legal name change, or a change
-- of law requiring redocumentation — without losing the originally executed
-- copy.
--
-- documents already has parent_document_id + version (00001_initial_schema),
-- proven as a version chain by stamp-existing-document/route.ts. This adds
-- the narrow metadata a reupload needs on top of that existing chain, rather
-- than a new table: why the new version exists, and whether the uploader
-- confirmed it's the fully signed & sealed copy. NULL on both for the
-- original document and for documents unrelated to agreement versioning.
ALTER TABLE documents
  ADD COLUMN reupload_reason TEXT
    CHECK (reupload_reason IS NULL OR reupload_reason IN ('name_change', 'law_change', 'other')),
  ADD COLUMN reupload_notes TEXT,
  ADD COLUMN is_signed_sealed BOOLEAN;

COMMENT ON COLUMN documents.reupload_reason IS
  'Set when this document replaces an existing executed agreement rather than being the original — e.g. customer name change or change-of-law redocumentation. NULL for the original document.';
COMMENT ON COLUMN documents.is_signed_sealed IS
  'Uploader-confirmed at reupload time: true = confirmed fully signed & sealed, false = uploaded anyway despite not being confirmed (shown as a warning in the UI), NULL = not applicable (original document, or predates this feature).';
