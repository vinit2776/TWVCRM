-- Our standard monthly price per seat, by workspace type and (optionally) location. The Leads
-- overview uses it to estimate what an enquiry could be worth when the customer gave no budget
-- and nobody quoted; those estimates are always shown as "est.".
-- location_id NULL = the default for every location that has no row of its own.
CREATE TABLE IF NOT EXISTS lead_rate_card (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id           uuid REFERENCES locations(id) ON DELETE CASCADE,
  workspace_type        text NOT NULL,
  monthly_rate_per_seat numeric(12,2) NOT NULL CHECK (monthly_rate_per_seat > 0),
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_rate_card_unique
  ON lead_rate_card (coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), workspace_type);

ALTER TABLE lead_rate_card ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_rate_card_select_authenticated" ON lead_rate_card;
CREATE POLICY "lead_rate_card_select_authenticated"
  ON lead_rate_card FOR SELECT TO authenticated USING (true);
-- Writes go through the API (service role), which checks the role.

-- Rollback: DROP TABLE IF EXISTS lead_rate_card;
