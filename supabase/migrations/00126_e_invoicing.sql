-- ============================================================
-- Migration 00126: GST E-Invoicing (Phase 1)
-- ============================================================
-- Adds the data layer for India GST e-invoicing per NIC v1.1 spec.
--
-- ARCHITECTURE
-- ─────────────
-- A new dedicated `gst_invoices` table is the single source of truth
-- for tax invoices that may carry an IRN (Invoice Reference Number).
-- Today, GST invoice metadata lives as fields on bookings and
-- contract_payments — those fields stay intact (we keep writing the
-- invoice_number back to them) so existing flows keep working. From
-- the e-invoicing go-live date, every new tax invoice ALSO gets a
-- row here so we can:
--   1. Generate IRN per a single, sequenced source
--   2. Compile GSTR-1 (B2B/B2C/CDN/HSN) from one table
--   3. Reconcile e-invoices vs invoices issued
--   4. Hold per-line-item HSN data (mandatory for GSTR-1 Table 12)
--
-- Cancellation & cutover
-- ──────────────────────
-- IRN cancellation is allowed within 24 hours by NIC. After that, a
-- credit note (CRN) must be issued — modelled as a new row with
-- doc_type='CRN' linking back to the original via reference_invoice_id.
--
-- Credentials
-- ───────────
-- API user credentials (sandbox + production) are stored as
-- encrypted entries in the existing `app_settings` key-value table.
-- Auth tokens are cached server-side and refreshed before expiry.
-- ============================================================

