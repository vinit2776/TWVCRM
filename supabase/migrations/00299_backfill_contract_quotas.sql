-- ============================================================
-- 00299: Backfill missing service quotas for 15 active contracts
--
-- These contracts were activated before quota data was entered.
-- Two separate systems are populated:
--
--   contract_facilities      — Conference room hours (read by the
--                              bookings system in real-time per booking)
--
--   contract_service_quotas  — B&W and Colour print pages (read by
--                              the print usage import system monthly)
--
-- All inserts use ON CONFLICT DO NOTHING — safe to re-run.
-- Does NOT affect past bookings or past print imports.
-- ============================================================

-- ---------------------------------------------------------------------------
-- PART 1: Conference Room — contract_facilities
-- unit must be an hour variant so the bookings quota logic picks it up
-- ---------------------------------------------------------------------------

INSERT INTO contract_facilities (contract_id, name, unit, free_quota, cost_per_unit)
SELECT c.id, 'Conference Room', 'hrs', v.free_quota, v.cost_per_unit
FROM (VALUES
  ('TWV-C-0085', 14,  800),
  ('TWV-C-0084', 14,  800),
  ('TWV-C-0082',  6, 1000),
  ('TWV-C-0081',  6, 1000),
  ('TWV-C-0080',  2,  800),
  ('TWV-C-0078',  0, 1000),
  ('TWV-C-0074',  3,  750),
  ('TWV-C-0073',  4,  800),
  ('TWV-C-0070',  0,  800),
  ('TWV-C-0066',  2,  499),
  ('TWV-C-0057', 10,  800),
  ('TWV-C-0056', 14,  800),
  ('TWV-C-0055', 50,  650),
  ('TWV-C-0040',  8,  800),
  ('TWV-C-0007',  2, 1000)
) AS v(contract_number, free_quota, cost_per_unit)
JOIN contracts c ON c.contract_number = v.contract_number
ON CONFLICT (contract_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 2: B&W Print — contract_service_quotas (service slug: print-bw)
-- monthly_quota = 0 means no free pages; billed from page 1 at overage_rate
-- ---------------------------------------------------------------------------

INSERT INTO contract_service_quotas (contract_id, service_id, monthly_quota, overage_rate, notes)
SELECT c.id, s.id, v.monthly_quota, 5, 'Backfilled from onboarding data'
FROM (VALUES
  ('TWV-C-0085', 80),
  ('TWV-C-0084', 80),
  ('TWV-C-0082',  0),
  ('TWV-C-0081',  0),
  ('TWV-C-0080', 10),
  ('TWV-C-0078', 10),
  ('TWV-C-0074', 30),
  ('TWV-C-0073', 20),
  ('TWV-C-0070', 10),
  ('TWV-C-0066', 10),
  ('TWV-C-0057', 50),
  ('TWV-C-0056', 80),
  ('TWV-C-0055',  0),
  ('TWV-C-0040', 40),
  ('TWV-C-0007', 20)
) AS v(contract_number, monthly_quota)
JOIN contracts c ON c.contract_number = v.contract_number
CROSS JOIN (SELECT id FROM service_catalog WHERE slug = 'print-bw') s
ON CONFLICT (contract_id, service_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 3: Colour Print — contract_service_quotas (service slug: print-colour)
-- All contracts: 0 free pages, charged at Rs 15/page from page 1
-- ---------------------------------------------------------------------------

INSERT INTO contract_service_quotas (contract_id, service_id, monthly_quota, overage_rate, notes)
SELECT c.id, s.id, 0, 15, 'Backfilled from onboarding data'
FROM (VALUES
  ('TWV-C-0085'),
  ('TWV-C-0084'),
  ('TWV-C-0082'),
  ('TWV-C-0081'),
  ('TWV-C-0080'),
  ('TWV-C-0078'),
  ('TWV-C-0074'),
  ('TWV-C-0073'),
  ('TWV-C-0070'),
  ('TWV-C-0066'),
  ('TWV-C-0057'),
  ('TWV-C-0056'),
  ('TWV-C-0055'),
  ('TWV-C-0040'),
  ('TWV-C-0007')
) AS v(contract_number)
JOIN contracts c ON c.contract_number = v.contract_number
CROSS JOIN (SELECT id FROM service_catalog WHERE slug = 'print-colour') s
ON CONFLICT (contract_id, service_id) DO NOTHING;
