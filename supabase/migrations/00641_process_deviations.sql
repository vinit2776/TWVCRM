-- One place to record "someone stepped off the standard path", so it can be
-- reviewed and coached on, whichever module it happened in.
--
-- The app already asks for a reason when someone deviates (contract payment
-- override, admin rollbacks, "Bill anyway", waivers, ...), but each lands in
-- its own column or audit row and none can be compared. This table is the
-- shared record. It is NOT a gate: the deviation has already been allowed and
-- the transaction has gone through. Recording it never blocks anything.
--
-- First adopter: booking.late_close_out (a booking closed out after its date
-- without a check-in/check-out).

CREATE TABLE process_deviations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What deviated. process_key groups a flow ("booking"); deviation_type is the
  -- specific lapse ("late_close_out"). Both are defined in code
  -- (src/lib/process-registry.ts), kept as plain text so adding one is not a
  -- migration.
  process_key           TEXT NOT NULL,
  deviation_type        TEXT NOT NULL,

  -- The record it happened on, and the centre it belongs to.
  entity_type           TEXT NOT NULL,
  entity_id             UUID NOT NULL,
  location_id           UUID REFERENCES locations(id) ON DELETE SET NULL,

  -- When the step should have happened (e.g. the booking date), against when
  -- it was recorded. The gap is the "days late" figure.
  due_on                DATE,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who did the recording, and who the deviation counts against. They differ
  -- on purpose: the person who tidies up a missed check-in should not carry
  -- the lapse of the person who allowed it.
  recorded_by           UUID NOT NULL REFERENCES users(id),
  accountable_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,

  reason_code           TEXT NOT NULL,
  comment               TEXT,

  -- Reasons that are not the person's fault (a system outage) are still
  -- recorded, but excluded from per-person rates.
  counts_against_person BOOLEAN NOT NULL DEFAULT true,

  -- Money on the line, when there is a figure.
  amount_at_stake       NUMERIC(12,2),
  details               JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Review loop: a flag nobody looks at is noise.
  reviewed_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  review_outcome        TEXT CHECK (review_outcome IN ('coaching_done', 'process_fix', 'fine_as_is')),
  review_note           TEXT,

  CONSTRAINT process_deviations_reviewed_together CHECK (
    (reviewed_at IS NULL) = (review_outcome IS NULL)
  )
);

-- A given entity deviates in a given way once. Re-closing or a retried request
-- must not double-count a person.
CREATE UNIQUE INDEX uq_process_deviations_entity_type
  ON process_deviations (deviation_type, entity_id);

CREATE INDEX idx_process_deviations_person   ON process_deviations (accountable_user_id, recorded_at DESC);
CREATE INDEX idx_process_deviations_process  ON process_deviations (process_key, deviation_type, recorded_at DESC);
CREATE INDEX idx_process_deviations_location ON process_deviations (location_id, recorded_at DESC);
CREATE INDEX idx_process_deviations_open     ON process_deviations (recorded_at DESC) WHERE reviewed_at IS NULL;

ALTER TABLE process_deviations ENABLE ROW LEVEL SECURITY;

-- Rows are written by the server with the service role. Reads are limited to
-- the people who coach: this is a coaching record, not a public scoreboard.
CREATE POLICY "Managers can read process_deviations"
  ON process_deviations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.auth_id = auth.uid() AND u.role IN ('admin', 'manager')
    )
  );

COMMENT ON TABLE process_deviations IS
  'A step taken off the standard path, recorded for review and coaching. Never a gate: the action has already happened. See src/lib/process-registry.ts.';

-- ── Bookings: a light marker for badges and reports ────────────────────────
-- check_in_at / check_out_at stay NULL on a late close-out, so reports can tell
-- real usage from assumed usage. These columns carry the "closed late" fact
-- without joining process_deviations on every booking list.
ALTER TABLE bookings
  ADD COLUMN closed_out_late BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN closed_out_at   TIMESTAMPTZ,
  ADD COLUMN closed_out_by   UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN bookings.closed_out_late IS
  'True when the booking was completed via Close out after its date, with no recorded check-in/check-out times. Billed as booked.';

NOTIFY pgrst, 'reload schema';