-- ─── 1. gst_invoices ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gst_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Document identity
  invoice_number   TEXT NOT NULL,            -- e.g. "TWV/2627/0001" — unique per GSTIN per FY
  invoice_date     DATE NOT NULL,
  doc_type         TEXT NOT NULL DEFAULT 'INV'
    CONSTRAINT gst_invoices_doc_type_check
    CHECK (doc_type IN ('INV', 'CRN', 'DBN')),    -- Invoice / Credit Note / Debit Note
  financial_year   TEXT NOT NULL,            -- e.g. "2026-27" — derived from invoice_date

  -- Source linkage (polymorphic — exactly one populated)
  source_type      TEXT NOT NULL
    CONSTRAINT gst_invoices_source_type_check
    CHECK (source_type IN ('booking', 'contract_payment', 'proforma', 'manual')),
  source_id        UUID,                     -- FK to bookings.id / contract_payments.id / proforma_invoices.id

  -- For credit / debit notes, link to the original invoice
  reference_invoice_id UUID REFERENCES gst_invoices(id) ON DELETE SET NULL,
  reference_invoice_number TEXT,
  reference_invoice_date   DATE,

  -- Seller (denormalised for audit immutability)
  seller_gstin     TEXT NOT NULL,
  seller_legal_name   TEXT NOT NULL,
  seller_trade_name   TEXT,
  seller_address1     TEXT NOT NULL,
  seller_address2     TEXT,
  seller_location     TEXT NOT NULL,
  seller_pincode      TEXT NOT NULL,
  seller_state_code   TEXT NOT NULL,         -- "33" for Tamil Nadu

  -- Buyer
  buyer_classification TEXT NOT NULL
    CONSTRAINT gst_invoices_buyer_classification_check
    CHECK (buyer_classification IN ('b2b', 'b2c_small', 'b2c_large', 'export', 'sez_with_payment', 'sez_without_payment', 'deemed_export')),
  buyer_gstin       TEXT,                    -- NULL for B2C
  buyer_legal_name  TEXT NOT NULL,
  buyer_trade_name  TEXT,
  buyer_address1    TEXT,
  buyer_address2    TEXT,
  buyer_location    TEXT,
  buyer_pincode     TEXT,
  buyer_state_code  TEXT,

  -- Place of supply (drives intra/inter-state tax split)
  place_of_supply_state_code TEXT NOT NULL,
  is_intrastate     BOOLEAN NOT NULL,        -- true → CGST + SGST; false → IGST

  -- Money (header totals — must equal sum of items)
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_taxable_value NUMERIC(14, 2) NOT NULL,
  total_cgst_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_sgst_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_igst_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_cess_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_discount      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_other_charges NUMERIC(14, 2) NOT NULL DEFAULT 0,
  round_off_amount    NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_invoice_value NUMERIC(14, 2) NOT NULL,

  -- E-invoice (IRN) state machine
  e_invoice_status TEXT NOT NULL DEFAULT 'not_applicable'
    CONSTRAINT gst_invoices_e_invoice_status_check
    CHECK (e_invoice_status IN ('not_applicable', 'pending', 'generated', 'cancelled', 'failed')),
  irn                       TEXT,            -- 64-char SHA256 hash from IRP
  ack_no                    TEXT,            -- IRP acknowledgement number
  ack_date                  TIMESTAMPTZ,
  signed_invoice_jwt        TEXT,            -- digitally signed e-invoice JWT
  signed_qr_code            TEXT,            -- signed QR string (for PDF)
  irp_used                  TEXT,            -- 'nic1' | 'nic2' | 'iris' | 'cygnet' | 'cleartax' | 'einvoice6'
  e_invoice_environment     TEXT,            -- 'sandbox' | 'production'
  e_invoice_generated_at    TIMESTAMPTZ,
  e_invoice_cancelled_at    TIMESTAMPTZ,
  e_invoice_cancellation_reason_code TEXT
    CONSTRAINT gst_invoices_cancel_reason_check
    CHECK (e_invoice_cancellation_reason_code IS NULL OR e_invoice_cancellation_reason_code IN ('1', '2', '3', '4')),
  -- 1=Duplicate, 2=Data entry mistake, 3=Order Cancelled, 4=Others
  e_invoice_cancellation_remarks TEXT,
  e_invoice_attempt_count   INTEGER NOT NULL DEFAULT 0,
  e_invoice_last_error_code TEXT,
  e_invoice_last_error_message TEXT,

  -- Notes / metadata
  notes            TEXT,
  pdf_path         TEXT,                     -- storage path of generated PDF (post-IRN)
  email_sent_at    TIMESTAMPTZ,
  email_sent_to    TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT gst_invoices_invoice_number_per_gstin_fy_unique
    UNIQUE (seller_gstin, financial_year, doc_type, invoice_number),
  CONSTRAINT gst_invoices_irn_unique
    UNIQUE (irn)                              -- nullable; only set after generation
);

CREATE INDEX IF NOT EXISTS idx_gst_invoices_invoice_date  ON gst_invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_gst_invoices_buyer_gstin   ON gst_invoices(buyer_gstin) WHERE buyer_gstin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gst_invoices_e_invoice_status ON gst_invoices(e_invoice_status);
CREATE INDEX IF NOT EXISTS idx_gst_invoices_source       ON gst_invoices(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_gst_invoices_fy           ON gst_invoices(financial_year);

CREATE TRIGGER update_gst_invoices_updated_at
  BEFORE UPDATE ON gst_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── 2. gst_invoice_items ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gst_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gst_invoice_id UUID NOT NULL REFERENCES gst_invoices(id) ON DELETE CASCADE,
  serial_no       INTEGER NOT NULL,           -- 1-based, contiguous

  -- Description
  is_service          BOOLEAN NOT NULL DEFAULT TRUE,
  hsn_or_sac_code     TEXT NOT NULL,         -- e.g. "997212"
  item_description    TEXT NOT NULL,
  unit                TEXT,                   -- e.g. "MON", "NOS"
  quantity            NUMERIC(14, 3) NOT NULL DEFAULT 1,

  -- Money (line-item)
  unit_price          NUMERIC(14, 4) NOT NULL,
  gross_amount        NUMERIC(14, 2) NOT NULL,
  discount_amount     NUMERIC(14, 2) NOT NULL DEFAULT 0,
  other_charges       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  taxable_value       NUMERIC(14, 2) NOT NULL,

  -- Tax
  gst_rate            NUMERIC(5, 2) NOT NULL,  -- e.g. 18.00
  cgst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sgst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  igst_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  cess_rate           NUMERIC(5, 2) NOT NULL DEFAULT 0,
  cess_amount         NUMERIC(14, 2) NOT NULL DEFAULT 0,

  -- Total
  total_item_value    NUMERIC(14, 2) NOT NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT gst_invoice_items_serial_unique UNIQUE (gst_invoice_id, serial_no)
);

