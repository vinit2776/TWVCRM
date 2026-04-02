-- Printer Department ID on contracts
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS printer_department_id VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_dept_id_active
  ON contracts(printer_department_id)
  WHERE printer_department_id IS NOT NULL AND status = 'active';

-- Billing payments table (manual + Razorpay payments against invoices)
CREATE TABLE IF NOT EXISTS billing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_statement_id UUID NOT NULL REFERENCES billing_statements(id) ON DELETE RESTRICT,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  payment_mode TEXT NOT NULL, -- neft, rtgs, upi, cheque, razorpay, cash
  payment_reference TEXT,
  razorpay_payment_id TEXT,
  proof_path TEXT,
  notes TEXT,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_statement ON billing_payments(billing_statement_id);

ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read billing_payments"
  ON billing_payments FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert billing_payments"
  ON billing_payments FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Add payment_status to billing_statements for tracking paid/unpaid
ALTER TABLE billing_statements ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid';
-- Values: 'unpaid', 'partially_paid', 'paid'
