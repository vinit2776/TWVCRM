-- Enrich razorpay_settlement_cache with payment-level fields from the recon API.
-- This lets the Gateway Activity page use the cache as the PRIMARY source so that
-- all synced Razorpay payments appear in the list, even those the CRM webhook missed.

ALTER TABLE razorpay_settlement_cache
  ADD COLUMN IF NOT EXISTS amount          DECIMAL(12,2),         -- gross payment amount (INR)
  ADD COLUMN IF NOT EXISTS order_id        TEXT,                  -- razorpay order_id (links to booking_payments)
  ADD COLUMN IF NOT EXISTS payment_created_at TIMESTAMPTZ;        -- when the payment was captured in Razorpay

CREATE INDEX IF NOT EXISTS idx_rzp_cache_order_id    ON razorpay_settlement_cache(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rzp_cache_payment_at  ON razorpay_settlement_cache(payment_created_at);
