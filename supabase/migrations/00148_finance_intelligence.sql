-- ============================================================
-- Migration 00148: Finance Intelligence (Phase 1 Foundation)
-- ============================================================
-- Sets up the substrate every "self-learning" finance feature will share:
--
--  1. finance_suggestion_log  — audit trail of every suggestion the
--     system made and what the user actually did with it. Lets us
--     measure feature effectiveness ("65% of batch-date suggestions
--     accepted") and surface noisy features for removal.
--
--  2. app_settings keys       — master enable + per-feature toggles +
--     configurable lookback window for history-based suggestions.
--
-- The 90-day retention policy is documented but enforced by an
-- application-level cleanup job (not a DB trigger) — Supabase's free
-- tier doesn't include pg_cron in all regions.
-- ============================================================

-- ─── 1. finance_suggestion_log ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance_suggestion_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature         TEXT NOT NULL,            -- 'batch_date' | 'duplicate_detector' | 'amount_anomaly' | etc.
  entity_type     TEXT NOT NULL,            -- 'vendor_bill' | 'purchase_order' | 'gst_invoice' | ...
  entity_id       UUID,                     -- the entity the suggestion was attached to (may be NULL pre-create)
  suggestion      JSONB,                    -- what we suggested
  user_action     TEXT,                     -- 'accepted' | 'overridden' | 'dismissed' | 'ignored' | 'shown'
  user_value      JSONB,                    -- what the user ultimately chose / saved
  context         JSONB,                    -- supporting data (vendor_id, total_amount, …) for analysis
  triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,              -- set when user takes a final action
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),

  CONSTRAINT finance_suggestion_log_user_action_check
    CHECK (user_action IS NULL OR user_action IN ('shown', 'accepted', 'overridden', 'dismissed', 'ignored'))
);

CREATE INDEX IF NOT EXISTS idx_finance_suggestion_log_feature
  ON finance_suggestion_log(feature);
CREATE INDEX IF NOT EXISTS idx_finance_suggestion_log_entity
  ON finance_suggestion_log(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finance_suggestion_log_triggered_at
  ON finance_suggestion_log(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_suggestion_log_expires
  ON finance_suggestion_log(expires_at) WHERE resolved_at IS NULL;

-- ─── 2. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE finance_suggestion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read finance_suggestion_log"   ON finance_suggestion_log;
DROP POLICY IF EXISTS "Authenticated users can insert finance_suggestion_log" ON finance_suggestion_log;
DROP POLICY IF EXISTS "Authenticated users can update finance_suggestion_log" ON finance_suggestion_log;

CREATE POLICY "Authenticated users can read finance_suggestion_log"
  ON finance_suggestion_log FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert finance_suggestion_log"
  ON finance_suggestion_log FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update finance_suggestion_log"
  ON finance_suggestion_log FOR UPDATE USING (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE         ON public.finance_suggestion_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance_suggestion_log TO service_role;

-- ─── 3. Seed default settings ────────────────────────────────────────────────

INSERT INTO app_settings (key, value, is_encrypted) VALUES
  -- Master toggle
  ('finance_intelligence_enabled',           'true',  false),
  -- Default lookback window for history-based suggestions
  ('finance_intelligence_lookback_months',   '6',     false),
  -- Audit-log retention (days)
  ('finance_intelligence_log_retention_days','90',    false),

  -- Per-feature toggles (default ON — operator can disable any)
  ('fi_feature_duplicate_detector',          'true',  false),
  ('fi_feature_po_mismatch_alert',           'true',  false),
  ('fi_feature_due_date_learning',           'true',  false),
  ('fi_feature_batch_date_suggestion',       'true',  false),
  ('fi_feature_amount_anomaly',              'true',  false),
  ('fi_feature_repeat_charge_autofill',      'true',  false),
  ('fi_feature_description_templates',       'true',  false),
  ('fi_feature_invoice_gap_audit',           'true',  false)
ON CONFLICT (key) DO NOTHING;
