-- 00622_customer_complaints.sql
-- A complaint is a customer's WhatsApp message (from a lead with an active contract) that the
-- inbound triage recognised as a problem rather than an enquiry. It is assessed by a person,
-- who qualifies it into a Facility work order or task (linked here by issue_id), asks the
-- customer for more information, replies only, or rejects it as not a complaint.
-- Resolution is derived from the linked work order, so there is no second status to keep in step.

CREATE SEQUENCE IF NOT EXISTS customer_complaint_ref_seq;

CREATE TABLE IF NOT EXISTS customer_complaints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE
                     DEFAULT ('CMP-' || lpad(nextval('customer_complaint_ref_seq')::text, 4, '0')),
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  contract_id      uuid REFERENCES contracts(id) ON DELETE SET NULL,
  source           text NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp')),
  customer_name    text,
  customer_phone   text,
  -- Every message the customer sent about this problem: [{ at, text }]
  messages         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'needs_info', 'qualified', 'not_a_complaint', 'closed')),
  outcome          text CHECK (outcome IN ('work_order', 'task', 'reply_only')),
  -- Pre-filled for the assessor from the facility classifier and the repeat count.
  suggested_scope     text,
  suggested_priority  text,
  repeat_count     integer NOT NULL DEFAULT 0,
  issue_id         uuid REFERENCES facility_issues(id) ON DELETE SET NULL,
  assessed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  assessed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_complaints_lead_idx   ON customer_complaints (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_complaints_status_idx ON customer_complaints (status, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_complaints_issue_idx  ON customer_complaints (issue_id) WHERE issue_id IS NOT NULL;

ALTER TABLE customer_complaints ENABLE ROW LEVEL SECURITY;

-- Written only by the complaints APIs and the WhatsApp intake (service role, bypasses RLS).
DROP POLICY IF EXISTS "customer_complaints_select_authenticated" ON customer_complaints;
CREATE POLICY "customer_complaints_select_authenticated"
  ON customer_complaints FOR SELECT TO authenticated USING (true);

-- Rollback: DROP TABLE customer_complaints; DROP SEQUENCE customer_complaint_ref_seq;
