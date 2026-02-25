-- ============================================================
-- Migration 00023: Procurement approval settings seed
-- Seeds default procurement threshold into app_settings table.
-- The UI/API will upsert to update; this ensures a row exists.
-- ============================================================

-- Approval threshold: PRs above this INR amount require admin.
-- Default: ₹25,000
INSERT INTO app_settings (key, value)
VALUES ('procurement_approval_threshold', '25000')
ON CONFLICT (key) DO NOTHING;
