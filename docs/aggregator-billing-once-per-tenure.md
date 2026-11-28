# Postpaid aggregator billing: once per term

## Problem
`cases.rate` is a term fee, not a monthly amount, but the monthly aggregator
invoice run (`src/lib/aggregator-invoicing.ts`, cron on the 1st plus the manual
route) billed it every month, so a 12 month case was billed about 12 times.

## Setting
`app_settings.vo_agg_billing_mode`

- `legacy` (default, also used for a missing or unknown value): today's monthly behaviour, unchanged.
- `once_per_tenure`: each case is billed once, in the invoice period containing its term start (`start_date`, falling back to the activation date), at the full term fee, with no day pro-rating. A renewed term is a new case with a new `start_date`, so it is billed once in its own period. Cases are recorded in `aggregator_case_terms_billed (case_id, term_start)`, which is unique, so a term can never be billed twice.

Term fee: for tenure of 12 months or less, `rate`; for longer tenure (24, 36, 48), `rate x tenure_months / 12` (`rate` is then the annual rate).

The one-invoice-per-aggregator-per-period guard and the GST split are unchanged.

## Before flipping
1. Apply migration `00686_aggregator_billed_terms.sql` (seeds the setting as `legacy`). If the code is deployed first, `once_per_tenure` falls back to legacy and logs once.
2. Compare: `GET /api/aggregator-invoices/billing-preview?aggregator_id=<uuid>&month=<m>&year=<y>` (admin or manager, read-only). Each case returns `legacy`, `oncePerTenure` and `difference`.
3. Note: a case whose term started in an earlier, already-invoiced period is not billed again in `once_per_tenure`. A term start period that was never invoiced will not be picked up later; bill it with a manual invoice for that period if needed.

## Flip
```sql
UPDATE app_settings SET value = 'once_per_tenure' WHERE key = 'vo_agg_billing_mode';
```
The setting is cached for a short time; allow a few minutes.

## Rollback
```sql
UPDATE app_settings SET value = 'legacy' WHERE key = 'vo_agg_billing_mode';
```
Rows already in `aggregator_case_terms_billed` stay (harmless in legacy). Full removal: see the rollback note in the migration.

## Read-only: postpaid cases billed more than once (legacy mode)
```sql
SELECT c.id AS case_id, c.case_number, a.name AS aggregator, c.tenure_months, c.rate,
       count(*) AS times_billed, sum((i.item->>'amount')::numeric) AS total_billed
FROM aggregator_invoices ai
CROSS JOIN LATERAL jsonb_array_elements(ai.items) AS i(item)
JOIN cases c ON c.id = (i.item->>'case_id')::uuid
JOIN aggregators a ON a.id = ai.aggregator_id
WHERE a.billing_method = 'postpaid'
GROUP BY c.id, c.case_number, a.name, c.tenure_months, c.rate
HAVING count(*) > 1
ORDER BY times_billed DESC;
```
