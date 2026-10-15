-- ============================================================
-- Migration 00606: procurement closed-chain lock — reopen history
--
-- Whether a procurement cycle is "closed" is COMPUTED from the real records
-- (src/lib/procurement/chain-lock.ts), so nothing is stored for that. The one
-- thing that must be stored is an admin reopening a closed cycle: who, when,
-- why. Insert-only history; the latest row restarts the 7-day grace period.
--
-- root_type/root_id name the chain: an MR ('pr'), a PO with no MR ('po'), or a
-- standalone bill ('bill').
-- ============================================================

CREATE TABLE IF NOT EXISTS procurement_chain_reopens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  root_type   TEXT        NOT NULL CHECK (root_type IN ('pr', 'po', 'bill')),
  root_id     UUID        NOT NULL,
  reopened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reopened_by UUID        NOT NULL REFERENCES users(id),
  reason      TEXT        NOT NULL CHECK (length(btrim(reason)) >= 10)
);

CREATE INDEX IF NOT EXISTS idx_chain_reopens_root
  ON procurement_chain_reopens (root_type, root_id, reopened_at DESC);

ALTER TABLE procurement_chain_reopens ENABLE ROW LEVEL SECURITY;

-- Anyone signed in can see that a chain was reopened (the lock banner shows it).
CREATE POLICY "Authenticated users can read chain reopens"
  ON procurement_chain_reopens FOR SELECT
  TO authenticated USING (true);

-- No insert/update/delete policy on purpose: reopens are written only by the
-- admin-checked API route, using the service role.

-- ------------------------------------------------------------
-- Lock cut-off. Only chains that COMPLETED on or after this moment ever lock;
-- everything already finished when this migration ran stays correctable. Set to
-- the time the migration is applied. Change it by updating this row (ISO
-- timestamp). If the row is missing or unparseable, nothing locks.
-- ------------------------------------------------------------
INSERT INTO app_settings (key, value)
VALUES ('procurement_chain_lock_effective_from', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;
