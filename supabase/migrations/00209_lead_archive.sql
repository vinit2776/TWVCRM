-- Soft-disable ("archive") support for leads.
-- A hard DELETE on a lead cascades (ON DELETE CASCADE) to proposals,
-- contracts, billing statements, vouchers and more. To stop accidental
-- data loss, non-admin users now disable a lead instead of deleting it.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_archived_at ON leads (archived_at);
