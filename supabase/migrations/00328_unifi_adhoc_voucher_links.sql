-- unifi_adhoc_voucher_links: optionally links an ad-hoc-issued UniFi voucher
-- (issued via the "Issue Ad-hoc" flow, which has no per-seat concept and so
-- doesn't fit voucher_issuances' schema) to a contract, so the
-- /api/unifi/voucher-devices join can resolve "whose device is this" for
-- ad-hoc vouchers same as it already does for contract-seat vouchers.
--
-- Populated when staff optionally pick a contract while issuing an ad-hoc
-- voucher (src/app/api/unifi/vouchers/adhoc/route.ts and the approval-gated
-- path in src/app/api/approval-requests/[id]/route.ts). Purely additive —
-- existing ad-hoc issuance flow is unaffected when no contract is picked.

CREATE TABLE IF NOT EXISTS unifi_adhoc_voucher_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  unifi_voucher_id  TEXT        NOT NULL,
  note              TEXT        NOT NULL,
  contract_id       UUID        REFERENCES contracts(id) ON DELETE SET NULL,
  issued_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unifi_adhoc_voucher_links_note ON unifi_adhoc_voucher_links(location_id, note);
CREATE INDEX IF NOT EXISTS idx_unifi_adhoc_voucher_links_contract ON unifi_adhoc_voucher_links(contract_id);

ALTER TABLE unifi_adhoc_voucher_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read unifi_adhoc_voucher_links"
  ON unifi_adhoc_voucher_links FOR SELECT USING (auth.uid() IS NOT NULL);
