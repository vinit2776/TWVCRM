-- Migration: 00551_booking_facility_substitute_allocation
--
-- Problem: a contract customer's hour-based quota (contract_facilities) is
-- resolved to a booking purely by matching the booked space's name against
-- the facility name (see bookings/route.ts and the pooled-usage checkout
-- handler). When staff give a contract customer a *different* room than
-- the one their quota is meant for — e.g. the Conference Room is occupied
-- by a walk-in, so they're given an empty cabin instead — the name match
-- fails silently and the booking never draws down the customer's quota.
-- The substitution goes untracked entirely.
--
-- This adds an explicit staff override so a booking can be attributed to a
-- specific contract_facilities quota regardless of the space actually
-- booked, plus a resolution-status column so ambiguous/unmatched cases
-- (2+ hour-based facilities on a contract, no name match, no override) are
-- flagged for review instead of silently guessed.

ALTER TABLE bookings
  ADD COLUMN contract_facility_id_override UUID REFERENCES contract_facilities(id) ON DELETE SET NULL,
  ADD COLUMN facility_override_reason TEXT,
  ADD COLUMN facility_resolution VARCHAR(20);

CREATE INDEX idx_bookings_facility_override ON bookings(contract_facility_id_override) WHERE contract_facility_id_override IS NOT NULL;
CREATE INDEX idx_bookings_facility_unresolved ON bookings(facility_resolution) WHERE facility_resolution = 'unresolved';

COMMENT ON COLUMN bookings.contract_facility_id_override IS
  'Explicit staff override of which contract_facilities row this booking''s quota is drawn against — used when the booked space differs from the facility name (e.g. a cabin standing in for an occupied conference room). Bypasses name-based auto-matching at both booking creation and checkout pooling. Must belong to the same contract_id as the booking.';

COMMENT ON COLUMN bookings.facility_override_reason IS
  'Required staff-entered reason when contract_facility_id_override is set. Logged to audit_trail and shown to Accounts.';

COMMENT ON COLUMN bookings.facility_resolution IS
  'How this booking''s hour-based quota facility was determined: auto_matched (single facility or unambiguous name match), override (staff-specified via contract_facility_id_override), unresolved (2+ hour-based facilities on the contract, no name match, no override supplied — needs manual review by Accounts), or NULL when the contract has no hour-based facility at all (not applicable).';
