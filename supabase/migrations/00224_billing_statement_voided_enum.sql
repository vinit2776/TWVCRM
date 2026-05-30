-- Fix: add 'voided' to the billing_statement_status enum.
--
-- The void flow (src/app/api/billing-statements/[id]/void/route.ts) sets
-- status = 'voided', but the enum defined in 00002_contracts_billing.sql only
-- had ('draft', 'finalized', 'exported'). Every void attempt failed with
-- "invalid input value for enum billing_statement_status: voided", so no
-- statement has ever been successfully voided.
--
-- Migration 00155 claimed the column was TEXT with no enum constraint, but it
-- never altered the type — the column is still the enum. This adds the value.
--
-- Note: ALTER TYPE ... ADD VALUE is additive and irreversible (Postgres has no
-- DROP VALUE). It is kept in its own migration with no subsequent use of the
-- new value, so it is safe under Supabase's transactional migration runner.

ALTER TYPE billing_statement_status ADD VALUE IF NOT EXISTS 'voided';
