-- Fix incorrect due_date on June 2026 rent proformas.
--
-- Root cause: dueDateFromPeriodEnd(prepaidLastOfMonth) used period_end + 7 days,
-- but for prepaid rent the period_end is the last day of the NEXT month (June 30),
-- producing July 7 instead of the correct 7-days-from-send-date (June 6/7).
--
-- For already-sent statements: derive due_date from actual proforma_sent_at.
-- For created-but-unsent statements: use today (the date this migration runs).

UPDATE billing_statements
SET due_date = (proforma_sent_at::date + interval '7 days')::date
WHERE statement_type = 'rent'
  AND prepaid_month = 6
  AND prepaid_year  = 2026
  AND voided_at     IS NULL
  AND proforma_sent_at IS NOT NULL;

UPDATE billing_statements
SET due_date = (CURRENT_DATE + interval '7 days')::date
WHERE statement_type = 'rent'
  AND prepaid_month = 6
  AND prepaid_year  = 2026
  AND voided_at     IS NULL
  AND proforma_sent_at IS NULL;
