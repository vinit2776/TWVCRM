-- AMC requests can now carry one line per asset (each line becomes its own
-- service PO). The asset a line covers lives on the line itself.
--
-- purchase_requests.linked_asset_id stays as it is: it is still set when a
-- request has a single AMC line, so existing readers and old requests keep
-- working. Nothing is backfilled — a line without an asset falls back to the
-- request-level asset in the app.

ALTER TABLE purchase_request_items
  ADD COLUMN IF NOT EXISTS linked_asset_id UUID REFERENCES facility_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_request_items_linked_asset
  ON purchase_request_items(linked_asset_id) WHERE linked_asset_id IS NOT NULL;

COMMENT ON COLUMN purchase_request_items.linked_asset_id IS
  'AMC requests only: the asset this line covers. One line per asset.';
