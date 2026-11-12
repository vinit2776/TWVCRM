-- Contract rent waivers
-- An admin's decision that a missed rent month will NOT be billed through the
-- CRM (e.g. collected outside the CRM, or deliberately not charged). A waived
-- month drops off the Billing → Unbilled rent-gap list and the contract page's
-- "missing rent" prompt. It does not block billing: the month can still be
-- raised from the contract page, and a real statement for it always wins.
--
-- Distinct from contract_billing_moratoriums (00310), which is a commercial
-- rent-free month with its own request/approve workflow and per-contract cap.
--
-- Undo = set revoked_at; rows are never deleted so the history stays visible.
-- Writes go through /api/contracts/[id]/rent-waivers (admin only, service
-- role), so there is no INSERT/UPDATE policy for authenticated users.

CREATE TABLE contract_rent_waivers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  -- First day of the waived (prepaid) rent month, e.g. 2026-10-01
  waived_month  date NOT NULL CHECK (EXTRACT(DAY FROM waived_month) = 1),
  reason        text NOT NULL,
  waived_by     uuid REFERENCES users(id),
  waived_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id)
);

-- At most one live waiver per contract per month
CREATE UNIQUE INDEX contract_rent_waivers_live_uniq
  ON contract_rent_waivers (contract_id, waived_month)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_contract_rent_waivers_contract
  ON contract_rent_waivers (contract_id);

ALTER TABLE contract_rent_waivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contract_rent_waivers_select" ON contract_rent_waivers
  FOR SELECT TO authenticated USING (true);

-- Rollback:
--   DROP TABLE contract_rent_waivers;
