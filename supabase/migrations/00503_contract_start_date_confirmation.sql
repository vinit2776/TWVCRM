-- Contract start_date must flow from the linked proposal's paid pro-rata
-- invoice, not be a permanently-editable admin field.
--
-- Until now, start_date was entered freely at contract creation (soft
-- pre-filled from proposals.occupation_start_date, but never enforced to
-- match it) and never touched again by the platform. Business direction:
-- start_date should be a placeholder until the proposal's pro-rata invoice
-- is actually paid — at which point it locks to that invoice's
-- occupation_start_date and future billing relies on it being fixed.
--
-- start_date_confirmed defaults to TRUE so every existing contract (and
-- every renewal draft, which this change intentionally leaves untouched —
-- renewals carry the deposit forward via deposit_carried_from and use their
-- own edit-terms flow) keeps behaving exactly as before. New non-renewal
-- contracts created via POST /api/contracts explicitly set this to FALSE
-- when the linked proposal's pro-rata invoice hasn't been paid yet; it
-- flips back to TRUE (and start_date locks) at contract activation.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS start_date_confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS start_date_locked_at timestamptz;

COMMENT ON COLUMN contracts.start_date_confirmed IS
  'FALSE only while a freshly-created (non-renewal) contract is waiting on its linked proposal''s pro-rata invoice to be paid. start_date is a placeholder in that state and may still be edited; once TRUE (the default, and always after activation) start_date is locked and the general PATCH route rejects further changes to it.';
COMMENT ON COLUMN contracts.start_date_locked_at IS
  'Timestamp start_date was locked — set when the linked proposal''s pro-rata payment is confirmed at activation, or immediately for contracts that never needed the placeholder state.';
