-- ==========================================
-- Migration 00019: Procurement Module
-- ==========================================
-- Adds:
-- 1. procurement_vendors     — supplier / vendor directory
-- 2. procurement_items       — item catalog (pre-seeded by department)
-- 3. purchase_requests       — PR headers with approval workflow
-- 4. purchase_request_items  — PR line items
-- 5. purchase_orders         — PO headers linked to approved PRs
-- 6. purchase_order_items    — PO line items
-- 7. vendor_bills            — vendor invoices + payment tracking

-- ==========================================
-- New Enums
-- ==========================================

CREATE TYPE procurement_department AS ENUM ('pantry', 'maintenance', 'administration');
CREATE TYPE pr_status              AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'po_created', 'cancelled');
CREATE TYPE po_status              AS ENUM ('pending', 'ordered', 'partially_received', 'received', 'cancelled');
CREATE TYPE bill_payment_status    AS ENUM ('unpaid', 'partially_paid', 'paid');
CREATE TYPE vendor_category        AS ENUM ('pantry', 'maintenance', 'administration', 'general');
CREATE TYPE item_unit              AS ENUM ('kg', 'litre', 'packet', 'box', 'piece', 'roll', 'dozen', 'bottle', 'bag', 'set', 'pair');

-- ==========================================
-- 1. procurement_vendors
-- ==========================================

