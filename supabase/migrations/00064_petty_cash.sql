-- Enable uuid-ossp extension (idempotent)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- ==========================================
-- Migration 00064: Petty Cash Management
-- ==========================================
-- Adds:
-- 1. petty_cash_categories  — configurable expense heads
-- 2. petty_cash_books       — one per user (personal float)
-- 3. petty_cash_requests    — funding requests (inflow)
-- 4. petty_cash_entries     — spend transactions (outflow)
-- 5. petty_cash_approvals   — audit trail for both requests & spends

-- ==========================================
-- New Enums
-- ==========================================

CREATE TYPE pc_request_status AS ENUM ('pending', 'approved', 'issued', 'rejected');
CREATE TYPE pc_entry_status   AS ENUM ('pending_manager', 'pending_admin', 'approved', 'rejected');
CREATE TYPE pc_approval_level AS ENUM ('manager', 'admin');
CREATE TYPE pc_approval_type  AS ENUM ('request', 'entry');
CREATE TYPE pc_issuance_method AS ENUM ('cash', 'upi', 'bank_transfer', 'cheque');

-- ==========================================
-- 1. petty_cash_categories
-- ==========================================

CREATE TABLE IF NOT EXISTS petty_cash_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_petty_cash_categories_updated_at
  BEFORE UPDATE ON petty_cash_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE petty_cash_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_categories"
  ON petty_cash_categories FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert petty_cash_categories"
  ON petty_cash_categories FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update petty_cash_categories"
  ON petty_cash_categories FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete petty_cash_categories"
  ON petty_cash_categories FOR DELETE USING (auth.uid() IS NOT NULL);

-- Seed default categories
INSERT INTO petty_cash_categories (name) VALUES
  ('Office Supplies'),
  ('Travel & Transport'),
  ('Food & Beverages'),
  ('Utilities'),
  ('Maintenance'),
  ('Miscellaneous');

-- ==========================================
-- 2. petty_cash_books (one per user)
-- ==========================================

CREATE TABLE IF NOT EXISTS petty_cash_books (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  current_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_petty_cash_books_user ON petty_cash_books(user_id);

CREATE TRIGGER update_petty_cash_books_updated_at
  BEFORE UPDATE ON petty_cash_books
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE petty_cash_books ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_books"
  ON petty_cash_books FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert petty_cash_books"
  ON petty_cash_books FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update petty_cash_books"
  ON petty_cash_books FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 3. petty_cash_requests (funding inflow)
-- ==========================================

CREATE TABLE IF NOT EXISTS petty_cash_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number      VARCHAR(30) NOT NULL UNIQUE,
  book_id             UUID NOT NULL REFERENCES petty_cash_books(id),
  amount_requested    DECIMAL(12,2) NOT NULL CHECK (amount_requested > 0),
  purpose             TEXT NOT NULL,
  status              pc_request_status NOT NULL DEFAULT 'pending',

  -- Approval
  approved_by         UUID REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  rejection_note      TEXT,

  -- Issuance (by accounts)
  issued_by           UUID REFERENCES users(id),
  issued_at           TIMESTAMPTZ,
  issuance_method     pc_issuance_method,
  issuance_reference  VARCHAR(255),
  issuance_proof_url  TEXT,

  created_by          UUID NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pc_requests_book   ON petty_cash_requests(book_id);
CREATE INDEX idx_pc_requests_status ON petty_cash_requests(status);

CREATE TRIGGER update_petty_cash_requests_updated_at
  BEFORE UPDATE ON petty_cash_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE petty_cash_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_requests"
  ON petty_cash_requests FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert petty_cash_requests"
  ON petty_cash_requests FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update petty_cash_requests"
  ON petty_cash_requests FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 4. petty_cash_entries (spend outflow)
-- ==========================================

CREATE TABLE IF NOT EXISTS petty_cash_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number  VARCHAR(30) NOT NULL UNIQUE,
  book_id       UUID NOT NULL REFERENCES petty_cash_books(id),
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  amount        DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  category_id   UUID REFERENCES petty_cash_categories(id),
  description   TEXT NOT NULL,
  receipt_url   TEXT,
  po_id         UUID REFERENCES purchase_orders(id),
  status        pc_entry_status NOT NULL DEFAULT 'pending_manager',
  rejection_note TEXT,
  submitted_by  UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pc_entries_book     ON petty_cash_entries(book_id);
CREATE INDEX idx_pc_entries_status   ON petty_cash_entries(status);
CREATE INDEX idx_pc_entries_category ON petty_cash_entries(category_id);
CREATE INDEX idx_pc_entries_date     ON petty_cash_entries(date);

CREATE TRIGGER update_petty_cash_entries_updated_at
  BEFORE UPDATE ON petty_cash_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE petty_cash_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_entries"
  ON petty_cash_entries FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert petty_cash_entries"
  ON petty_cash_entries FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update petty_cash_entries"
  ON petty_cash_entries FOR UPDATE USING (auth.uid() IS NOT NULL);

-- ==========================================
-- 5. petty_cash_approvals (audit trail)
-- ==========================================

CREATE TABLE IF NOT EXISTS petty_cash_approvals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_type  pc_approval_type NOT NULL,
  request_id     UUID REFERENCES petty_cash_requests(id),
  entry_id       UUID REFERENCES petty_cash_entries(id),
  approver_id    UUID NOT NULL REFERENCES users(id),
  approval_level pc_approval_level NOT NULL,
  decision       VARCHAR(10) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note           TEXT,
  decided_at     TIMESTAMPTZ DEFAULT NOW(),

  -- Either request_id or entry_id must be set
  CONSTRAINT chk_approval_target CHECK (
    (request_id IS NOT NULL AND entry_id IS NULL) OR
    (request_id IS NULL AND entry_id IS NOT NULL)
  )
);

CREATE INDEX idx_pc_approvals_request ON petty_cash_approvals(request_id);
CREATE INDEX idx_pc_approvals_entry   ON petty_cash_approvals(entry_id);

ALTER TABLE petty_cash_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read petty_cash_approvals"
  ON petty_cash_approvals FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert petty_cash_approvals"
  ON petty_cash_approvals FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
