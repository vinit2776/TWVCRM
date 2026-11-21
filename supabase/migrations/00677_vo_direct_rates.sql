-- Virtual Office rate card for DIRECT customers (PR 1 of 2).
--
-- One row per (purpose, location) holds the current guide price, optional floor and
-- default term. Rows are versioned: an edit closes the current row and inserts
-- version + 1, so history is never overwritten. location_id NULL means "Any location".
-- Nothing else reads this table yet; it changes no live pricing.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS vo_direct_rate_new_version(text, uuid, numeric, numeric, int, text, date, uuid);
--   DROP TABLE IF EXISTS vo_direct_rates;

CREATE TABLE IF NOT EXISTS vo_direct_rates (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose             text          NOT NULL CHECK (purpose IN ('gst_new', 'gst_existing')),
  location_id         uuid          REFERENCES locations(id),
  guide_fee           numeric(12,2) NOT NULL CHECK (guide_fee >= 0),
  floor_fee           numeric(12,2) CHECK (floor_fee IS NULL OR floor_fee <= guide_fee),
  default_term_months int           NOT NULL DEFAULT 12 CHECK (default_term_months IN (11, 12, 24, 36, 48)),
  version             int           NOT NULL,
  effective_from      date          NOT NULL DEFAULT current_date,
  effective_until     date,
  is_current          boolean       NOT NULL DEFAULT true,
  reason              text,
  created_by          uuid          REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

-- At most one current row per purpose and location (Any location counts as one slot).
CREATE UNIQUE INDEX IF NOT EXISTS vo_direct_rates_current_uniq
  ON vo_direct_rates (purpose, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_current;

ALTER TABLE vo_direct_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vo_direct_rates_select" ON vo_direct_rates;
CREATE POLICY "vo_direct_rates_select" ON vo_direct_rates
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "vo_direct_rates_service_all" ON vo_direct_rates;
CREATE POLICY "vo_direct_rates_service_all" ON vo_direct_rates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Atomic new version: lock the current row, close it, insert version + 1.
CREATE OR REPLACE FUNCTION vo_direct_rate_new_version(
  p_purpose             text,
  p_location_id         uuid,
  p_guide_fee           numeric,
  p_floor_fee           numeric,
  p_default_term_months int,
  p_reason              text,
  p_effective_from      date,
  p_created_by          uuid
) RETURNS vo_direct_rates
LANGUAGE plpgsql
AS $$
DECLARE
  v_current vo_direct_rates;
  v_new     vo_direct_rates;
  v_from    date := COALESCE(p_effective_from, current_date);
BEGIN
  SELECT * INTO v_current
    FROM vo_direct_rates
   WHERE purpose = p_purpose
     AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(p_location_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_current
   FOR UPDATE;

  IF FOUND THEN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'A reason is required when changing an existing rate' USING ERRCODE = 'P0001';
    END IF;
    UPDATE vo_direct_rates
       SET is_current = false, effective_until = v_from
     WHERE id = v_current.id;
  END IF;

  INSERT INTO vo_direct_rates (
    purpose, location_id, guide_fee, floor_fee, default_term_months,
    version, effective_from, is_current, reason, created_by
  ) VALUES (
    p_purpose, p_location_id, p_guide_fee, p_floor_fee, p_default_term_months,
    COALESCE(v_current.version, 0) + 1, v_from, true, NULLIF(btrim(COALESCE(p_reason, '')), ''), p_created_by
  ) RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION vo_direct_rate_new_version(text, uuid, numeric, numeric, int, text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vo_direct_rate_new_version(text, uuid, numeric, numeric, int, text, date, uuid) TO service_role;