CREATE TABLE IF NOT EXISTS procurement_vendors (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(255) NOT NULL,
  category      vendor_category NOT NULL DEFAULT 'general',
  contact_name  VARCHAR(255),
  contact_phone VARCHAR(50),
  contact_email VARCHAR(255),
  address       TEXT,
  gstin         VARCHAR(15),
  payment_terms VARCHAR(100),
  notes         TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_procurement_vendors_category ON procurement_vendors(category);
CREATE INDEX idx_procurement_vendors_active   ON procurement_vendors(is_active);

CREATE TRIGGER update_procurement_vendors_updated_at
  BEFORE UPDATE ON procurement_vendors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE procurement_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read procurement_vendors"
  ON procurement_vendors FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert procurement_vendors"
  ON procurement_vendors FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update procurement_vendors"
  ON procurement_vendors FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete procurement_vendors"
  ON procurement_vendors FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 2. procurement_items (item catalog)
-- ==========================================

CREATE TABLE IF NOT EXISTS procurement_items (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(255) NOT NULL,
  department     procurement_department NOT NULL,
  unit           item_unit NOT NULL,
  standard_price DECIMAL(12,2),
  description    TEXT,
  is_active      BOOLEAN DEFAULT true,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_procurement_items_dept   ON procurement_items(department);
CREATE INDEX idx_procurement_items_active ON procurement_items(is_active);

CREATE TRIGGER update_procurement_items_updated_at
  BEFORE UPDATE ON procurement_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE procurement_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read procurement_items"
  ON procurement_items FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert procurement_items"
  ON procurement_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update procurement_items"
  ON procurement_items FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete procurement_items"
  ON procurement_items FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 3. purchase_requests
-- ==========================================

CREATE TABLE IF NOT EXISTS purchase_requests (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pr_number               VARCHAR(20) UNIQUE NOT NULL,
  department              procurement_department NOT NULL,
  location_id             UUID REFERENCES locations(id),
  status                  pr_status DEFAULT 'draft',
  requested_by            UUID NOT NULL REFERENCES users(id),
  approved_by             UUID REFERENCES users(id),
  approved_at             TIMESTAMPTZ,
  rejection_reason        TEXT,
  notes                   TEXT,
  total_estimated_amount  DECIMAL(12,2) DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_purchase_requests_status      ON purchase_requests(status);
CREATE INDEX idx_purchase_requests_department  ON purchase_requests(department);
CREATE INDEX idx_purchase_requests_location    ON purchase_requests(location_id);
CREATE INDEX idx_purchase_requests_requested   ON purchase_requests(requested_by);
CREATE INDEX idx_purchase_requests_created     ON purchase_requests(created_at DESC);

CREATE TRIGGER update_purchase_requests_updated_at
  BEFORE UPDATE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read purchase_requests"
  ON purchase_requests FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert purchase_requests"
  ON purchase_requests FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update purchase_requests"
  ON purchase_requests FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete purchase_requests"
  ON purchase_requests FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 4. purchase_request_items
-- ==========================================

CREATE TABLE IF NOT EXISTS purchase_request_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pr_id            UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  item_id          UUID REFERENCES procurement_items(id),
  item_name        VARCHAR(255) NOT NULL,
  quantity         DECIMAL(10,2) NOT NULL,
  unit             item_unit NOT NULL,
  estimated_price  DECIMAL(12,2),
  total_estimated  DECIMAL(12,2),
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_purchase_request_items_pr ON purchase_request_items(pr_id);

ALTER TABLE purchase_request_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read purchase_request_items"
  ON purchase_request_items FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert purchase_request_items"
  ON purchase_request_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update purchase_request_items"
  ON purchase_request_items FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete purchase_request_items"
  ON purchase_request_items FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 5. purchase_orders
-- ==========================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_number             VARCHAR(20) UNIQUE NOT NULL,
  pr_id                 UUID REFERENCES purchase_requests(id),
  vendor_id             UUID NOT NULL REFERENCES procurement_vendors(id),
  location_id           UUID REFERENCES locations(id),
  status                po_status DEFAULT 'pending',
  ordered_by            UUID NOT NULL REFERENCES users(id),
  expected_delivery_date DATE,
  actual_delivery_date   DATE,
  notes                 TEXT,
  total_ordered_amount  DECIMAL(12,2) DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_purchase_orders_status   ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_vendor   ON purchase_orders(vendor_id);
CREATE INDEX idx_purchase_orders_location ON purchase_orders(location_id);
CREATE INDEX idx_purchase_orders_pr       ON purchase_orders(pr_id);
CREATE INDEX idx_purchase_orders_created  ON purchase_orders(created_at DESC);

CREATE TRIGGER update_purchase_orders_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read purchase_orders"
  ON purchase_orders FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert purchase_orders"
  ON purchase_orders FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update purchase_orders"
  ON purchase_orders FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete purchase_orders"
  ON purchase_orders FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 6. purchase_order_items
-- ==========================================

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id             UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  pr_item_id        UUID REFERENCES purchase_request_items(id),
  item_id           UUID REFERENCES procurement_items(id),
  item_name         VARCHAR(255) NOT NULL,
  quantity_ordered  DECIMAL(10,2) NOT NULL,
  quantity_received DECIMAL(10,2) DEFAULT 0,
  unit              item_unit NOT NULL,
  unit_price        DECIMAL(12,2),
  total_amount      DECIMAL(12,2),
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(po_id);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read purchase_order_items"
  ON purchase_order_items FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert purchase_order_items"
  ON purchase_order_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update purchase_order_items"
  ON purchase_order_items FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete purchase_order_items"
  ON purchase_order_items FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 7. vendor_bills
-- ==========================================

CREATE TABLE IF NOT EXISTS vendor_bills (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_number       VARCHAR(20) UNIQUE NOT NULL,
  po_id             UUID REFERENCES purchase_orders(id),
  vendor_id         UUID NOT NULL REFERENCES procurement_vendors(id),
  invoice_number    VARCHAR(100),
  invoice_date      DATE NOT NULL,
  due_date          DATE,
  total_amount      DECIMAL(12,2) NOT NULL,
  amount_paid       DECIMAL(12,2) DEFAULT 0,
  payment_status    bill_payment_status DEFAULT 'unpaid',
  payment_mode      TEXT,
  payment_reference VARCHAR(255),
  payment_date      DATE,
  notes             TEXT,
  created_by        UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_vendor_bills_status  ON vendor_bills(payment_status);
CREATE INDEX idx_vendor_bills_vendor  ON vendor_bills(vendor_id);
CREATE INDEX idx_vendor_bills_po      ON vendor_bills(po_id);
CREATE INDEX idx_vendor_bills_created ON vendor_bills(created_at DESC);

CREATE TRIGGER update_vendor_bills_updated_at
  BEFORE UPDATE ON vendor_bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read vendor_bills"
  ON vendor_bills FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert vendor_bills"
  ON vendor_bills FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update vendor_bills"
  ON vendor_bills FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete vendor_bills"
  ON vendor_bills FOR DELETE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- Seed: procurement_items (49 items)
-- ==========================================

INSERT INTO procurement_items (name, department, unit) VALUES
  -- Pantry (15 items)
  ('Premium Coffee Beans',          'pantry', 'kg'),
  ('Instant Coffee Powder',         'pantry', 'kg'),
  ('Tea Bags Assorted',             'pantry', 'box'),
  ('Green Tea Bags',                'pantry', 'box'),
  ('Full-Fat Milk',                 'pantry', 'litre'),
  ('Toned Milk',                    'pantry', 'litre'),
  ('Mineral Water Bottles 1L',      'pantry', 'piece'),
  ('Sugar',                         'pantry', 'kg'),
  ('Sweetener Sachets',             'pantry', 'box'),
  ('Biscuits and Snacks Assorted',  'pantry', 'packet'),
  ('Paper Napkins',                 'pantry', 'packet'),
  ('Disposable Cups',               'pantry', 'packet'),
  ('Stirrers and Spoons',           'pantry', 'packet'),
  ('Water Dispenser Cups',          'pantry', 'packet'),
  ('Instant Coffee Sachets',        'pantry', 'box'),

  -- Maintenance (20 items)
  ('Floor Cleaner Concentrated',    'maintenance', 'litre'),
  ('Toilet Cleaner',                'maintenance', 'bottle'),
  ('Glass and Surface Cleaner',     'maintenance', 'bottle'),
  ('Disinfectant Spray',            'maintenance', 'bottle'),
  ('Mop Refills',                   'maintenance', 'piece'),
  ('Broom',                         'maintenance', 'piece'),
  ('Garbage Bags Large',            'maintenance', 'roll'),
  ('Garbage Bags Small',            'maintenance', 'roll'),
  ('Tissue Paper Rolls',            'maintenance', 'roll'),
  ('Hand Wash Liquid',              'maintenance', 'bottle'),
  ('Hand Sanitizer',                'maintenance', 'bottle'),
  ('Air Freshener',                 'maintenance', 'bottle'),
  ('LED Bulb 9W',                   'maintenance', 'piece'),
  ('LED Bulb 18W',                  'maintenance', 'piece'),
  ('Extension Board',               'maintenance', 'piece'),
  ('Electrical Tape',               'maintenance', 'piece'),
  ('Cable Ties',                    'maintenance', 'packet'),
  ('Cleaning Gloves',               'maintenance', 'pair'),
  ('Microfibre Cloths',             'maintenance', 'piece'),
  ('Pest Control Spray',            'maintenance', 'bottle'),

  -- Administration (14 items)
  ('A4 Paper Ream 500 Sheets',      'administration', 'piece'),
  ('Ball Point Pens',               'administration', 'box'),
  ('Permanent Markers',             'administration', 'piece'),
  ('Sticky Notes',                  'administration', 'packet'),
  ('Stapler Pins',                  'administration', 'box'),
  ('Scissors',                      'administration', 'piece'),
  ('Scotch Tape Rolls',             'administration', 'piece'),
  ('Envelopes A4 Size',             'administration', 'packet'),
  ('Printer Ink Cartridge',         'administration', 'piece'),
  ('Whiteboard Markers',            'administration', 'piece'),
  ('Whiteboard Duster',             'administration', 'piece'),
  ('Notepads A5',                   'administration', 'piece'),
  ('Files and Folders',             'administration', 'piece'),
  ('Rubber Bands',                  'administration', 'packet');
