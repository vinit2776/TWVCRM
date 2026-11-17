-- Promotions the team runs (an ad push, an offer, an event) so the Leads overview can mark on the
-- enquiry-inflow chart when one was running and the team can see what it brought. Entered by hand;
-- reading spend from the ad accounts is a possible later step.
CREATE TABLE IF NOT EXISTS lead_promotions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- NULL = not tied to one source (an offer that runs everywhere).
  source      text,
  starts_on   date NOT NULL,
  -- NULL = still running.
  ends_on     date,
  spend       numeric(12,2) CHECK (spend IS NULL OR spend >= 0),
  notes       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS lead_promotions_dates_idx ON lead_promotions (starts_on, ends_on);

ALTER TABLE lead_promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_promotions_select_authenticated" ON lead_promotions;
CREATE POLICY "lead_promotions_select_authenticated"
  ON lead_promotions FOR SELECT TO authenticated USING (true);
-- Writes go through the API (service role), which checks the role.

-- Rollback: DROP TABLE IF EXISTS lead_promotions;
