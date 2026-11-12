-- Customer Value, phase 4 (electricity share): read-only coverage check.
-- Run on PRODUCTION in the Supabase SQL editor. It only reads, and returns one
-- row per center with what the electricity share could be built on today.
--
--   meters_mapped     active electricity connections with a OneGrid meter attached
--   ledger_meters     distinct meters that actually have stored readings
--   ledger_first/last span of the stored 15-minute readings
--   ledger_days       distinct IST days with at least one reading (gaps show here)
--   seats_capacity    seats on active space units (the center's own seat count)
--   seats_contracted  seats on active / renewal-in-progress contracts today
--   bills_12m         electricity bills captured in the last 12 months
--   bills_with_units  of those, how many have unit lines (needed for a tariff)
SELECT
  l.name AS center,
  COALESCE(c.meters_mapped, 0)  AS meters_mapped,
  COALESCE(r.ledger_meters, 0)  AS ledger_meters,
  r.ledger_first::date          AS ledger_first,
  r.ledger_last::date           AS ledger_last,
  COALESCE(r.ledger_days, 0)    AS ledger_days,
  COALESCE(s.seats_capacity, 0) AS seats_capacity,
  COALESCE(k.seats_contracted, 0) AS seats_contracted,
  COALESCE(b.bills_12m, 0)      AS bills_12m,
  COALESCE(b.bills_with_units, 0) AS bills_with_units
FROM locations l
LEFT JOIN (
  SELECT location_id, COUNT(*) FILTER (WHERE onegrid_device_id IS NOT NULL) AS meters_mapped
  FROM location_electricity_connections WHERE is_active GROUP BY location_id
) c ON c.location_id = l.id
LEFT JOIN (
  SELECT location_id, COUNT(DISTINCT device_id) AS ledger_meters, MIN(ts) AS ledger_first, MAX(ts) AS ledger_last,
         COUNT(DISTINCT (ts AT TIME ZONE 'Asia/Kolkata')::date) AS ledger_days
  FROM location_energy_readings GROUP BY location_id
) r ON r.location_id = l.id
LEFT JOIN (
  SELECT location_id, SUM(capacity) AS seats_capacity FROM space_units WHERE is_active GROUP BY location_id
) s ON s.location_id = l.id
LEFT JOIN (
  SELECT location_id, SUM(seats) AS seats_contracted FROM contracts
  WHERE status IN ('active', 'renewal_in_progress') GROUP BY location_id
) k ON k.location_id = l.id
LEFT JOIN (
  SELECT eb.location_id, COUNT(DISTINCT eb.id) AS bills_12m,
         COUNT(DISTINCT eb.id) FILTER (WHERE EXISTS (
           SELECT 1 FROM electricity_bill_lines x WHERE x.electricity_bill_id = eb.id AND x.units IS NOT NULL
         )) AS bills_with_units
  FROM electricity_bills eb
  WHERE eb.status <> 'revised'
    AND make_date(eb.bill_year, eb.bill_month, 1) >= (date_trunc('month', now()) - interval '12 months')::date
  GROUP BY eb.location_id
) b ON b.location_id = l.id
ORDER BY l.name;
