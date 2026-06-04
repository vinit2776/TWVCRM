-- TDS-on-income capture for billing payments.
--
-- When a customer deducts TDS on a payment, the cash received is short of the
-- invoice by the TDS amount. The shortfall is NEVER inferred — the operator
-- declares it explicitly. These columns record that declaration so:
--   * the statement settles as (cash received + tds_amount) = invoice total, and
--   * the Tally receipt splits bank (net) + TDS ledger (tds) + party (gross).
--
-- NULL/0 tds_amount = a normal payment (no TDS). A short payment with no TDS
-- declared stays partially-paid (balance still owed) — also never assumed as TDS.

ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS tds_amount  NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tds_section TEXT;
