-- Fix 11: Database indexes for common lookups
--
-- These indexes speed up the most frequent queries in the booking,
-- billing, and payment verification workflows.

-- Payment verification: booking detail page sums verified payments
CREATE INDEX IF NOT EXISTS idx_booking_payments_booking_status
  ON booking_payments (booking_id, status);

-- Usage charges by contract: billing statement generation
CREATE INDEX IF NOT EXISTS idx_usage_charges_contract
  ON usage_charges (contract_id);

-- Usage charges by booking: post-checkout charge display
CREATE INDEX IF NOT EXISTS idx_usage_charges_booking
  ON usage_charges (booking_id);

-- Usage charges by statement: statement detail page
CREATE INDEX IF NOT EXISTS idx_usage_charges_statement
  ON usage_charges (billing_statement_id);

-- Contract payments by contract: payment history & balance calculations
CREATE INDEX IF NOT EXISTS idx_contract_payments_contract_status
  ON contract_payments (contract_id, status);

-- Facility usage records: billing period aggregation
CREATE INDEX IF NOT EXISTS idx_facility_usage_contract_period
  ON facility_usage_records (contract_id, accounting_period_id);

-- Bookings by date: daily schedule view and availability checks
CREATE INDEX IF NOT EXISTS idx_bookings_date_status
  ON bookings (booking_date, status);

-- Bookings by space+date: availability conflict detection
CREATE INDEX IF NOT EXISTS idx_bookings_space_date
  ON bookings (space_id, booking_date);

-- Prepaid redemptions by purchase: credit balance lookups
CREATE INDEX IF NOT EXISTS idx_prepaid_redemptions_purchase
  ON prepaid_redemptions (purchase_id);
