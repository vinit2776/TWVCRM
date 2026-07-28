-- Add a billing method (postpaid/prepaid) and an optional credit limit to aggregators.
--
-- Postpaid (default, matches existing behaviour): referrals accumulate and get
-- billed via aggregator_invoices, monthly or ad-hoc. credit_limit is advisory only.
--
-- Prepaid: each case under the aggregator requires an approved "Payment Proof"
-- document before its Leave & License Agreement can be executed (enforced in
-- src/app/api/cases/[id]/agreement/route.ts, not at the database level).

CREATE TYPE aggregator_billing_method AS ENUM ('postpaid', 'prepaid');

ALTER TABLE aggregators
  ADD COLUMN billing_method aggregator_billing_method NOT NULL DEFAULT 'postpaid',
  ADD COLUMN credit_limit DECIMAL(12,2);
