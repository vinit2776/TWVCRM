-- Auto-renewal part 4a: customer notices.
--
-- One row per notice the customer is (or was) going to get about a renewal: the
-- rate notice (#1) and the rate confirmation reminder. The system prepares the
-- draft, a person reviews / edits / approves it, and it goes out by email on its
-- scheduled day. Nothing here changes a contract or its billing.
--
-- Rollback: DROP TABLE auto_renewal_notices;
--           DELETE FROM app_settings WHERE key = 'auto_renew_notice_mode';

CREATE TABLE IF NOT EXISTS auto_renewal_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notice', 'confirmation')),
  -- The end date of the term being renewed: keeps one notice per term even if the
  -- job runs again, and lets a later term have its own.
  term_end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'failed', 'cancelled')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients TEXT[] NOT NULL DEFAULT '{}',
  -- Figures the notice states, frozen when it is drafted (ex GST, per month).
  current_rent NUMERIC(12,2) NOT NULL,
  new_rent NUMERIC(12,2) NOT NULL,
  escalation_percentage NUMERIC(5,2) NOT NULL,
  renewal_start_date DATE NOT NULL,
  send_on DATE NOT NULL,
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  -- NULL sent_by = sent by the daily job from an approved notice.
  sent_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A term has at most one live or delivered notice of each kind. A cancelled or
-- failed one can be replaced.
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_renewal_notices_live
  ON auto_renewal_notices (contract_id, kind, term_end_date)
  WHERE status IN ('draft', 'approved', 'sending', 'sent');

CREATE INDEX IF NOT EXISTS idx_auto_renewal_notices_contract ON auto_renewal_notices (contract_id);
CREATE INDEX IF NOT EXISTS idx_auto_renewal_notices_due
  ON auto_renewal_notices (send_on) WHERE status = 'approved';

ALTER TABLE auto_renewal_notices ENABLE ROW LEVEL SECURITY;

-- Staff read through the user-scoped client; every write goes through an API
-- route using the service role, so there is no insert/update policy.
DROP POLICY IF EXISTS "auto_renewal_notices_select" ON auto_renewal_notices;
CREATE POLICY "auto_renewal_notices_select" ON auto_renewal_notices
  FOR SELECT TO authenticated USING (true);

-- Whether the daily job prepares drafts and sends approved notices.
-- off / dry_run / live. Anything else reads as dry_run. dry_run prepares nothing.
INSERT INTO app_settings (key, value) VALUES ('auto_renew_notice_mode', 'dry_run')
  ON CONFLICT (key) DO NOTHING;
