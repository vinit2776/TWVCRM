-- Brings three previously-invisible receivable kinds into AR + the payment
-- follow-up ladder, and captures Razorpay settlement dates.
--
-- Until now AR read only from billing_statements, so an unpaid proposal
-- deposit link, deposit top-up link, or ad-hoc proforma invoice had no
-- ageing and no dunning anywhere. Each needs its own due date and reminder
-- counters — the ladder gates on reminder_count, so counters cannot be
-- shared across kinds.
--
-- Ladder assignment (enforced in src/lib/receivable-reminder.ts):
--   ad-hoc PI        -> full ladder, same as billing statements
--   deposit / top-up -> soft ladder, stages 0-2 only. Never escalates to
--                       management, never re-fires perpetually.

-- ── Proposal security deposit ────────────────────────────────────────────
ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_due_date DATE,
  ADD COLUMN IF NOT EXISTS deposit_reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_last_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_settlement_id TEXT;

-- ── Deposit top-ups ──────────────────────────────────────────────────────
ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS due_date DATE,
  ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_id TEXT;

-- ── Ad-hoc proforma invoices ─────────────────────────────────────────────
-- followup_enabled defaults TRUE so every PI raised from here on joins the
-- ladder automatically. Every PI that already exists is switched OFF below.
ALTER TABLE proforma_invoices
  ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_id TEXT,
  ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Suppress automated dunning for the pre-existing PI backlog ───────────
-- 12 of the 18 open PIs are 30+ days overdue (oldest 142 days) and have
-- never received a reminder. On the full ladder they would land directly on
-- the terminal perpetual stage, which deliberately bypasses the first-fire
-- gate, and with last_reminder_sent_at NULL there is no throttle either —
-- so enabling the ladder would immediately blast months-old invoices with
-- management CC'd, then re-fire every 3 days forever. These stay visible in
-- AR with full ageing for manual collection; only PIs created from here on
-- are dunned automatically.
UPDATE proforma_invoices
   SET followup_enabled = FALSE
 WHERE created_at < NOW();

-- ── Deposit links: due dates for links already out with customers ────────
-- Anchor to when the link was emailed (falling back to row creation) plus
-- the agreed 7-day window.
UPDATE proposals
   SET deposit_due_date = (COALESCE(deposit_email_sent_at, created_at)::date + INTERVAL '7 days')::date
 WHERE deposit_due_date IS NULL
   AND deposit_payment_status = 'pending'
   AND deposit_razorpay_link_id IS NOT NULL;

-- Counters start at 0, which would make the ladder open at stage 0 ("due
-- today") for links that are already months old. Fast-forward past every
-- stage their current age has passed so they resume at the correct rung
-- rather than restarting. The soft ladder tops out at stage 2, so anything
-- 7+ days overdue lands on 3 and goes quiet permanently — which is the
-- intended outcome for stale links.
UPDATE proposals
   SET deposit_reminder_count = CASE
         WHEN CURRENT_DATE - deposit_due_date >= 7 THEN 3
         WHEN CURRENT_DATE - deposit_due_date >= 3 THEN 2
         WHEN CURRENT_DATE - deposit_due_date >= 0 THEN 1
         ELSE 0 END
 WHERE deposit_payment_status = 'pending'
   AND deposit_due_date IS NOT NULL;

-- ── Reminder send log for the new kinds ─────────────────────────────────
-- billing_reminder_sends requires a billing_statement_id, so these need
-- their own audit trail. Same shape, keyed by (kind, receivable_id).
CREATE TABLE IF NOT EXISTS receivable_reminder_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'topup', 'adhoc_invoice')),
  receivable_id UUID NOT NULL,
  stage_index INTEGER NOT NULL,
  stage_label TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  triggered_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_receivable_reminder_sends_lookup
  ON receivable_reminder_sends(kind, receivable_id, created_at DESC);

ALTER TABLE receivable_reminder_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read receivable_reminder_sends" ON receivable_reminder_sends;
CREATE POLICY "Authenticated users can read receivable_reminder_sends"
  ON receivable_reminder_sends FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_proposals_deposit_due
  ON proposals(deposit_due_date) WHERE deposit_payment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_deposit_topups_due
  ON deposit_topups(due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_due
  ON proforma_invoices(due_date);
