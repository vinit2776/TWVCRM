-- =============================================================
-- Rent Management Module
-- Tables: landlords, landlord_bank_accounts, property_leases,
--         lease_escalations, lease_payments, lease_assets,
--         lease_asset_handovers, lease_documents, lease_service_offerings
-- Access: admin, accounts, viewer (Management Viewer) only
-- =============================================================

-- Helper: role check for all rent management policies
CREATE OR REPLACE FUNCTION is_rent_management_user()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE auth_id = auth.uid()
    AND role IN ('admin', 'accounts', 'viewer')
  )
$$;

CREATE OR REPLACE FUNCTION is_rent_management_writer()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE auth_id = auth.uid()
    AND role IN ('admin', 'accounts')
  )
$$;

-- ---------------------------------------------------------------
-- 1. landlords
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landlords (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  contact_person      TEXT,
  email               TEXT,
  phone               TEXT,
  pan_number          TEXT,
  gstin               TEXT,
  registered_address  TEXT,
  kyc_status          TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (kyc_status IN ('pending', 'verified', 'incomplete')),
  notes               TEXT,
  created_by          UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_landlords_updated_at
  BEFORE UPDATE ON landlords
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE landlords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "landlords_select" ON landlords
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "landlords_insert" ON landlords
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "landlords_update" ON landlords
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

-- ---------------------------------------------------------------
-- 2. landlord_bank_accounts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS landlord_bank_accounts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id          UUID        NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  bank_name            TEXT        NOT NULL,
  account_number       TEXT        NOT NULL,
  ifsc_code            TEXT        NOT NULL,
  account_holder_name  TEXT,
  is_primary           BOOLEAN     NOT NULL DEFAULT false,
  is_verified          BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE landlord_bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "landlord_bank_accounts_select" ON landlord_bank_accounts
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "landlord_bank_accounts_insert" ON landlord_bank_accounts
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "landlord_bank_accounts_update" ON landlord_bank_accounts
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

-- ---------------------------------------------------------------
-- 3. property_leases
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_leases (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id              UUID        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  landlord_id              UUID        REFERENCES landlords(id),
  lease_number             TEXT,
  registered_deed_number   TEXT,
  lease_start_date         DATE        NOT NULL,
  lease_end_date           DATE        NOT NULL,
  lock_in_end_date         DATE,
  base_rent_amount         NUMERIC(12,2) NOT NULL CHECK (base_rent_amount > 0),
  security_deposit_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  rent_due_day             INTEGER     NOT NULL DEFAULT 1 CHECK (rent_due_day BETWEEN 1 AND 28),
  advance_months           INTEGER     NOT NULL DEFAULT 0,
  escalation_type          TEXT        NOT NULL DEFAULT 'none'
                                       CHECK (escalation_type IN ('none','percentage','flat','step_up')),
  escalation_value         NUMERIC(10,4),
  escalation_frequency     TEXT        NOT NULL DEFAULT 'annual'
                                       CHECK (escalation_frequency IN ('annual','bi_annual','custom')),
  next_escalation_date     DATE,
  tds_applicable           BOOLEAN     NOT NULL DEFAULT true,
  tds_section              TEXT        NOT NULL DEFAULT '194I'
                                       CHECK (tds_section IN ('194I','194IB')),
  tds_rate                 NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  status                   TEXT        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active','expired','terminated','on_hold')),
  notes                    TEXT,
  created_by               UUID        REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_property_leases_updated_at
  BEFORE UPDATE ON property_leases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE property_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "property_leases_select" ON property_leases
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "property_leases_insert" ON property_leases
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "property_leases_update" ON property_leases
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_property_leases_location ON property_leases(location_id);
CREATE INDEX IF NOT EXISTS idx_property_leases_landlord ON property_leases(landlord_id);
CREATE INDEX IF NOT EXISTS idx_property_leases_status ON property_leases(status);

-- ---------------------------------------------------------------
-- 4. lease_escalations
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_escalations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id          UUID        NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
  effective_date    DATE        NOT NULL,
  previous_amount   NUMERIC(12,2) NOT NULL,
  new_amount        NUMERIC(12,2) NOT NULL,
  escalation_type   TEXT        NOT NULL,
  escalation_value  NUMERIC(10,4),
  status            TEXT        NOT NULL DEFAULT 'scheduled'
                                CHECK (status IN ('scheduled','applied','disputed','waived')),
  applied_by        UUID        REFERENCES users(id),
  applied_at        TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lease_escalations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_escalations_select" ON lease_escalations
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_escalations_insert" ON lease_escalations
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "lease_escalations_update" ON lease_escalations
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_escalations_lease ON lease_escalations(lease_id);

-- ---------------------------------------------------------------
-- 5. lease_payments
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_payments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id          UUID        NOT NULL REFERENCES property_leases(id) ON DELETE RESTRICT,
  payment_month     TEXT        NOT NULL,   -- 'YYYY-MM'
  due_date          DATE        NOT NULL,
  paid_date         DATE,
  gross_rent_amount NUMERIC(12,2) NOT NULL,
  tds_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount_paid   NUMERIC(12,2),
  payment_mode      TEXT        CHECK (payment_mode IN ('bank_transfer','cheque','neft','rtgs','upi')),
  payment_reference TEXT,
  bank_account_id   UUID        REFERENCES landlord_bank_accounts(id),
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','paid','overdue','on_hold','disputed')),
  auto_approved     BOOLEAN     NOT NULL DEFAULT false,
  approved_by       UUID        REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  on_hold_reason    TEXT,
  attachment_url    TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lease_id, payment_month)
);

