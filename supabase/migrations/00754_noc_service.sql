-- NOC service, part 1 (order and draft): a paid No Objection Certificate that lets a customer's company use a
-- TWV centre as its registered office (ROC) or place of business (GST). Plan: docs/plans/noc-service.md.
--
-- noc_requests.status:  draft -> sent -> accepted -> paid -> issued     (void before paid)
-- Part 1 only creates and voids draft orders. Sending, payment and issue arrive in later parts, so nothing
-- here can contact a customer or take money. The whole feature is dark behind app_settings.noc_service_enabled.
--
-- noc_audit_events is the legal trail: rows are written once and never changed or deleted by anyone
-- (a trigger refuses UPDATE always, and DELETE except when the parent order itself is deleted).
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS noc_audit_events;
--   DROP TABLE IF EXISTS noc_requests;
--   DROP SEQUENCE IF EXISTS noc_number_seq;
--   ALTER TABLE locations DROP COLUMN IF EXISTS noc_address;
--   DELETE FROM app_settings WHERE key IN ('noc_service_enabled','noc_fee_roc','noc_fee_gst','noc_tax_percentage',
--     'noc_signatory_name','noc_signatory_designation');

-- The address text printed on a NOC for the centre (it can read differently from the postal address,
-- e.g. "Old No.669/GF-11, New No.306/GF-11, ..."). Falls back to the centre's address when empty.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS noc_address TEXT;

CREATE SEQUENCE IF NOT EXISTS noc_number_seq START 1;

CREATE TABLE IF NOT EXISTS noc_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  noc_number TEXT NOT NULL UNIQUE DEFAULT ('NOC-' || lpad(nextval('noc_number_seq')::text, 4, '0')),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  sequence_in_contract INT NOT NULL,
  lead_id UUID REFERENCES leads(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('roc', 'gst')),
  location_id UUID NOT NULL REFERENCES locations(id),
  company_name TEXT NOT NULL,
  cin TEXT,
  noc_address TEXT NOT NULL,                  -- address as it stood when ordered (frozen)
  fee_excl_gst NUMERIC(12,2) NOT NULL CHECK (fee_excl_gst >= 0),
  tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 18,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'paid', 'issued', 'void')),
  void_reason TEXT,
  voided_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, sequence_in_contract)
);

CREATE INDEX IF NOT EXISTS noc_requests_contract_idx ON noc_requests (contract_id, sequence_in_contract);
CREATE INDEX IF NOT EXISTS noc_requests_status_idx ON noc_requests (status) WHERE status <> 'void';

ALTER TABLE noc_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "noc_requests_select" ON noc_requests;
CREATE POLICY "noc_requests_select" ON noc_requests FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS noc_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  noc_id UUID NOT NULL REFERENCES noc_requests(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  actor_id UUID REFERENCES users(id),
  actor_label TEXT,                           -- who, in words (staff name, or the customer's typed name)
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS noc_audit_events_noc_idx ON noc_audit_events (noc_id, created_at);

ALTER TABLE noc_audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "noc_audit_events_select" ON noc_audit_events;
CREATE POLICY "noc_audit_events_select" ON noc_audit_events FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION noc_audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'noc_audit_events rows cannot be changed';
  END IF;
  -- A cascade from deleting the order runs one level deeper than a direct delete.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'noc_audit_events rows cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS noc_audit_events_no_update ON noc_audit_events;
CREATE TRIGGER noc_audit_events_no_update BEFORE UPDATE ON noc_audit_events
  FOR EACH ROW EXECUTE FUNCTION noc_audit_events_immutable();
DROP TRIGGER IF EXISTS noc_audit_events_no_delete ON noc_audit_events;
CREATE TRIGGER noc_audit_events_no_delete BEFORE DELETE ON noc_audit_events
  FOR EACH ROW EXECUTE FUNCTION noc_audit_events_immutable();

-- Settings. The feature ships dark; fees are frozen on each order when it is created.
INSERT INTO app_settings (key, value) VALUES
  ('noc_service_enabled', 'false'),
  ('noc_fee_roc', '20000'),
  ('noc_fee_gst', '20000'),
  ('noc_tax_percentage', '18'),
  ('noc_signatory_name', 'Naval Chordia'),
  ('noc_signatory_designation', 'Director')
ON CONFLICT (key) DO NOTHING;
