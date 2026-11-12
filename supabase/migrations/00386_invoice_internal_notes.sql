-- ─────────────────────────────────────────────────────────────────────────────
-- 00386_invoice_internal_notes.sql
-- Ad-hoc proforma invoices currently only have a customer-facing `notes`
-- field (printed on the invoice PDF). Add a separate internal_notes column
-- so accounts has a required, customer-invisible place to record why a
-- charge exists and how to book it — never included in generateInvoicePDF
-- or the invoice email template.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;
