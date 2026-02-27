-- Sprint 3.17: Add 'bookings' as a valid credit_type for prepaid packages.
-- 'bookings' is mechanically identical to 'days' (1 credit per booking visit)
-- but is labelled "Booking Slots" in the UI — semantically clearer for
-- customers who buy bulk walk-in slots without pre-booking dates.

-- PostgreSQL CHECK constraints cannot be altered in-place; drop and re-add.
ALTER TABLE prepaid_packages
  DROP CONSTRAINT IF EXISTS prepaid_packages_credit_type_check;

ALTER TABLE prepaid_packages
  ADD CONSTRAINT prepaid_packages_credit_type_check
  CHECK (credit_type IN ('hours', 'days', 'bookings'));
