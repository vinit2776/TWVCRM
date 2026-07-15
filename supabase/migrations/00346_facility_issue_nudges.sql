-- ============================================================
-- 00343: Facility Issue Nudges
--
-- Manual "ask for update" action on a Work Order / Task. One row per
-- channel per send (mirrors billing_reminder_sends). WhatsApp status
-- is also mirrored into whatsapp_messages via the existing MSG91
-- webhook (entity_type='facility_issue_nudge'); push delivered/clicked
-- status lives in the existing push_delivery_log (batch_id = this row's
-- id); email delivered/opened status is server-owned via a tracking
-- pixel — no client write path needed for any of these updates, so no
-- UPDATE policy is granted here beyond the service role.
-- ============================================================

CREATE TABLE IF NOT EXISTS facility_issue_nudges (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id       UUID NOT NULL REFERENCES facility_issues(id) ON DELETE CASCADE,
  channel        VARCHAR(20) NOT NULL CHECK (channel IN ('push', 'whatsapp', 'email')),
  status         VARCHAR(20) NOT NULL DEFAULT 'sent'
                 CHECK (status IN ('sent', 'delivered', 'read', 'opened', 'failed')),
  sent_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at      TIMESTAMPTZ,   -- email only, via tracking pixel
  provider_ref   TEXT,          -- wa_message_id (whatsapp) / batch_id (push) / null (email)
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fac_nudges_issue ON facility_issue_nudges(issue_id, created_at DESC);

ALTER TABLE facility_issue_nudges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fac_nudges_select" ON facility_issue_nudges;
DROP POLICY IF EXISTS "fac_nudges_insert" ON facility_issue_nudges;

CREATE POLICY "fac_nudges_select" ON facility_issue_nudges
  FOR SELECT TO authenticated USING (true);

-- Inserts always go through the admin client from the nudge-send route
-- (needs to write immediately after dispatching each channel), but this
-- policy is kept for consistency with facility_issue_events and in case
-- a future client-side write path is added.
CREATE POLICY "fac_nudges_insert" ON facility_issue_nudges
  FOR INSERT TO authenticated WITH CHECK (true);
