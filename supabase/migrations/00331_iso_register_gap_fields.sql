-- Small additive fields needed to complete three ISO 9001 register exports
-- (IT Asset Register SDI/ITSS/F/01, Seat Occupancy Tracker SDI/OPFM/F/09,
-- Conference Room Booking Log SDI/OPFM/F/10) at src/app/api/admin/iso-registers/.
-- All nullable, no backfill, no behavior change to existing rows/queries.

ALTER TABLE facility_assets
  ADD COLUMN IF NOT EXISTS assigned_department TEXT,
  ADD COLUMN IF NOT EXISTS next_service_due DATE;

COMMENT ON COLUMN facility_assets.assigned_department IS
  'Free-text department/employee the asset is assigned to. Deliberately not named assigned_to or typed as a UUID FK — facility_issues.assigned_to already uses that name for its own user-picker/claim workflow; this is a simpler free-text field matching department_budgets.department.';
COMMENT ON COLUMN facility_assets.next_service_due IS
  'Next scheduled preventive-maintenance date, entered manually. Distinct from the AMC service-token due dates.';

ALTER TABLE space_seat_occupants
  ADD COLUMN IF NOT EXISTS loi_number TEXT;

COMMENT ON COLUMN space_seat_occupants.loi_number IS
  'Client''s internal Letter of Intent / agreement reference (e.g. "#00251-A"). No equivalent exists elsewhere in the schema — entered manually.';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS loi_number TEXT,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS access_provided_by TEXT;

COMMENT ON COLUMN bookings.loi_number IS
  'Client''s internal Letter of Intent / agreement reference, same convention as space_seat_occupants.loi_number.';
COMMENT ON COLUMN bookings.purpose IS
  'Purpose of the meeting/booking. Optional metadata field, no business logic depends on it.';
COMMENT ON COLUMN bookings.access_provided_by IS
  'Name/role of the staff member who granted floor access for this booking. Optional metadata field.';
