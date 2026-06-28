-- Migration: 00308_vo_renewal
-- Adds tables and columns to support the Stage 6 VO renewal + lapse workflow.
--
-- Rollback:
--   DROP TABLE IF EXISTS vo_discontinuation_documents;
--   DROP TABLE IF EXISTS vo_renewal_reminders;
--   ALTER TABLE billing_statements DROP COLUMN IF EXISTS case_id;
--   ALTER TABLE cases DROP COLUMN IF EXISTS renewal_billing_statement_id,
--                     DROP COLUMN IF EXISTS renewal_razorpay_link_id,
--                     DROP COLUMN IF EXISTS renewal_razorpay_link_url,
--                     DROP COLUMN IF EXISTS renewal_grace_ends_at,
--                     DROP COLUMN IF EXISTS renewal_reminder_count;

-- Renewal tracking columns on cases
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS renewal_billing_statement_id uuid,
  ADD COLUMN IF NOT EXISTS renewal_razorpay_link_id     text,
  ADD COLUMN IF NOT EXISTS renewal_razorpay_link_url    text,
  ADD COLUMN IF NOT EXISTS renewal_grace_ends_at        timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_reminder_count       int NOT NULL DEFAULT 0;

-- Link billing statements back to a VO case (nullable — existing rows stay untouched)
ALTER TABLE billing_statements
  ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES cases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS billing_statements_case_id_idx ON billing_statements(case_id);

-- Log every renewal reminder dispatched
CREATE TABLE IF NOT EXISTS vo_renewal_reminders (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              uuid        NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reminder_number      int         NOT NULL,
  billing_statement_id uuid        REFERENCES billing_statements(id),
  razorpay_link_id     text,
  razorpay_link_url    text,
  email_sent           boolean     NOT NULL DEFAULT false,
  whatsapp_sent        boolean     NOT NULL DEFAULT false,
  is_grace_notice      boolean     NOT NULL DEFAULT false,
  sent_at              timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vo_renewal_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_select_vo_renewal_reminders"
  ON vo_renewal_reminders FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_all_vo_renewal_reminders"
  ON vo_renewal_reminders FOR ALL TO service_role USING (true);

CREATE INDEX IF NOT EXISTS vo_renewal_reminders_case_id_idx ON vo_renewal_reminders(case_id);

-- Track discontinuation draft documents awaiting approval and dispatch
CREATE TABLE IF NOT EXISTS vo_discontinuation_documents (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                uuid        NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  document_type          text        NOT NULL, -- 'discontinuation_notice' | 'dos_donts' | 'authority_letter'
  authority_name         text,                -- populated for authority_letter rows
  authority_address      text,
  document_path          text,                -- storage path in crm-documents bucket
  status                 text        NOT NULL DEFAULT 'draft', -- 'draft' | 'approved' | 'dispatched'
  approved_by            uuid        REFERENCES users(id),
  approved_at            timestamptz,
  dispatched_at          timestamptz,
  postal_tracking_number text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vo_discontinuation_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_select_vo_discontinuation_documents"
  ON vo_discontinuation_documents FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_all_vo_discontinuation_documents"
  ON vo_discontinuation_documents FOR ALL TO service_role USING (true);

CREATE INDEX IF NOT EXISTS vo_discontinuation_documents_case_id_idx ON vo_discontinuation_documents(case_id);
