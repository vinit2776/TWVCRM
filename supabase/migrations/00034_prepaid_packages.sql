-- Migration 00034: Prepaid Packages (Bulk Hour/Day Passes)
-- Adds workspace_type to spaces, creates prepaid_packages / prepaid_purchases /
-- prepaid_redemptions tables, extends bookings, and adds 'prepaid' payment status.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Space category (workspace_type)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS workspace_type TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Package templates (product catalog)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepaid_packages (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  location_id     UUID         REFERENCES locations(id),
  workspace_type  TEXT,                      -- null = applicable to all space types
  credit_type     TEXT         NOT NULL CHECK (credit_type IN ('hours', 'days')),
  total_credits   DECIMAL(10,2) NOT NULL CHECK (total_credits > 0),
  price           DECIMAL(12,2) NOT NULL CHECK (price >= 0),
  validity_days   INTEGER      NOT NULL DEFAULT 30 CHECK (validity_days > 0),
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_by      UUID         REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Customer purchase instances
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepaid_purchases (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        UUID         NOT NULL REFERENCES prepaid_packages(id),
  location_id       UUID         REFERENCES locations(id),
  -- Customer identification: either a lead (individual) or a company name (corporate)
  lead_id           UUID         REFERENCES leads(id) ON DELETE SET NULL,
  company_name      VARCHAR(255),            -- any booking with same company can redeem
  credit_type       TEXT         NOT NULL,
  total_credits     DECIMAL(10,2) NOT NULL,
  credits_used      DECIMAL(10,2) NOT NULL DEFAULT 0,
  price_paid        DECIMAL(12,2) NOT NULL,
  payment_mode      VARCHAR(50)  NOT NULL,   -- cash | upi | card
  payment_reference VARCHAR(255),
  purchased_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at        DATE         NOT NULL,
  status            TEXT         NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'exhausted', 'expired')),
  notes             TEXT,
  sold_by           UUID         REFERENCES auth.users(id),
  -- Extension tracking
  extended_by       UUID         REFERENCES auth.users(id),
  extended_at       TIMESTAMPTZ,
  extension_notes   TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Redemption audit log (one row per booking that consumes credits)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prepaid_redemptions (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id       UUID         NOT NULL REFERENCES prepaid_purchases(id),
  booking_id        UUID         NOT NULL REFERENCES bookings(id),
  credits_deducted  DECIMAL(10,2) NOT NULL,
  redeemed_by       UUID         REFERENCES auth.users(id),
  redeemed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Extend bookings to record prepaid usage
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS prepaid_purchase_id  UUID REFERENCES prepaid_purchases(id),
  ADD COLUMN IF NOT EXISTS prepaid_credits_used DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS prepaid_topup_amount DECIMAL(12,2);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Add 'prepaid' to booking_payment_status enum
--    (ADD VALUE IF NOT EXISTS is idempotent in PostgreSQL 12+)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE booking_payment_status ADD VALUE IF NOT EXISTS 'prepaid';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_lead
  ON prepaid_purchases(lead_id);
CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_company
  ON prepaid_purchases(company_name);
CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_status
  ON prepaid_purchases(status);
CREATE INDEX IF NOT EXISTS idx_prepaid_purchases_expires
  ON prepaid_purchases(expires_at);
CREATE INDEX IF NOT EXISTS idx_prepaid_redemptions_booking
  ON prepaid_redemptions(booking_id);
CREATE INDEX IF NOT EXISTS idx_prepaid_redemptions_purchase
  ON prepaid_redemptions(purchase_id);
