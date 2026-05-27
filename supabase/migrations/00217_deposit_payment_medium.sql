-- Add payment medium (neft, rtgs, upi, cheque, razorpay, cash) to proposals
-- for the security deposit payment snapshot shown on the linked contract.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS deposit_payment_medium TEXT;
