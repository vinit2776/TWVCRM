-- When each Razorpay payment link was made and when it stops working, and which
-- link each reminder actually carried.
--
-- Dates come from Razorpay's own response (created_at / expire_by), same as
-- proforma_invoices (00578). NULL means "not recorded" — older links are filled
-- in the first time a reminder checks them, so no backfill job is needed.
--
-- Reminder history gets the link that went out, so "which link did this
-- customer get on that day, and was it live?" can be answered from the CRM.
-- pay_link_outcome is one of: live, regenerated, none, disabled, unconfirmed.
--
-- Rollback:
--   ALTER TABLE billing_statements DROP COLUMN razorpay_link_created_at, DROP COLUMN razorpay_link_expires_at;
--   ALTER TABLE proposals DROP COLUMN deposit_razorpay_link_created_at, DROP COLUMN deposit_razorpay_link_expires_at;
--   ALTER TABLE deposit_topups DROP COLUMN razorpay_link_created_at, DROP COLUMN razorpay_link_expires_at;
--   ALTER TABLE billing_reminder_sends DROP COLUMN pay_link_url, DROP COLUMN pay_link_created_at, DROP COLUMN pay_link_outcome;
--   ALTER TABLE receivable_reminder_sends DROP COLUMN pay_link_url, DROP COLUMN pay_link_created_at, DROP COLUMN pay_link_outcome;

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS razorpay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS razorpay_link_expires_at TIMESTAMPTZ;

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deposit_razorpay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_razorpay_link_expires_at TIMESTAMPTZ;

ALTER TABLE deposit_topups
  ADD COLUMN IF NOT EXISTS razorpay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS razorpay_link_expires_at TIMESTAMPTZ;

ALTER TABLE billing_reminder_sends
  ADD COLUMN IF NOT EXISTS pay_link_url TEXT,
  ADD COLUMN IF NOT EXISTS pay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pay_link_outcome TEXT;

ALTER TABLE receivable_reminder_sends
  ADD COLUMN IF NOT EXISTS pay_link_url TEXT,
  ADD COLUMN IF NOT EXISTS pay_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pay_link_outcome TEXT;
