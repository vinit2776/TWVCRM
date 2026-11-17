-- Keeps the advisory invoice check with the bill. Until now the "invoice differs from what you
-- entered" warning lived only on the form and vanished on save, so the approver never saw it.
-- Shape: {"checked_at": ISO, "confidence": "high|medium|low", "findings": [{"code","message"}]}.
-- Advisory only: nothing reads it to block or change a bill. NULL = no check ran.
--
-- Rollback: ALTER TABLE vendor_bills DROP COLUMN invoice_check;
ALTER TABLE vendor_bills ADD COLUMN IF NOT EXISTS invoice_check JSONB;
