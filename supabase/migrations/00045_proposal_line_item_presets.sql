-- Proposal line item presets
-- A reusable library of standard line items that can be one-click inserted
-- into a proposal's line items editor.

CREATE TABLE proposal_line_item_presets (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255)  NOT NULL,           -- display label e.g. "Private Office 4-Seat/Month"
  description   TEXT          NOT NULL,           -- pre-fills the line item description field
  quantity      DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit          VARCHAR(100),                     -- e.g. "months", "hrs", "seats", "days"
  unit_price    DECIMAL(12,2) NOT NULL DEFAULT 0,
  category      VARCHAR(100),                     -- optional group e.g. "Office", "Services", "Add-ons"
  sort_order    INT           NOT NULL DEFAULT 0,
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_proposal_presets_active   ON proposal_line_item_presets(is_active);
CREATE INDEX idx_proposal_presets_category ON proposal_line_item_presets(category);

-- Auto-update updated_at
CREATE TRIGGER proposal_line_item_presets_updated_at
  BEFORE UPDATE ON proposal_line_item_presets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