CREATE TRIGGER update_lease_payments_updated_at
  BEFORE UPDATE ON lease_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE lease_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_payments_select" ON lease_payments
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_payments_insert" ON lease_payments
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "lease_payments_update" ON lease_payments
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_payments_lease ON lease_payments(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_payments_status ON lease_payments(status);
CREATE INDEX IF NOT EXISTS idx_lease_payments_due_date ON lease_payments(due_date);

-- ---------------------------------------------------------------
-- 6. lease_assets
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_assets (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                 UUID        NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
  asset_name               TEXT        NOT NULL,
  asset_category           TEXT        CHECK (asset_category IN ('civil','electrical','furniture','equipment','it','fitting','other')),
  serial_number            TEXT,
  make_model               TEXT,
  quantity                 INTEGER     NOT NULL DEFAULT 1,
  unit_value               NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_capex                 BOOLEAN     NOT NULL DEFAULT false,
  condition_at_takeover    TEXT        CHECK (condition_at_takeover IN ('excellent','good','fair','poor')),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lease_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_assets_select" ON lease_assets
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_assets_insert" ON lease_assets
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "lease_assets_update" ON lease_assets
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_assets_lease ON lease_assets(lease_id);

-- ---------------------------------------------------------------
-- 7. lease_asset_handovers
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_asset_handovers (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id               UUID        NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
  handover_type          TEXT        NOT NULL CHECK (handover_type IN ('takeover','return','mid_term_addition')),
  handover_date          DATE        NOT NULL,
  completed_by           UUID        REFERENCES users(id),
  landlord_representative TEXT,
  witness_name           TEXT,
  status                 TEXT        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','completed','disputed')),
  notes                  TEXT,
  before_photos          TEXT[]      NOT NULL DEFAULT '{}',
  after_photos           TEXT[]      NOT NULL DEFAULT '{}',
  asset_conditions       JSONB       NOT NULL DEFAULT '[]',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_lease_asset_handovers_updated_at
  BEFORE UPDATE ON lease_asset_handovers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE lease_asset_handovers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_asset_handovers_select" ON lease_asset_handovers
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_asset_handovers_insert" ON lease_asset_handovers
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "lease_asset_handovers_update" ON lease_asset_handovers
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_handovers_lease ON lease_asset_handovers(lease_id);

-- ---------------------------------------------------------------
-- 8. lease_documents
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_documents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id       UUID        NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
  document_type  TEXT        NOT NULL
                             CHECK (document_type IN ('lease_deed','floor_plan','electrical_drawing','noc','amendment','correspondence','other')),
  document_name  TEXT        NOT NULL,
  file_url       TEXT        NOT NULL,
  file_size      INTEGER,
  mime_type      TEXT,
  version        INTEGER     NOT NULL DEFAULT 1,
  description    TEXT,
  uploaded_by    UUID        REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lease_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_documents_select" ON lease_documents
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_documents_insert" ON lease_documents
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_documents_lease ON lease_documents(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_documents_type ON lease_documents(document_type);

-- ---------------------------------------------------------------
-- 9. lease_service_offerings (RACI)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_service_offerings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id             UUID        NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,
  service_name         TEXT        NOT NULL
                                   CHECK (service_name IN ('electricity','water','cam','security','parking','wifi','generator','hvac','housekeeping','other')),
  custom_service_name  TEXT,
  landlord_provided    BOOLEAN     NOT NULL DEFAULT false,
  responsible          TEXT,
  accountable          TEXT,
  consulted            TEXT,
  informed             TEXT,
  frequency            TEXT        CHECK (frequency IN ('daily','weekly','monthly','on_demand','as_needed')),
  sla_notes            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_lease_service_offerings_updated_at
  BEFORE UPDATE ON lease_service_offerings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE lease_service_offerings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lease_service_offerings_select" ON lease_service_offerings
  FOR SELECT TO authenticated USING (is_rent_management_user());

CREATE POLICY "lease_service_offerings_insert" ON lease_service_offerings
  FOR INSERT TO authenticated WITH CHECK (is_rent_management_writer());

CREATE POLICY "lease_service_offerings_update" ON lease_service_offerings
  FOR UPDATE TO authenticated USING (is_rent_management_writer()) WITH CHECK (is_rent_management_writer());

CREATE INDEX IF NOT EXISTS idx_lease_services_lease ON lease_service_offerings(lease_id);

-- ---------------------------------------------------------------
-- app_settings seed: lease auto-approval threshold
-- ---------------------------------------------------------------
INSERT INTO app_settings (key, value)
VALUES ('lease_auto_approve_threshold', '50000')
ON CONFLICT (key) DO NOTHING;
