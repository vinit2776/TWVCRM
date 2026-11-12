-- 00626_customer_requests.sql
-- Customer requests (invoice copy, access or visitor pass, add seats, renewal or contract
-- question, booking change) share the complaints inbox, reply box and reply templates. A request
-- is handled by a task on the existing Tasks module, converted into a sales enquiry (add seats),
-- or marked done with a reply. Resolution is derived from the linked task, as for work orders.

ALTER TABLE customer_complaints
  ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'complaint' CHECK (kind IN ('complaint', 'request')),
  ADD COLUMN IF NOT EXISTS request_type  text CHECK (request_type IN
                             ('invoice_copy', 'access_pass', 'add_seats', 'renewal_contract', 'booking_change')),
  ADD COLUMN IF NOT EXISTS owner_role    text,
  ADD COLUMN IF NOT EXISTS due_at        timestamptz,
  ADD COLUMN IF NOT EXISTS task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enquiry_id    uuid REFERENCES lead_enquiries(id) ON DELETE SET NULL;

-- A request can be converted into an enquiry.
ALTER TABLE customer_complaints DROP CONSTRAINT IF EXISTS customer_complaints_outcome_check;
ALTER TABLE customer_complaints
  ADD CONSTRAINT customer_complaints_outcome_check
  CHECK (outcome IN ('work_order', 'task', 'reply_only', 'enquiry'));

CREATE INDEX IF NOT EXISTS customer_complaints_task_idx ON customer_complaints (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_complaints_kind_idx ON customer_complaints (kind, status, created_at DESC);

-- Requests number from their own sequence (REQ-0001); complaints keep CMP-. The column default
-- would burn a complaint number on every request, so the reference is set by a trigger instead.
CREATE SEQUENCE IF NOT EXISTS customer_request_ref_seq;
ALTER TABLE customer_complaints ALTER COLUMN reference DROP DEFAULT;

CREATE OR REPLACE FUNCTION customer_complaints_set_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference IS NULL THEN
    IF NEW.kind = 'request' THEN
      NEW.reference := 'REQ-' || lpad(nextval('customer_request_ref_seq')::text, 4, '0');
    ELSE
      NEW.reference := 'CMP-' || lpad(nextval('customer_complaint_ref_seq')::text, 4, '0');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_complaints_set_reference_trg ON customer_complaints;
CREATE TRIGGER customer_complaints_set_reference_trg
  BEFORE INSERT ON customer_complaints
  FOR EACH ROW EXECUTE FUNCTION customer_complaints_set_reference();

-- Rollback:
--   DROP TRIGGER customer_complaints_set_reference_trg ON customer_complaints;
--   DROP FUNCTION customer_complaints_set_reference();
--   ALTER TABLE customer_complaints ALTER COLUMN reference
--     SET DEFAULT ('CMP-' || lpad(nextval('customer_complaint_ref_seq')::text, 4, '0'));
--   (delete or convert kind = 'request' rows first)
--   ALTER TABLE customer_complaints DROP COLUMN kind, DROP COLUMN request_type, DROP COLUMN owner_role,
--     DROP COLUMN due_at, DROP COLUMN task_id, DROP COLUMN enquiry_id;
--   DROP SEQUENCE customer_request_ref_seq;
