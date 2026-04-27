-- Track individual people occupying specific seats within a space unit,
-- linked to a contract. Supports transfer (shift) with full audit trail.

CREATE TABLE space_seat_occupants (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  space_unit_id       uuid        NOT NULL REFERENCES space_units(id) ON DELETE CASCADE,
  contract_id         uuid        NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  location_id         uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  -- Optional label for the specific seat within the unit, e.g. "A1", "Desk 3"
  seat_label          text,
  -- Person details
  occupant_name       text        NOT NULL,
  occupant_email      text,
  occupant_phone      text,
  -- Tenure
  start_date          date        NOT NULL DEFAULT CURRENT_DATE,
  end_date            date,
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'ended', 'transferred')),
  -- Transfer chain: points to the new record when status = 'transferred'
  transferred_to_id   uuid        REFERENCES space_seat_occupants(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX space_seat_occupants_space_unit_idx  ON space_seat_occupants(space_unit_id);
CREATE INDEX space_seat_occupants_contract_idx    ON space_seat_occupants(contract_id);
CREATE INDEX space_seat_occupants_location_idx    ON space_seat_occupants(location_id);
CREATE INDEX space_seat_occupants_status_idx      ON space_seat_occupants(status);

-- RLS: all authenticated users can read; any authenticated user can write
-- (mirrors contract_space_allocations policy)
ALTER TABLE space_seat_occupants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth users can read seat occupants"
  ON space_seat_occupants FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "auth users can insert seat occupants"
  ON space_seat_occupants FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "auth users can update seat occupants"
  ON space_seat_occupants FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth users can delete seat occupants"
  ON space_seat_occupants FOR DELETE
  TO authenticated USING (true);

-- Auto-update updated_at (reuse existing trigger function)
CREATE TRIGGER set_space_seat_occupants_updated_at
  BEFORE UPDATE ON space_seat_occupants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
