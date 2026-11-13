-- AMC requests set up from a vendor proposal: the proposal's contract total (before GST)
-- for each asset line. The agreed value may be lowered from it but never raised; the API
-- refuses any save that exceeds it.
ALTER TABLE purchase_request_items
  ADD COLUMN IF NOT EXISTS proposal_line_total NUMERIC(14,2);

COMMENT ON COLUMN purchase_request_items.proposal_line_total IS
  'Ceiling for this line''s contract value before GST, taken from the vendor proposal when the request was created. Null when no proposal was used.';

-- Rollback:
--   ALTER TABLE purchase_request_items DROP COLUMN IF EXISTS proposal_line_total;
