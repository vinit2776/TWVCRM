-- Renewal pro-rata collection
-- When a renewal starts mid-month, a pro-rata billing statement is created and
-- sent to the client before activation. These columns track that statement and
-- the payment status so the activation gate can enforce collection.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS prorata_billing_statement_id UUID
    REFERENCES billing_statements(id),
  ADD COLUMN IF NOT EXISTS prorata_payment_status TEXT
    DEFAULT 'not_applicable'
    CHECK (prorata_payment_status IN ('not_applicable', 'pending', 'paid', 'waived'));
