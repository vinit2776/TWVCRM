-- ============================================================
-- 00362: Catch-up migration for facility_asset_categories assignee columns
--
-- default_assignee_id and backup_assignee_id have been referenced throughout
-- the app (src/app/api/facility/issues/route.ts, src/app/api/facility/
-- categories/[id]/route.ts, src/app/(dashboard)/facility/settings/page.tsx,
-- src/types/index.ts) and already exist in production, but no migration
-- file ever created them — they were applied out-of-band. This closes that
-- drift so a fresh environment (`npx supabase db push`) matches prod.
-- IF NOT EXISTS makes this a no-op where the columns already exist.
-- ============================================================

ALTER TABLE facility_asset_categories
  ADD COLUMN IF NOT EXISTS default_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backup_assignee_id UUID REFERENCES users(id) ON DELETE SET NULL;
