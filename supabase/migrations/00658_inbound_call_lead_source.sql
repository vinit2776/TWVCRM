-- 00658_inbound_call_lead_source.sql
-- Leads a sales agent creates while a customer is on the phone get a source of their own,
-- so they can be listed apart from cold calls, referrals and the public enquiry forms.

-- Cannot be used in the same transaction it is added in; nothing here uses it.
ALTER TYPE lead_source ADD VALUE IF NOT EXISTS 'inbound_call';

-- Rollback: a Postgres enum value cannot be dropped; recode any source = 'inbound_call'
-- rows to 'cold_call' and leave the value unused.
