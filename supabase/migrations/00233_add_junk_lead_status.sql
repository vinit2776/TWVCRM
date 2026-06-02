-- Add 'junk' to the lead_status enum for tracking invalid / wrong leads.
-- This allows sales staff to mark leads that are spam, duplicates, or have
-- incorrect contact details, so they are captured for tracking without
-- cluttering the active pipeline.
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'junk';
