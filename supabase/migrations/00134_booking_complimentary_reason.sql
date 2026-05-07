-- ============================================================
-- Migration 00134: Complimentary booking — reason capture
-- ============================================================
-- ₹0 bookings (deliberate comps for VIPs / influencers / staff use /
-- partnership demos) used to default to payment_status='pending',
-- which read as "Payment Pending" everywhere — confusing finance and
-- making the lifecycle banner lie about what happened.
--
-- The matching code change auto-sets payment_status='waived' on
-- creation when total ≤ 0. These columns capture WHY so finance can
-- run "how many comps did we give last month, by reason?" reports
-- and so the BookingPaymentSummary banner reads cleanly:
--   "Complimentary — Manager goodwill: regular customer, mic broke
--    during last visit"
--
-- Both columns are nullable: existing waived bookings (free quota etc.)
-- carry their own meaning via context, and we don't backfill — only
-- new comps + the post-hoc "Mark as Complimentary" UI fill these.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS complimentary_reason  TEXT,
  ADD COLUMN IF NOT EXISTS complimentary_details TEXT;

-- Index for the analytics query "comps issued in <date range> by reason"
CREATE INDEX IF NOT EXISTS idx_bookings_complimentary_reason
  ON bookings(created_at DESC, complimentary_reason)
  WHERE complimentary_reason IS NOT NULL;
