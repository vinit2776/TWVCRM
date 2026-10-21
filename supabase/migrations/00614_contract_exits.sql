-- Contract exit workflow, part 1 (notice, inspection charges, completion).
--
-- An exit records the customer's notice and last day, the inspection charges
-- raised against the deposit, and when the exit was completed (the contract
-- terminated). It moves no money: the refund, admin approval and payment are a
-- later migration. Nothing here is ever sent to a customer.
--
-- Rollback: DROP TABLE contract_exit_charges; DROP TABLE contract_exits;

CREATE TABLE IF NOT EXISTS contract_exits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id           UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'in_notice'
                          CHECK (status IN ('in_notice', 'completed', 'cancelled')),
  notice_received_on    DATE NOT NULL,
  last_day              DATE NOT NULL,
  reason                TEXT NOT NULL,
  -- last_day falls before the contract's own end_date at the time notice is recorded.
  is_early_exit         BOOLEAN NOT NULL DEFAULT FALSE,
  started_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inspection_done_at    TIMESTAMPTZ,
  inspection_done_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at          TIMESTAMPTZ,
  completed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (last_day >= notice_received_on)
);

-- One live exit per contract; a cancelled one does not block starting again.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_exits_one_live
  ON contract_exits (contract_id) WHERE status IN ('in_notice', 'completed');
CREATE INDEX IF NOT EXISTS idx_contract_exits_contract ON contract_exits (contract_id);

CREATE TABLE IF NOT EXISTS contract_exit_charges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exit_id       UUID NOT NULL REFERENCES contract_exits(id) ON DELETE CASCADE,
  charge_type   TEXT NOT NULL
                  CHECK (charge_type IN ('breakage', 'painting', 'missing_item', 'extra_use', 'other')),
  description   TEXT NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ,
  -- Set once a charge is changed after it was first added, so the approver can see it.
  edited_after_add BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_contract_exit_charges_exit ON contract_exit_charges (exit_id);

ALTER TABLE contract_exits ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_exit_charges ENABLE ROW LEVEL SECURITY;

-- Reads for signed-in staff; every write goes through the API with the service role.
CREATE POLICY "contract_exits_select" ON contract_exits FOR SELECT TO authenticated USING (true);
CREATE POLICY "contract_exit_charges_select" ON contract_exit_charges FOR SELECT TO authenticated USING (true);
GRANT SELECT ON contract_exits, contract_exit_charges TO authenticated;
GRANT ALL ON contract_exits, contract_exit_charges TO service_role;
