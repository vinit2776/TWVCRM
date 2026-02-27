-- Migration 00037: RLS policies for prepaid_packages, prepaid_purchases, prepaid_redemptions
-- All authenticated users can read; inserts/updates require auth.

-- ── prepaid_packages ─────────────────────────────────────────────────────────
ALTER TABLE prepaid_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read"   ON prepaid_packages FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON prepaid_packages FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON prepaid_packages FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ── prepaid_purchases ─────────────────────────────────────────────────────────
ALTER TABLE prepaid_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read"   ON prepaid_purchases FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON prepaid_purchases FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "auth_update" ON prepaid_purchases FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ── prepaid_redemptions ───────────────────────────────────────────────────────
ALTER TABLE prepaid_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read"   ON prepaid_redemptions FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "auth_insert" ON prepaid_redemptions FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
