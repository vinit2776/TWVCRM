-- Fix a scope bug in 00500's historical backfill: it only covered contracts
-- with status IN ('active', 'renewed', 'renewal_in_progress'), so a contract
-- that was activated in the past and later terminated/expired never got its
-- deposit snapshot copied from its proposal — the new columns were left at
-- their defaults (0 / 'not_required') even though the proposal shows a real
-- paid deposit. Found via a post-migration parity check (comparing the old
-- proposal-keyed balance formula against the new contract-keyed one across
-- every non-draft contract) that flagged terminated/expired contracts as
-- newly showing 0 available when they used to show a real balance.
--
-- Correct scope: any contract that was EVER activated (activated_at IS NOT
-- NULL) should have its deposit snapshotted, regardless of current status —
-- termination/expiry doesn't erase the historical fact that a deposit was
-- collected. This re-runs the exact same backfill logic as 00500 §5 with
-- the corrected WHERE clause; it's a no-op for contracts already backfilled
-- correctly (the UPDATE just re-sets the same values).

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT resolve_deposit_source_contract(c.id) AS source_id
    FROM contracts c
    WHERE c.activated_at IS NOT NULL
  LOOP
    UPDATE contracts target SET
      security_deposit_amount     = p.security_deposit_amount,
      deposit_payment_status      = p.deposit_payment_status,
      deposit_payment_amount      = p.deposit_payment_amount,
      deposit_payment_reference   = p.deposit_payment_reference,
      deposit_payment_medium      = p.deposit_payment_medium,
      deposit_payment_received_at = p.deposit_payment_received_at,
      deposit_internal_notes      = p.deposit_internal_notes,
      security_deposit_months     = COALESCE(p.security_deposit_months, target.security_deposit_months)
    FROM proposals p
    WHERE target.id = r.source_id AND target.proposal_id = p.id;
  END LOOP;
END $$;
