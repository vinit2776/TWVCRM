-- Migration: make IRN optional for SDIPL-REG (A-series) invoices.
--
-- Background: Tally's system-generated PDFs don't always surface the IRN as
-- extractable text (it may only appear in the embedded QR code). Requiring a
-- 64-char IRN blocks accounts from uploading a valid invoice just because
-- autofill couldn't extract it. The existing hard constraint is replaced with
-- a looser one that still rejects a *wrong-length* IRN but allows it to be
-- absent.  B-series (SDIPL-UNREG) behaviour is unchanged — no IRN allowed.

ALTER TABLE gst_invoice_uploads
  DROP CONSTRAINT IF EXISTS gst_invoice_uploads_irn_matches_series;

ALTER TABLE gst_invoice_uploads
  ADD CONSTRAINT gst_invoice_uploads_irn_matches_series CHECK (
    (tally_invoice_series = 'SDIPL-REG'   AND (irn IS NULL OR length(irn) = 64)) OR
    (tally_invoice_series = 'SDIPL-UNREG' AND irn IS NULL)
  );
