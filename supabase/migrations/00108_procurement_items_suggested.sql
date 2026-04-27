-- Add is_suggested column to procurement_items to distinguish catalog suggestions
-- (submitted by non-admin users via the PR form) from archived/inactive items.
-- is_suggested = true means: draft entry awaiting admin review, not yet published.

ALTER TABLE procurement_items
  ADD COLUMN IF NOT EXISTS is_suggested BOOLEAN NOT NULL DEFAULT false;
