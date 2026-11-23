-- Contract addenda: a written change to a signed agreement (only purpose for now:
-- change of name, either the same entity renamed or a different entity taking over), drafted from a
-- template, edited, approved by a manager/admin, signed on paper by the
-- customer, then stamped and sealed by TWV. Every text revision is kept.
--
-- contract_addenda.status:
--   draft -> pending_approval -> (changes_requested -> pending_approval)
--   -> approved -> signed (customer's signed copy uploaded)
--   -> sealed (TWV stamp on it) -> applied (customer record updated)
--   withdrawn at any point before sealed.
--
-- Rollback (nothing else depends on these):
--   DROP TABLE IF EXISTS contract_addendum_revisions;
--   DROP TABLE IF EXISTS contract_addenda;

CREATE TABLE IF NOT EXISTS contract_addenda (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  addendum_number INT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('change_of_name')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'pending_approval', 'changes_requested', 'approved', 'signed', 'sealed', 'applied', 'withdrawn')),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the answers the draft was built from
  reason TEXT NOT NULL,                        -- internal; never printed
  current_text TEXT NOT NULL,                  -- the wording that prints
  revision INT NOT NULL DEFAULT 1,
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  signed_document_id UUID REFERENCES documents(id),
  sealed_document_id UUID REFERENCES documents(id),
  stamp_reference TEXT,
  applied_by UUID REFERENCES users(id),
  applied_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, addendum_number)
);

CREATE INDEX IF NOT EXISTS contract_addenda_contract_idx ON contract_addenda (contract_id, addendum_number);
CREATE INDEX IF NOT EXISTS contract_addenda_pending_idx ON contract_addenda (status) WHERE status = 'pending_approval';

ALTER TABLE contract_addenda ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contract_addenda_select" ON contract_addenda;
CREATE POLICY "contract_addenda_select" ON contract_addenda
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS contract_addendum_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addendum_id UUID NOT NULL REFERENCES contract_addenda(id) ON DELETE CASCADE,
  revision INT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('template', 'edit')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (addendum_id, revision)
);

ALTER TABLE contract_addendum_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contract_addendum_revisions_select" ON contract_addendum_revisions;
CREATE POLICY "contract_addendum_revisions_select" ON contract_addendum_revisions
  FOR SELECT TO authenticated USING (true);
