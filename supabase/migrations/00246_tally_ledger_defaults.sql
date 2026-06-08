-- Seed / correct all Tally ledger settings to match the live Tally chart of accounts.
-- Confirmed from:
--   sdipl reg.xml   — real SDIPL-REG sales invoice export
--   Master1.xml     — full ledger transaction report (all ledger names)
--   CREDIT NOTE NEW.xml — real credit note export
--
-- CRM location → Tally income ledger mapping:
--   Kamala Arcade              → Membership Fees-Kamala Arcade
--   Nungambakkam Arcade        → Membership Fees-Arcade Centre 3rd Floor
--   Arcade Center 2nd floor    → Membership Fees-Arcade Centre 3rd Floor
--   Whites Road                → Membership Fees-Whites Road
--   Nungambakkam LGF           → Membership Fees- Prakash Presidium
--   Godrej                     → Membership Fees- Prakash Presidium
--   HT Media                   → Membership Fees- Prakash Presidium
--   NUN 5th floor              → Membership Fees- Prakash Presidium
--   Capital Towers             → (falls back to global — no Tally ledger yet)
--   Pycrofts Garden            → (falls back to global — no Tally ledger yet)

-- ── Fix existing settings (UPDATE only rows that exist) ────────────────────────

-- Main income ledger (fallback for any location not in the per-location map)
UPDATE app_settings
SET value = 'Membership Fees-Kamala Arcade'
WHERE key = 'tally_ledger_rent_income';

-- Usage income — same ledger (usage charges booked to same income account)
UPDATE app_settings
SET value = 'Membership Fees-Kamala Arcade'
WHERE key = 'tally_ledger_usage_income';

-- CGST output — already correct, enforce it
UPDATE app_settings
SET value = 'CGST Output 9%'
WHERE key = 'tally_ledger_cgst_output';

-- SGST output — already correct, enforce it
UPDATE app_settings
SET value = 'SGST Output 9%'
WHERE key = 'tally_ledger_sgst_output';

-- IGST output (inter-state — coworking is intra-state but ledger exists)
UPDATE app_settings
SET value = 'IGST 18% Output'
WHERE key = 'tally_ledger_igst_output';

-- Round-off ledger
UPDATE app_settings
SET value = 'Round Off'
WHERE key = 'tally_ledger_round_off';

-- ── Insert new settings (upsert — safe to run multiple times) ─────────────────

-- Stock item used on every sales invoice ALLINVENTORYENTRIES line
INSERT INTO app_settings (key, value)
VALUES ('tally_stock_item', 'Membership Fees')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Place of supply (Tamil Nadu for all branches)
INSERT INTO app_settings (key, value)
VALUES ('tally_place_of_supply', 'Tamil Nadu')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Per-location income ledger map (JSON: CRM location name → Tally ledger name).
-- The pending route reads this; falls back to tally_ledger_rent_income if a
-- location is not listed here (e.g. Capital Towers, Pycrofts Garden).
-- NOTE: "Membership Fees- Prakash Presidium" has a space before "Prakash" —
-- that is the exact ledger name in Tally and must be preserved.
INSERT INTO app_settings (key, value)
VALUES (
  'tally_ledger_income_by_location',
  '{
    "Kamala Arcade": "Membership Fees-Kamala Arcade",
    "Nungambakkam Arcade": "Membership Fees-Arcade Centre 3rd Floor",
    "Arcade Center 2nd floor": "Membership Fees-Arcade Centre 3rd Floor",
    "Whites Road": "Membership Fees-Whites Road",
    "Nungambakkam LGF": "Membership Fees- Prakash Presidium",
    "Godrej": "Membership Fees- Prakash Presidium",
    "HT Media": "Membership Fees- Prakash Presidium",
    "NUN 5th floor": "Membership Fees- Prakash Presidium"
  }'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
