-- Migration: Tally Sync control — locked company guard
--
-- tally_locked_company: the company name that sync is locked to.
--   Empty = not locked yet (control page shows "Lock this company").
--   When set, /api/tally/pending refuses to return jobs unless the bridge's
--   currently-open Tally company matches this value. Prevents posting invoices
--   into the wrong company's books (D10.1 — enforced server-side, controllable
--   from the CRM admin page instead of editing config on the Tally server).
--
-- tally_sync_paused_reason: optional human note shown on the control page when
--   sync is paused (e.g. "Paused for month-end close").

INSERT INTO app_settings (key, value) VALUES
  ('tally_locked_company',     ''),
  ('tally_sync_paused_reason', '')
ON CONFLICT (key) DO NOTHING;
