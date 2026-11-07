-- GST invoice cancellation requests.
--
-- A GST invoice issued through Tally cannot be voided in the CRM alone: Accounts
-- must issue a credit note in Tally and upload it (upload-credit-note route).
-- An admin or manager starts that by *requesting* the cancellation, which stops
-- reminders and puts a task in the Tally Inbox. The invoice stays live until the
-- credit note is uploaded, at which point the existing route voids it.
--
-- Plain columns on billing_statements (no new table, so no new RLS surface);
-- the audit trail keeps the history of requests and withdrawals.

ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_requested_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason       text;

COMMENT ON COLUMN billing_statements.cancellation_requested_at IS
  'Set when an admin/manager asks for a Tally-issued GST invoice to be cancelled. Cleared on withdrawal. Reminders skip rows where this is set; the Tally Inbox lists them until a credit note voids the statement.';

CREATE INDEX IF NOT EXISTS idx_billing_statements_cancellation_requested
  ON billing_statements (cancellation_requested_at)
  WHERE cancellation_requested_at IS NOT NULL AND voided_at IS NULL;
