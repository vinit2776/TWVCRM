-- Renewal escalation becomes an agreed, per-case number instead of a fixed
-- sentence in the agreement that nothing enforced.
--
-- Every Leave & License Agreement generated so far carries the clause "Each
-- renewal term shall be subject to a minimum 5% escalation in License Fees",
-- but createRenewalBillingStatement bills subtotal = caseData.rate — the same
-- amount as the original term. So the renewal invoice contradicted the signed
-- agreement on every case, undercharging by at least 5%.
--
-- Making it a column lets the escalation be agreed per case and then actually
-- applied: the agreement renders the agreed figure, and the renewal statement
-- bills it. Cases where no escalation was agreed carry 0 and renew flat, which
-- is what the system has been doing in practice all along.
--
-- Default 0, not 5: applying an escalation nobody agreed to would overcharge,
-- which is the worse of the two errors. Existing cases keep the behaviour they
-- have had.

ALTER TABLE cases
  ADD COLUMN renewal_escalation_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
  CONSTRAINT cases_renewal_escalation_range CHECK (
    renewal_escalation_percentage >= 0 AND renewal_escalation_percentage <= 100
  );

COMMENT ON COLUMN cases.renewal_escalation_percentage IS
  'Agreed percentage increase applied to the license fee on renewal. Rendered into the agreement''s renewal clause and applied by createRenewalBillingStatement. 0 means the term renews at the same rate.';
