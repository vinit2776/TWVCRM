-- Ad-hoc charges on a Virtual Office case.
--
-- Any additional billing for a case, as required — anything not already
-- covered by the licence fee (statement_type 'vo_case') or the renewal
-- ('vo_renewal'). In practice: mail handling beyond the free allowance, the
-- late-payment penalty, documentation and address-proof letters, recovery of
-- anything paid on the client's behalf. Deliberately not a fixed list.
--
-- Why this rides on billing_statements rather than proforma_invoices, which
-- is what the lead page uses: proforma_invoices is keyed on lead_id, and 20
-- files across the codebase resolve an invoice's buyer by joining to that
-- lead. A case has no lead, so a case-linked proforma invoice would appear
-- blank in the Tally Inbox, receivables, payment reminders, the digest and
-- the GST report until every one of them learned about a buyer that is not a
-- lead. That is the same defect fixed on VO billing statements earlier this
-- week, and there is no reason to recreate it.
--
-- billing_statements already carries case_id and already resolves its buyer
-- through voBillParty(), so a vo_adhoc statement inherits the Tally handoff,
-- the payment panel, receivables and GST issuance on day one.
--
-- Evidence this is needed: three VO charges totalling Rs. 36,580 have already
-- been raised as lead invoices (INV-0029, INV-0030, INV-0050), all against a
-- lead standing in for the aggregator on TWV-CASE-0051, because the case had
-- nowhere to put them.

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_statement_type_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_statement_type_check
  CHECK (statement_type IN (
    'combined', 'rent', 'usage', 'electricity', 'reimbursement', 'vo_renewal',
    'vo_case',                   -- per-case VO licence fee
    'vo_aggregator_consolidated',-- postpaid aggregator consolidated invoice
    'vo_adhoc'                   -- any additional billing on a case
  ));

ALTER TABLE billing_statements
  DROP CONSTRAINT IF EXISTS billing_statements_created_via_check;

ALTER TABLE billing_statements
  ADD CONSTRAINT billing_statements_created_via_check
  CHECK (created_via IS NULL OR created_via IN (
    'cron',
    'ad_hoc_request',
    'manual_correction',
    'legacy',
    'proposal_pi',
    'adhoc_invoice',
    'vo_case_request',
    'vo_aggregator_monthly',
    'vo_adhoc_charge'            -- raised by hand from the case Billing tab
  ));

-- Unlike vo_case, a case may carry many ad-hoc charges over its life, so
-- nothing here enforces uniqueness per case.
CREATE INDEX IF NOT EXISTS idx_billing_statements_case_adhoc
  ON billing_statements(case_id)
  WHERE statement_type = 'vo_adhoc';
