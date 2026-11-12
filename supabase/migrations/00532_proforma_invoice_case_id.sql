-- Ad-hoc proforma invoices can now be raised against a Virtual Office case,
-- not only a lead.
--
-- The capability already existed for leads, and people were using it for VO
-- work because there was nowhere else: INV-0029, INV-0030 and INV-0050
-- (Rs. 36,580) were all raised against a lead standing in for the aggregator
-- on TWV-CASE-0051. That money is invisible from the case today.
--
-- Deliberately the SAME table and the SAME "INV-" numbering as the lead-side
-- ad-hoc invoice, rather than a parallel concept on billing_statements. An
-- ad-hoc invoice is one book of unlisted charges; splitting it in two would
-- mean no single screen shows them all.
--
-- lead_id is already nullable, so a case-only invoice needs no change there.
-- Nothing requires exactly one of the two to be set: an invoice may legitimately
-- carry both when a VO client also exists as a lead.

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_case_id
  ON proforma_invoices(case_id)
  WHERE case_id IS NOT NULL;

COMMENT ON COLUMN proforma_invoices.case_id IS
  'Set when the invoice was raised against a Virtual Office case. The buyer is then resolved from the case''s billing route (postpaid aggregator / prepaid bill_to / direct client), not from a lead.';
