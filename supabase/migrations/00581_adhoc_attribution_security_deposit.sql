-- Attribute a paid ad-hoc invoice to a contract as a SECURITY DEPOSIT.
--
-- For legacy deposits collected through an ad-hoc invoice before security
-- deposits were redirected to the proposal deposit link. Attributing one now
-- credits the customer's deposit pool: the pool is the contract's own paid
-- deposit plus every paid deposit_topups row across the customer's contracts
-- (get_deposit_available_balance, 00502), so the credit is a paid, manual
-- top-up linked back to the invoice. Detaching reverses it.
--
-- The invoice already went through accounting on its own, so these top-ups
-- are kept out of the deposit accounting inbox (see the route filter) —
-- otherwise accounts would be asked to account for the same money twice.

-- ── 1. 'security_deposit' as an attribution purpose (mirrors constants.ts) ──
ALTER TABLE proforma_invoices
  DROP CONSTRAINT IF EXISTS proforma_invoices_attribution_purpose_check;

ALTER TABLE proforma_invoices
  ADD CONSTRAINT proforma_invoices_attribution_purpose_check
  CHECK (attribution_purpose IS NULL OR attribution_purpose IN (
    'prorata_first_invoice',
    'monthly_rent',
    'security_deposit',
    'other'
  ));

-- ── 2. Link a top-up to the invoice it came from ───────────────────────────
-- RESTRICT: an invoice that backs pool money must not be deletable.
ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS source_invoice_id UUID REFERENCES proforma_invoices(id) ON DELETE RESTRICT;

-- One live credit per invoice — makes double-attribution impossible even
-- under concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deposit_topups_active_source_invoice
  ON deposit_topups (source_invoice_id)
  WHERE source_invoice_id IS NOT NULL AND status <> 'reversed';

