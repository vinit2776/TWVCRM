-- Migration: 00301_facility_assets_photos.sql
-- Add photos jsonb column to facility_assets for optional reference photos.
-- Each entry: { url: string, path: string, size: number }

ALTER TABLE facility_assets
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;
