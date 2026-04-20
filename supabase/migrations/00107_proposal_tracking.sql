-- Store the last PDF path uploaded for a proposal so the public tracking
-- link can redirect the customer to the actual document.
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;

COMMENT ON COLUMN proposals.pdf_storage_path IS
  'Storage path of the most-recently emailed PDF. Used by the public tracking link to serve the document.';