CREATE INDEX IF NOT EXISTS idx_gst_invoice_items_invoice ON gst_invoice_items(gst_invoice_id);
CREATE INDEX IF NOT EXISTS idx_gst_invoice_items_hsn     ON gst_invoice_items(hsn_or_sac_code);

-- ─── 3. e_invoice_api_log (audit trail) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS e_invoice_api_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gst_invoice_id    UUID REFERENCES gst_invoices(id) ON DELETE SET NULL,
  endpoint          TEXT NOT NULL,            -- e.g. "POST /api/Invoice"
  irp_provider      TEXT NOT NULL,            -- 'nic1' | 'iris' | etc.
  environment       TEXT NOT NULL,            -- 'sandbox' | 'production'
  request_summary   JSONB,                    -- redacted request (NEVER credentials)
  response_summary  JSONB,                    -- redacted response
  http_status       INTEGER,
  irp_status_code   TEXT,                     -- "1" success, "0" failure
  irp_error_code    TEXT,
  irp_error_message TEXT,
  latency_ms        INTEGER,
  attempted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempted_by      UUID REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT e_invoice_api_log_environment_check
    CHECK (environment IN ('sandbox', 'production'))
);

CREATE INDEX IF NOT EXISTS idx_e_invoice_api_log_invoice  ON e_invoice_api_log(gst_invoice_id);
CREATE INDEX IF NOT EXISTS idx_e_invoice_api_log_attempted_at ON e_invoice_api_log(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_e_invoice_api_log_status   ON e_invoice_api_log(irp_status_code);

-- ─── 4. Cross-reference fields on existing tables ────────────────────────────
-- Optional pointer back to the canonical gst_invoices row (so a booking
-- detail page can show IRN/QR without duplicating fields). Existing
-- gst_invoice_number / gst_invoice_path columns are kept for display.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS gst_invoice_id UUID REFERENCES gst_invoices(id) ON DELETE SET NULL;

ALTER TABLE contract_payments
  ADD COLUMN IF NOT EXISTS gst_invoice_id UUID REFERENCES gst_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_gst_invoice_id
  ON bookings(gst_invoice_id) WHERE gst_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contract_payments_gst_invoice_id
  ON contract_payments(gst_invoice_id) WHERE gst_invoice_id IS NOT NULL;

-- ─── 5. App settings — seed e-invoice keys ───────────────────────────────────
-- Stored in the existing `app_settings` key-value table.
-- All sensitive values are stored encrypted (is_encrypted=true) by the
-- application layer before insert; the DB only sees ciphertext.

INSERT INTO app_settings (key, value, is_encrypted) VALUES
  ('einvoice_enabled',                  'false', false),
  ('einvoice_environment',              'sandbox', false),  -- 'sandbox' | 'production'
  ('einvoice_irp_provider',             'einvoice6', false),  -- 'einvoice6' (IRIS) | 'nic1'
  ('einvoice_seller_gstin',             '', false),
  ('einvoice_seller_legal_name',        '', false),
  ('einvoice_seller_trade_name',        '', false),
  ('einvoice_seller_address1',          '', false),
  ('einvoice_seller_address2',          '', false),
  ('einvoice_seller_location',          '', false),
  ('einvoice_seller_pincode',           '', false),
  ('einvoice_seller_state_code',        '33', false),         -- Tamil Nadu
  ('einvoice_default_sac_code',         '997212', false),
  ('einvoice_default_gst_rate',         '18', false),
  -- Sandbox credentials (encrypted)
  ('einvoice_sandbox_username',         '', true),
  ('einvoice_sandbox_password',         '', true),
  ('einvoice_sandbox_client_id',        '', true),
  ('einvoice_sandbox_client_secret',    '', true),
  -- Production credentials (encrypted)
  ('einvoice_production_username',      '', true),
  ('einvoice_production_password',      '', true),
  ('einvoice_production_client_id',     '', true),
  ('einvoice_production_client_secret', '', true),
  -- Cached auth state (rotated automatically; encrypted)
  ('einvoice_cached_auth_token',        '', true),
  ('einvoice_cached_sek',               '', true),
  ('einvoice_cached_token_expires_at',  '', false),
  ('einvoice_last_successful_auth_at',  '', false),
  -- Go-live cutover date — invoices BEFORE this date skip IRN even if eligible
  ('einvoice_go_live_date',             '2026-05-15', false),
  -- Daily batch cron run config
  ('einvoice_daily_batch_enabled',      'true', false),
  ('einvoice_daily_batch_hour_ist',     '23', false)
ON CONFLICT (key) DO NOTHING;

-- ─── 6. Row Level Security ───────────────────────────────────────────────────

ALTER TABLE gst_invoices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_invoice_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE e_invoice_api_log  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read gst_invoices"   ON gst_invoices;
DROP POLICY IF EXISTS "Authenticated users can insert gst_invoices" ON gst_invoices;
DROP POLICY IF EXISTS "Authenticated users can update gst_invoices" ON gst_invoices;

CREATE POLICY "Authenticated users can read gst_invoices"
  ON gst_invoices FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert gst_invoices"
  ON gst_invoices FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update gst_invoices"
  ON gst_invoices FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can read gst_invoice_items"   ON gst_invoice_items;
DROP POLICY IF EXISTS "Authenticated users can insert gst_invoice_items" ON gst_invoice_items;
DROP POLICY IF EXISTS "Authenticated users can update gst_invoice_items" ON gst_invoice_items;

CREATE POLICY "Authenticated users can read gst_invoice_items"
  ON gst_invoice_items FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert gst_invoice_items"
  ON gst_invoice_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update gst_invoice_items"
  ON gst_invoice_items FOR UPDATE USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can read e_invoice_api_log"   ON e_invoice_api_log;
DROP POLICY IF EXISTS "Authenticated users can insert e_invoice_api_log" ON e_invoice_api_log;

-- API log is read-only for everyone except service role; insert via app
CREATE POLICY "Authenticated users can read e_invoice_api_log"
  ON e_invoice_api_log FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert e_invoice_api_log"
  ON e_invoice_api_log FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE         ON public.gst_invoices       TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.gst_invoice_items  TO authenticated;
GRANT SELECT, INSERT                 ON public.e_invoice_api_log  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gst_invoices       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gst_invoice_items  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.e_invoice_api_log  TO service_role;

-- ─── 7. Helper: derive financial year from a date ────────────────────────────
-- India's FY runs Apr → Mar. April-Dec → "YYYY-YY+1"; Jan-Mar → "YYYY-1-YY"
CREATE OR REPLACE FUNCTION compute_indian_fy(p_date DATE)
RETURNS TEXT AS $$
DECLARE
  yr  INTEGER;
  mn  INTEGER;
BEGIN
  yr := EXTRACT(YEAR FROM p_date);
  mn := EXTRACT(MONTH FROM p_date);
  IF mn >= 4 THEN
    RETURN yr::TEXT || '-' || RIGHT(((yr + 1)::TEXT), 2);
  ELSE
    RETURN ((yr - 1)::TEXT) || '-' || RIGHT(yr::TEXT, 2);
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
