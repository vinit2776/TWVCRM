-- razorpay_manual_links: maps a Razorpay payment to a CRM entity manually
-- Used when a payment arrives via an ad-hoc link (not through the normal booking/billing flow)
-- and an accounts user reconciles it by linking it to the correct record.

CREATE TABLE razorpay_manual_links (
  razorpay_payment_id TEXT        PRIMARY KEY,
  entity_type         TEXT        NOT NULL CHECK (entity_type IN ('contract', 'booking', 'billing_statement')),
  entity_id           UUID        NOT NULL,
  notes               TEXT,
  linked_by           UUID        NOT NULL REFERENCES users(id),
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full history of link / relink / unlink actions
CREATE TABLE razorpay_manual_link_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  razorpay_payment_id TEXT        NOT NULL,
  action              TEXT        NOT NULL CHECK (action IN ('linked', 'relinked', 'unlinked')),
  old_entity_type     TEXT,
  old_entity_id       UUID,
  old_notes           TEXT,
  new_entity_type     TEXT,
  new_entity_id       UUID,
  new_notes           TEXT,
  performed_by        UUID        NOT NULL REFERENCES users(id),
  performed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE razorpay_manual_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_manual_link_logs ENABLE ROW LEVEL SECURITY;

-- Finance roles (admin, manager, accounts) can manage links
CREATE POLICY "finance_manage_manual_links"
  ON razorpay_manual_links FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "finance_read_link_logs"
  ON razorpay_manual_link_logs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "finance_insert_link_logs"
  ON razorpay_manual_link_logs FOR INSERT TO authenticated
  WITH CHECK (true);
