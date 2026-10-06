-- Ad-hoc invoice statements were mirrored from proforma_invoices without their
-- lead_id, so no surface that resolves a customer from the statement (Gateway
-- Activity, receivables) could name them — all 26 in production had NULL.
-- Code now sets lead_id at creation; this backfills the existing rows.
--
-- Rollback: not needed (only fills NULLs). To undo, set lead_id = NULL where
-- created_via = 'adhoc_invoice' AND contract_id IS NULL.

UPDATE billing_statements s
SET lead_id = pi.lead_id
FROM proforma_invoices pi
WHERE s.invoice_id = pi.id
  AND s.created_via = 'adhoc_invoice'
  AND s.lead_id IS NULL
  AND s.case_id IS NULL
  AND pi.lead_id IS NOT NULL;
