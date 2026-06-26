-- Backfill handoff_state for 5 legacy paid PI statements so they surface
-- in the Tally inbox under "GST to issue". Payment was received via the
-- gateway before the inbox workflow existed; accounts can now upload the
-- Tally GST PDF and dispatch it to the customer from /accounting/inbox.
--
-- Targeted by statement_number to keep the scope explicit and reviewable.
-- Guards (handoff_state IS NULL, payment_status = 'paid') make this safe
-- to re-run and prevent stomping any row that has already moved forward.
--
-- Rollback: UPDATE billing_statements SET handoff_state = NULL
--            WHERE statement_number IN (...listed below...);

UPDATE billing_statements
SET handoff_state = 'pi_paid_awaiting_gst',
    updated_at    = NOW()
WHERE statement_number IN (
        'TWV-BS-0086',  -- Bathla Trading Agency Pvt Ltd  — GST# SD/A/26-27/140
        'TWV-BS-0090',  -- Cargolux Airlines International S.A
        'TWV-BS-0092',  -- Refyne Finance Private Limited — GST# TWV/INV/26-27/0006
        'TWV-BS-0122',  -- Neha Bokdia & Associates
        'TWV-BS-0124'   -- AA Vacations
      )
  AND handoff_state IS NULL
  AND payment_status = 'paid';
