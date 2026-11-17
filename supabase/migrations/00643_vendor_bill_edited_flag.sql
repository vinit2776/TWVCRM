-- Marks a vendor bill that was corrected after it was entered, so Accounts and
-- approvers can spot a transaction that changed under them. Set by the bill
-- correction routes; never cleared (the history stays visible). Existing rows
-- default to "never edited" — earlier edits are only in the audit trail.
ALTER TABLE vendor_bills
  ADD COLUMN IF NOT EXISTS edit_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_edited_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_edited_by    UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS last_edit_summary TEXT;

COMMENT ON COLUMN vendor_bills.edit_count IS 'Number of corrections made through edit_invoice_details / update_amount_and_resubmit.';
