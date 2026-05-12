-- Settlement cache: stores per-payment settlement data synced from Razorpay recon API.
-- Populated by POST /api/finance/gateway-activity/sync.
-- Used by the Gateway Activity finance page for bank reconciliation.

CREATE TABLE IF NOT EXISTS razorpay_settlement_cache (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_payment_id TEXT        NOT NULL UNIQUE,
  settled             BOOLEAN     NOT NULL DEFAULT FALSE,
  settlement_id       TEXT,
  settlement_utr      TEXT,         -- matches the UTR that appears in your bank statement
  settled_at          TIMESTAMPTZ,
  fee                 DECIMAL(10,2),
  tax                 DECIMAL(10,2),
  payment_method      TEXT,         -- card / upi / netbanking / wallet
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rzp_settlement_cache_payment_id ON razorpay_settlement_cache(razorpay_payment_id);
CREATE INDEX IF NOT EXISTS idx_rzp_settlement_cache_settled     ON razorpay_settlement_cache(settled);
CREATE INDEX IF NOT EXISTS idx_rzp_settlement_cache_settled_at  ON razorpay_settlement_cache(settled_at);

-- Allow authenticated reads; restrict writes to service role (sync job).
ALTER TABLE razorpay_settlement_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read razorpay_settlement_cache"
  ON razorpay_settlement_cache FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Track when the last sync was run so the UI can show "Last synced X min ago".
CREATE TABLE IF NOT EXISTS razorpay_sync_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  months_back  INT         NOT NULL DEFAULT 2,
  records_updated INT      NOT NULL DEFAULT 0,
  error_message TEXT
);

ALTER TABLE razorpay_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read razorpay_sync_log"
  ON razorpay_sync_log FOR SELECT
  USING (auth.uid() IS NOT NULL);
