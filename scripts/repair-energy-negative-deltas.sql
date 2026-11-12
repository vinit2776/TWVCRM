-- One-off repair: negative energy_delta_wh rows in location_energy_readings,
-- caused by the manual telemetry sync seeding from a row LATER than the first
-- rows OneGrid returned (see PR #796). Not a migration; run by hand.
--
-- A meter only counts up, so every negative delta is corrupt. The correct
-- value is cumulative_wh minus the previous row's cumulative_wh (same
-- location + device), or NULL when that isn't a real 15-min delta: no
-- previous row, either cumulative missing, the gap is over 1h
-- (MAX_DELTA_GAP_MS in src/lib/energy-ledger.ts), or the diff is itself
-- negative.

-- 1) PREVIEW — read-only. Check the two known rows (2026-08-31T18:45Z and
--    2026-09-18T18:45Z, location af667754-..., device ETG2USP024_5) show
--    -1900 -> 100.
WITH ordered AS (
  SELECT location_id, device_id, ts, energy_delta_wh, cumulative_wh,
         lag(ts)            OVER w AS prev_ts,
         lag(cumulative_wh) OVER w AS prev_cumulative_wh
  FROM location_energy_readings
  WINDOW w AS (PARTITION BY location_id, device_id ORDER BY ts)
)
SELECT location_id, device_id, ts, energy_delta_wh AS current_delta,
       CASE
         WHEN cumulative_wh IS NULL OR prev_cumulative_wh IS NULL THEN NULL
         WHEN ts - prev_ts > interval '1 hour' THEN NULL
         WHEN cumulative_wh - prev_cumulative_wh < 0 THEN NULL
         ELSE cumulative_wh - prev_cumulative_wh
       END AS corrected_delta
FROM ordered
WHERE energy_delta_wh < 0
ORDER BY location_id, device_id, ts;

-- 2) REPAIR — run only after the preview looks right. Aborts (rolls back)
--    if it would touch a different number of rows than the preview showed:
--    set expected_rows below to that count.
BEGIN;

WITH ordered AS (
  SELECT location_id, device_id, ts, energy_delta_wh, cumulative_wh,
         lag(ts)            OVER w AS prev_ts,
         lag(cumulative_wh) OVER w AS prev_cumulative_wh
  FROM location_energy_readings
  WINDOW w AS (PARTITION BY location_id, device_id ORDER BY ts)
),
fix AS (
  SELECT location_id, device_id, ts,
         CASE
           WHEN cumulative_wh IS NULL OR prev_cumulative_wh IS NULL THEN NULL
           WHEN ts - prev_ts > interval '1 hour' THEN NULL
           WHEN cumulative_wh - prev_cumulative_wh < 0 THEN NULL
           ELSE cumulative_wh - prev_cumulative_wh
         END AS corrected_delta
  FROM ordered
  WHERE energy_delta_wh < 0
),
upd AS (
  UPDATE location_energy_readings r
  SET energy_delta_wh = f.corrected_delta
  FROM fix f
  WHERE r.location_id = f.location_id
    AND r.device_id   = f.device_id
    AND r.ts          = f.ts
  RETURNING 1
)
SELECT count(*) AS rows_updated FROM upd;   -- must equal the preview's row count

-- Verify, then COMMIT (or ROLLBACK if anything looks off):
SELECT count(*) AS remaining_negative FROM location_energy_readings WHERE energy_delta_wh < 0;  -- expect 0

-- COMMIT;
-- ROLLBACK;
