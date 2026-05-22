-- Prevent two employees from sharing the same NFC card number.
-- Without this, a reassigned card grants access to both employees and
-- both show attendance, causing silent data corruption.
ALTER TABLE employees ADD CONSTRAINT employees_nfc_card_number_unique UNIQUE (nfc_card_number);
