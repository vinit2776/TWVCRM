-- Payments the customer made outside the CRM, reported by whoever the
-- customer told.
--
-- The gap this closes: a customer pays by NEFT against a bank advice rather
-- than the Razorpay link, WhatsApps the screenshot to whoever they deal with,
-- and accounts never hear about it in a form they can reconcile. They see an
-- unexplained bank credit (often under a *different* remitter name) and an
-- invoice that still shows unpaid, with nothing joining the two.
--
-- A report is a `queries` thread (kind = 'payment_reported') plus the
-- structured fields accounts actually need to find the credit in the bank.
-- Reusing the thread buys the whole clarification loop for free: attachments
-- for the screenshot (00423), audience targeting so it lands on accounts,
-- needed_by + the nudge/escalate cron so an unverified claim chases itself,
-- and an append-only timeline that doubles as the audit trail.
--
-- WHAT THIS TABLE IS NOT: a payment. Nothing here touches billing_payments,
-- amount_paid or balance_due. A customer's screenshot is a claim, not a
-- receipt — receivables move only when accounts have seen the credit in the
-- bank and pressed Verify, which writes a real billing_payments row through
-- the existing POST /api/billing-statements/[id]/payment and records its id
-- in billing_payment_id. Until then this is advisory only.
--
-- Reports hang off the *contract*, not a statement: the reporter usually
-- knows the customer, not which invoice was paid — that is the whole point of
-- the gap. Allocation to a statement is accounts' job at verify time.

CREATE TABLE query_payment_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE: one report per thread. A second payment is a second thread, so
  -- each claim keeps its own conversation, own chase clock and own outcome.
  query_id           UUID NOT NULL UNIQUE REFERENCES queries(id) ON DELETE CASCADE,

  -- ── What the customer says they paid ────────────────────────────────────
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  paid_on            DATE NOT NULL,
  payment_mode       TEXT NOT NULL,
  -- UTR / cheque number / UPI ref. Nullable because a reporter forwarding a
  -- screenshot often doesn't have it, and refusing the report for that would
  -- push them back to WhatsApp — which is the behaviour being replaced.
  payment_reference  TEXT,

  -- ── Who it came from ────────────────────────────────────────────────────
  -- The name on the remitting account. This is the second half of the gap:
  -- customers pay from a director's personal account or a sister concern, and
  -- accounts can't tie the credit to the contract without being told.
  payer_name         TEXT,
  payer_differs      BOOLEAN NOT NULL DEFAULT false,

  -- ── Outcome ─────────────────────────────────────────────────────────────
  -- reported  — claimed, not yet found in the bank
  -- verified  — matched to a bank credit and recorded (billing_payment_id set)
  -- rejected  — settled as "no such payment"; NOT the same as "can't find it
  --             yet", which leaves the report at 'reported' so the chase cron
  --             keeps working it. Only a genuinely bogus claim ends here.
  status             TEXT NOT NULL DEFAULT 'reported'
                       CHECK (status IN ('reported', 'verified', 'rejected')),
  billing_payment_id UUID REFERENCES billing_payments(id) ON DELETE SET NULL,
  -- Why it was rejected, or which bank line matched on verify.
  resolution_note    TEXT,
  reviewed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,

  created_by         UUID NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A verified report without the payment it produced is the exact
  -- disconnection this feature exists to remove, so the DB refuses it.
  CONSTRAINT query_payment_reports_verified_has_payment CHECK (
    status <> 'verified' OR billing_payment_id IS NOT NULL
  ),
  -- Rejecting someone's report without saying why sends them back to
  -- WhatsApp to ask. Make the reason mandatory at the point it's cheapest.
  CONSTRAINT query_payment_reports_rejected_has_reason CHECK (
    status <> 'rejected' OR (resolution_note IS NOT NULL AND length(trim(resolution_note)) > 0)
  ),
  CONSTRAINT query_payment_reports_reviewed_together CHECK (
    (status = 'reported') = (reviewed_at IS NULL)
  )
);

CREATE INDEX idx_qpr_query   ON query_payment_reports (query_id);
CREATE INDEX idx_qpr_status  ON query_payment_reports (status);
-- Drives the "reported, unverified" figures on the AR page.
CREATE INDEX idx_qpr_pending ON query_payment_reports (paid_on DESC) WHERE status = 'reported';

CREATE TRIGGER update_query_payment_reports_updated_at
  BEFORE UPDATE ON query_payment_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE query_payment_reports ENABLE ROW LEVEL SECURITY;

-- Role gating lives in the app layer, same convention as queries /
-- query_messages (00421) and query_attachments (00423). Reporting is
-- deliberately open to every authenticated user — like petty cash entry —
-- because the customer tells whoever they deal with, and a role gate here
-- would just recreate the gap for everyone outside it. Accounts are the
-- control point: nothing becomes money without their verification.
CREATE POLICY "Authenticated users can read query_payment_reports"
  ON query_payment_reports FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert query_payment_reports"
  ON query_payment_reports FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update query_payment_reports"
  ON query_payment_reports FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ── queries.kind gains the new sort of thread ──────────────────────────────
ALTER TABLE queries DROP CONSTRAINT IF EXISTS queries_kind_check;
ALTER TABLE queries ADD  CONSTRAINT queries_kind_check
  CHECK (kind IN ('question', 'action_needed', 'payment_reported'));

-- ── Timeline events for the two outcomes ───────────────────────────────────
-- Verification and rejection join the typed timeline for the same reason
-- 'resolved' and 'retargeted' did: the outcome belongs inline with the
-- conversation that produced it, not in a field nobody scrolls to.
ALTER TABLE query_messages DROP CONSTRAINT IF EXISTS query_messages_event_type_check;
ALTER TABLE query_messages ADD  CONSTRAINT query_messages_event_type_check
  CHECK (event_type IN (
    'message', 'resolved', 'reopened', 'retargeted', 'nudged',
    'payment_verified', 'payment_rejected'
  ));

COMMENT ON TABLE query_payment_reports IS
  'An out-of-system payment reported by ops against a contract, pending verification by accounts. Advisory only until status = verified, at which point billing_payment_id points at the real payment. See src/lib/queries/payment-reports.ts.';
COMMENT ON COLUMN query_payment_reports.payer_name IS
  'Name on the remitting account. Set when the customer paid from an account other than the contracting entity, which is otherwise unmatchable against the bank statement.';
COMMENT ON COLUMN query_payment_reports.status IS
  'reported = claimed, not found in bank yet (still chased by the query nudge cron); verified = matched and recorded; rejected = settled as no such payment.';

NOTIFY pgrst, 'reload schema';