-- ── 3. Attribute + credit the pool, atomically ─────────────────────────────
CREATE OR REPLACE FUNCTION attribute_invoice_as_security_deposit(
  p_invoice_id UUID,
  p_contract_id UUID,
  p_actor UUID
)
RETURNS TABLE(success BOOLEAN, error TEXT, topup_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_inv RECORD;
  v_contract RECORD;
  v_existing RECORD;
  v_source_contract UUID;
  v_source_proposal UUID;
  v_new_id UUID;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts') THEN
    RETURN QUERY SELECT FALSE, 'Only admin or accounts can credit a security deposit', NULL::UUID;
    RETURN;
  END IF;

  SELECT * INTO v_inv FROM proforma_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Invoice not found', NULL::UUID;
    RETURN;
  END IF;

  -- The pool only holds money actually in hand.
  IF v_inv.status <> 'paid' THEN
    RETURN QUERY SELECT FALSE, 'Only a paid invoice can be credited to the deposit pool', NULL::UUID;
    RETURN;
  END IF;

  -- Security deposits are refundable and GST-exempt. A taxed invoice is a
  -- mis-tagged revenue invoice, not a deposit.
  IF COALESCE(v_inv.tax_amount, 0) > 0 THEN
    RETURN QUERY SELECT FALSE, 'This invoice includes GST, so it is not a security deposit', NULL::UUID;
    RETURN;
  END IF;

  IF v_inv.lead_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 'The invoice has no customer on file, so the pool to credit is unknown', NULL::UUID;
    RETURN;
  END IF;

  SELECT id, lead_id INTO v_contract FROM contracts WHERE id = p_contract_id;
  IF v_contract IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Contract not found', NULL::UUID;
    RETURN;
  END IF;
  IF v_contract.lead_id IS DISTINCT FROM v_inv.lead_id THEN
    RETURN QUERY SELECT FALSE, 'Invoice and contract belong to different customers', NULL::UUID;
    RETURN;
  END IF;

  SELECT * INTO v_existing FROM deposit_topups
  WHERE source_invoice_id = p_invoice_id AND status <> 'reversed'
  FOR UPDATE;

  IF v_existing IS NOT NULL THEN
    IF v_existing.contract_id <> p_contract_id THEN
      RETURN QUERY SELECT FALSE, 'This invoice already credits the deposit pool through another contract — detach it first', NULL::UUID;
      RETURN;
    END IF;
    v_new_id := v_existing.id;  -- already credited: idempotent
  ELSE
    v_source_contract := resolve_deposit_source_contract(p_contract_id);
    SELECT proposal_id INTO v_source_proposal FROM contracts WHERE id = v_source_contract;

    INSERT INTO deposit_topups (
      contract_id, source_contract_id, source_proposal_id, source_lead_id,
      amount, category, category_note, status, collection_method,
      payment_mode, payment_reference, applies_to_shortfall,
      created_by, paid_at, source_invoice_id
    ) VALUES (
      p_contract_id, v_source_contract, v_source_proposal, v_inv.lead_id,
      v_inv.total_amount, 'other',
      format('Legacy security deposit collected via ad-hoc invoice %s', v_inv.invoice_number),
      'paid', 'manual',
      'other', v_inv.payment_reference, FALSE,
      p_actor, COALESCE(v_inv.paid_at, NOW()), p_invoice_id
    ) RETURNING id INTO v_new_id;
  END IF;

  UPDATE proforma_invoices SET
    contract_id = p_contract_id,
    attribution_purpose = 'security_deposit',
    attributed_at = NOW(),
    attributed_by = p_actor
  WHERE id = p_invoice_id;

  RETURN QUERY SELECT TRUE, NULL::TEXT, v_new_id;
END;
$$;

-- ── 4. Take the credit back out (detach, or re-attribute as something else) ─
CREATE OR REPLACE FUNCTION release_invoice_security_deposit(
  p_invoice_id UUID,
  p_actor UUID,
  p_reason TEXT
)
RETURNS TABLE(success BOOLEAN, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_topup RECORD;
  v_available NUMERIC;
BEGIN
  SELECT role INTO v_role FROM users WHERE id = p_actor;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'accounts') THEN
    RETURN QUERY SELECT FALSE, 'Only admin or accounts can remove a security deposit credit';
    RETURN;
  END IF;

  SELECT * INTO v_topup FROM deposit_topups
  WHERE source_invoice_id = p_invoice_id AND status <> 'reversed'
  FOR UPDATE;

  IF v_topup IS NULL THEN
    RETURN QUERY SELECT TRUE, NULL::TEXT;  -- nothing was credited
    RETURN;
  END IF;

  -- If part of this credit has since been drawn or promised to an
  -- adjustment, taking it back would leave the pool negative.
  SELECT b.available INTO v_available FROM get_deposit_available_balance(v_topup.contract_id) b;
  IF COALESCE(v_available, 0) < v_topup.amount THEN
    RETURN QUERY SELECT FALSE, 'Part of this deposit has already been used by a deposit adjustment, so it cannot be removed from the pool';
    RETURN;
  END IF;

  UPDATE deposit_topups SET
    status = 'reversed',
    reversed_by = p_actor,
    reversed_at = NOW(),
    reversal_reason = COALESCE(NULLIF(trim(p_reason), ''), 'Invoice attribution removed'),
    updated_at = NOW()
  WHERE id = v_topup.id;

  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$$;

-- The actor is a parameter, so these must only be reachable from our server
-- routes (service role), never directly by a signed-in user passing someone
-- else's id.
REVOKE ALL ON FUNCTION attribute_invoice_as_security_deposit(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION release_invoice_security_deposit(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION attribute_invoice_as_security_deposit(UUID, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION release_invoice_security_deposit(UUID, UUID, TEXT) TO service_role;

-- Rollback (reverse any credits first, or the column drop will fail):
--   DROP FUNCTION IF EXISTS release_invoice_security_deposit(UUID, UUID, TEXT);
--   DROP FUNCTION IF EXISTS attribute_invoice_as_security_deposit(UUID, UUID, UUID);
--   DROP INDEX IF EXISTS uniq_deposit_topups_active_source_invoice;
--   ALTER TABLE deposit_topups DROP COLUMN source_invoice_id;
--   ALTER TABLE proforma_invoices DROP CONSTRAINT proforma_invoices_attribution_purpose_check;
--   ALTER TABLE proforma_invoices ADD CONSTRAINT proforma_invoices_attribution_purpose_check
--     CHECK (attribution_purpose IS NULL OR attribution_purpose IN ('prorata_first_invoice','monthly_rent','other'));
