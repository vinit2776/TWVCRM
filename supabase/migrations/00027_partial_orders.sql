-- Sprint 3.9: Partial ordering support
-- Add new enum values for partial ordering workflows

ALTER TYPE pr_status ADD VALUE IF NOT EXISTS 'partially_ordered';
ALTER TYPE po_status ADD VALUE IF NOT EXISTS 'partially_cancelled';
