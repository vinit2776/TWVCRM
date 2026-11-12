-- Attribute an ad-hoc lead invoice (proforma_invoices) to a contract.
--
-- Until now proforma_invoices keyed only to lead_id, so a collection made
-- through an ad-hoc invoice could never be tied back to the contract it
-- actually paid for. In practice staff bill contract charges ad hoc when the
-- proposal's own Razorpay link isn't the collection route (NEFT, a delta-seat
-- expansion, a corrected amount), and that money then lived in a parallel lane:
-- invisible to the contract's receivables, and unable to satisfy the contract
-- activation payment gate in PATCH /api/contracts/[id].
--
-- This adds the missing edge plus an explicit statement of WHAT the invoice
-- covers. The purpose matters: only an invoice marked 'prorata_first_invoice'
-- is allowed to unblock activation, so an unrelated paid ad-hoc charge (a
-- printing fee, a one-off penalty) attributed to the same contract can never
-- silently open that gate.
--
-- Deliberately NOT touched: billing_statements ownership. A statement spawned
-- from an ad-hoc invoice stays owned by invoice_id (see 00330). Stamping
-- contract_id on it too would make the same rupees countable under both the
-- ad-hoc and the contract revenue rollups.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_proforma_invoices_contract_id;
--   ALTER TABLE proforma_invoices
--     DROP CONSTRAINT IF EXISTS proforma_invoices_attribution_purpose_requires_contract,
--     DROP CONSTRAINT IF EXISTS proforma_invoices_attribution_purpose_check,
--     DROP COLUMN IF EXISTS attributed_by,
--     DROP COLUMN IF EXISTS attributed_at,
--     DROP COLUMN IF EXISTS attribution_purpose,
--     DROP COLUMN IF EXISTS contract_id;

ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attribution_purpose TEXT,
  ADD COLUMN IF NOT EXISTS attributed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attributed_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Vocabulary of what an attributed invoice is understood to cover.
ALTER TABLE proforma_invoices
  DROP CONSTRAINT IF EXISTS proforma_invoices_attribution_purpose_check;

ALTER TABLE proforma_invoices
  ADD CONSTRAINT proforma_invoices_attribution_purpose_check
  CHECK (attribution_purpose IS NULL OR attribution_purpose IN (
    'prorata_first_invoice',  -- the partial first month / first invoice; unblocks activation
    'monthly_rent',           -- a regular monthly charge billed ad hoc instead of via a statement
    'other'                   -- attributable to the contract, but not either of the above
  ));

-- A purpose is meaningless without a contract to attribute it to. Pairing them
-- in one constraint means ON DELETE SET NULL on contract_id would strand a
-- purpose, so the application clears both together — see
-- DELETE /api/invoices/[id]/attribution.
ALTER TABLE proforma_invoices
  DROP CONSTRAINT IF EXISTS proforma_invoices_attribution_purpose_requires_contract;

ALTER TABLE proforma_invoices
  ADD CONSTRAINT proforma_invoices_attribution_purpose_requires_contract
  CHECK (attribution_purpose IS NULL OR contract_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_contract_id
  ON proforma_invoices(contract_id)
  WHERE contract_id IS NOT NULL;

COMMENT ON COLUMN proforma_invoices.contract_id IS
  'Contract this ad-hoc invoice was raised against, when it bills a contract '
  'charge collected outside the normal statement flow. NULL for ordinary '
  'lead-level ad-hoc invoices. Does not affect billing_statements ownership.';

COMMENT ON COLUMN proforma_invoices.attribution_purpose IS
  'What the attributed invoice covers. Only ''prorata_first_invoice'' on a paid '
  'invoice satisfies the contract activation payment gate.';
