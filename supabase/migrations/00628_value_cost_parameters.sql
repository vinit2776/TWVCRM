-- Cost parameters for the Customer Value cost simulator
-- (docs/plans/customer-value-phase5-cost-simulator.md, PR B).
--
-- The rates and amounts an admin types in: hourly staff cost, cost of capital,
-- pantry per person-day, per-seat housekeeping and so on. They start EMPTY: no
-- rupee value is ever assumed, and a cost line with no input is simply not costed.
--
-- Append-only history. A change is a new row, never an update, so changing a rate
-- cannot rewrite what a past month cost. The value in force for a month is the
-- latest row at that scope whose effective_from is on or before the month; ties on
-- the same date go to the later-created row. A row with a NULL value means
-- "cleared from this date": an override is removed and the broader scope applies
-- again (customer, then center, then global).
--
-- Only an admin can read it (it is cost data); writes go through the admin API
-- with the service role, so there is deliberately no INSERT/UPDATE/DELETE policy.
--
-- Rollback:
--   DROP TABLE value_cost_parameters;

CREATE TABLE value_cost_parameters (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text        NOT NULL CHECK (scope IN ('global', 'location', 'lead')),
  location_id    uuid        REFERENCES locations(id) ON DELETE CASCADE,
  lead_id        uuid        REFERENCES leads(id) ON DELETE CASCADE,
  key            text        NOT NULL CHECK (key IN (
                   'hourly_staff_cost', 'cost_of_capital_pct', 'pantry_per_person_day', 'acquisition_cost',
                   'housekeeping_per_seat', 'maintenance_per_seat', 'front_desk_per_seat', 'internet_per_seat',
                   'overhead_pct')),
  -- NULL = cleared from effective_from (see above).
  value          numeric     CHECK (value IS NULL OR value >= 0),
  effective_from date        NOT NULL,
  set_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT value_cost_parameters_scope_ids CHECK (
    (scope = 'global'   AND location_id IS NULL     AND lead_id IS NULL) OR
    (scope = 'location' AND location_id IS NOT NULL AND lead_id IS NULL) OR
    (scope = 'lead'     AND lead_id IS NOT NULL     AND location_id IS NULL)
  )
);

CREATE INDEX idx_value_cost_parameters_lookup
  ON value_cost_parameters (scope, location_id, lead_id, key, effective_from DESC, created_at DESC);

ALTER TABLE value_cost_parameters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "value_cost_parameters_admin_select" ON value_cost_parameters
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));
