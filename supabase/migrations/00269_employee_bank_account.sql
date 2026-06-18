-- Bank account details for salary transfer.
-- Shown on payslip PDF as "Transfer to: XXXX [last 4 digits]".

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS bank_account_number    text,
  ADD COLUMN IF NOT EXISTS bank_ifsc              text,
  ADD COLUMN IF NOT EXISTS bank_name              text,
  ADD COLUMN IF NOT EXISTS bank_account_holder_name text;
