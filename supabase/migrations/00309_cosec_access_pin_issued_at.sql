-- Track when an access PIN was last issued to a user (separate from enrollment PIN flow).
-- This lets reception staff see "PIN issued at [time]" without storing or displaying the PIN value.
ALTER TABLE cosec_access_users
  ADD COLUMN IF NOT EXISTS pin_issued_at TIMESTAMPTZ;
