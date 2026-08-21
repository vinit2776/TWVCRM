-- Track which signed_document was produced by the admin "stamp with company
-- seal" feature (vs. a manually uploaded signed copy, or a genuine Leegality
-- e-sign completion) so a "cancel stamp" action can be offered only for
-- documents this feature actually produced, and can restore the exact prior
-- state on cancel.

ALTER TABLE contracts
  ADD COLUMN stamp_reference TEXT;

ALTER TABLE case_agreements
  ADD COLUMN stamp_reference TEXT,
  ADD COLUMN pre_stamp_status TEXT;
