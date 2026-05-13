-- Reset TWV-BS-0029 (contract TWV-C-0035) to a clean finalized state
-- so the new proforma → payment → GST invoice flow can be applied fresh.
-- Clears all test-run artefacts: proforma timestamp, Razorpay link,
-- payment status, GST invoice fields, and emailed_at.
-- Statement remains finalized so accounts can trigger Send Proforma.

UPDATE billing_statements
SET
  proforma_sent_at        = NULL,
  razorpay_payment_link_id  = NULL,
  razorpay_payment_link_url = NULL,
  payment_status          = 'unpaid',
  gst_invoice_number      = NULL,
  gst_invoice_path        = NULL,
  emailed_at              = NULL,
  accounted               = false
WHERE statement_number = 'TWV-BS-0029';
