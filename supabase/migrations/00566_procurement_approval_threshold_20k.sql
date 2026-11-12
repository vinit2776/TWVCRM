-- ============================================================
-- Migration 00566: Lower procurement approval threshold to ₹20,000
-- MRs above this amount already require admin approval (see 00023);
-- this lowers the amount from ₹25,000 to ₹20,000 per business request.
-- ============================================================

INSERT INTO app_settings (key, value)
VALUES ('procurement_approval_threshold', '20000')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
