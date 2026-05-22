-- Canonical NFC card number on the employee record.
-- When a card is assigned, this is written here AND propagated to all
-- cosec_access_users rows for the employee so a single card works everywhere.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS nfc_card_number text;
