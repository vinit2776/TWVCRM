-- Migration: 00039_reclassify_unclassified_vouchers
-- Assigns validity_days = 0.125 (3 Hours) to all vouchers currently
-- stored without a validity period (validity_days IS NULL).
-- Only affects vouchers with status = 'available' (unissued stock).

UPDATE public.voucher_repository
SET    validity_days = 0.125
WHERE  validity_days IS NULL
  AND  status = 'available';
