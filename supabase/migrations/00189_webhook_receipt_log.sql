-- Migration: razorpay_webhook_log
-- Purpose: Log every inbound Razorpay webhook that passes signature verification.
-- Enables replay and reconciliation if a payment was captured by Razorpay but
-- the corresponding DB write failed.

CREATE TABLE IF NOT EXISTS razorpay_webhook_log (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event                   text        NOT NULL,                   -- e.g. "payment_link.paid"
  razorpay_payment_id     text,                                   -- payment entity id
  razorpay_order_id       text,                                   -- order id (payment.captured)
  razorpay_payment_link_id text,                                  -- payment link id
  entity                  text,                                   -- resolved: proposal | proposal_deposit | booking | billing_statement | prepaid_purchase
  outcome                 text        NOT NULL DEFAULT 'received', -- received | processed | ignored | error
  outcome_detail          text,                                   -- human-readable note
  received_at             timestamptz NOT NULL DEFAULT now()
);

-- Indexes for lookup by payment identifiers (reconciliation queries)
CREATE INDEX IF NOT EXISTS idx_webhook_log_payment_id       ON razorpay_webhook_log (razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_log_payment_link_id  ON razorpay_webhook_log (razorpay_payment_link_id);
CREATE INDEX IF NOT EXISTS idx_webhook_log_received_at      ON razorpay_webhook_log (received_at DESC);

ALTER TABLE razorpay_webhook_log ENABLE ROW LEVEL SECURITY;

-- Only admins can read the webhook log (service role writes it)
CREATE POLICY "admins can view webhook log"
  ON razorpay_webhook_log FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'
    )
  );
