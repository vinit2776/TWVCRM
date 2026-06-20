-- Service tokens: time-limited links for vendors to self-report AMC visits
CREATE TABLE amc_service_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  event_id uuid NOT NULL REFERENCES amc_service_events(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES facility_assets(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE amc_service_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read service tokens"
  ON amc_service_tokens FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin/manager/fms can create tokens"
  ON amc_service_tokens FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE INDEX idx_amc_service_tokens_token ON amc_service_tokens(token);
CREATE INDEX idx_amc_service_tokens_event ON amc_service_tokens(event_id);

-- Vendor self-report fields on events
ALTER TABLE amc_service_events
  ADD COLUMN vendor_notes text,
  ADD COLUMN vendor_submitted_at timestamptz,
  ADD COLUMN service_token_id uuid REFERENCES amc_service_tokens(id);

-- Attachments uploaded during service visits (by vendor or staff)
CREATE TABLE amc_event_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES amc_service_events(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES facility_assets(id),
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_size integer,
  mime_type text,
  uploaded_by_vendor boolean NOT NULL DEFAULT false,
  vendor_name text,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE amc_event_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read event attachments"
  ON amc_event_attachments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert event attachments"
  ON amc_event_attachments FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE INDEX idx_amc_event_attachments_event ON amc_event_attachments(event_id);
