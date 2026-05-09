-- Manual correction: TWV-C-0036 tenure was entered as 11 months, should be 9.
-- Recalculates end_date as start_date + 9 months - 1 day (consistent with the
-- fixed calculation applied in migration 00137).

UPDATE contracts
SET
  tenure_months = 9,
  end_date = (start_date + INTERVAL '9 months' - INTERVAL '1 day')
WHERE contract_number = 'TWV-C-0036';
