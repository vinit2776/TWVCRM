-- Mirror contract_members into contract_contacts so members created for
-- vouchers/access control don't need to be re-entered separately as contacts.
-- source_member_id is NULL for contacts added directly (Add / Import from Lead) —
-- those never flow back into Members & Access Control.
ALTER TABLE contract_contacts
  ADD COLUMN source_member_id UUID REFERENCES contract_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contract_contacts_source_member ON contract_contacts(source_member_id);

-- Backfill: mirror every existing member (active or previously removed) into
-- contract_contacts as an 'occupant' contact, preserving their is_active state.
INSERT INTO contract_contacts (
  contract_id, full_name, email, phone, contact_role, is_active,
  source_member_id, created_at, updated_at
)
SELECT
  cm.contract_id,
  cm.name,
  cm.email,
  cm.phone,
  'occupant',
  cm.is_active,
  cm.id,
  cm.created_at,
  cm.updated_at
FROM contract_members cm
WHERE NOT EXISTS (
  SELECT 1 FROM contract_contacts cc WHERE cc.source_member_id = cm.id
);
