-- Tag usage_charges with an explicit origin so downstream consumers (the
-- overtime banner on the booking page, the pending-overtime dashboard
-- widget, future reporting) can query reliably instead of string-matching
-- on description, which is free-text and editable via PATCH.
--
-- NOTE: usage_charges already has a `charge_type` column (added by
-- 00281_procurement_consumption_billing.sql, values 'manual'/'stock_transfer')
-- for an unrelated procurement-transfer billing feature — that column is
-- NOT reused here to avoid overloading an existing enum with a different
-- domain's values. This is a separate, purpose-specific column instead.
ALTER TABLE usage_charges
  ADD COLUMN IF NOT EXISTS booking_charge_kind TEXT
    CHECK (booking_charge_kind IN ('quota_overage', 'overtime'));

-- Best-effort historical backfill for existing rows produced by the
-- booking-creation quota logic. Not load-bearing — new rows set
-- booking_charge_kind explicitly at insert time going forward. Rows that
-- don't match stay NULL (manual/ad-hoc charges — no need to tag those).
UPDATE usage_charges
SET booking_charge_kind = 'quota_overage'
WHERE booking_charge_kind IS NULL
  AND contract_facility_id IS NOT NULL
  AND (description LIKE '%Overage:%' OR description LIKE '%within%quota%');

CREATE INDEX IF NOT EXISTS idx_usage_charges_booking_charge_kind_status
  ON usage_charges(booking_charge_kind, status)
  WHERE booking_charge_kind = 'overtime';
