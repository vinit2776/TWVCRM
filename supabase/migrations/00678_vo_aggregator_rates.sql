-- Virtual Office rate cards for AGGREGATORS (PR 2 of 2): one custom card per aggregator.
--
-- A row is either 'open' (we take share_percent of the customer's price, the aggregator
-- keeps the rest and may set a minimum customer price) or 'fixed' (we always invoice
-- fixed_rate). Rows are versioned: an edit closes the current row and inserts version + 1.
-- location_id NULL means "Any location". Nothing reads this table yet; it changes no
-- live billing and does not touch aggregator_rate_cards.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS vo_aggregator_rate_new_version(uuid, text, uuid, text, numeric, numeric, numeric, text, date, uuid);
--   DROP TABLE IF EXISTS vo_aggregator_rates;

CREATE TABLE IF NOT EXISTS vo_aggregator_rates (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregator_id      uuid          NOT NULL REFERENCES aggregators(id),
  purpose            text          NOT NULL CHECK (purpose IN ('gst_new', 'gst_existing')),
  location_id        uuid          REFERENCES locations(id),
  pricing_type       text          NOT NULL CHECK (pricing_type IN ('open', 'fixed')),
  share_percent      numeric(5,2)  CHECK (share_percent IS NULL OR (share_percent >= 1 AND share_percent <= 99)),
  min_customer_price numeric(12,2) CHECK (min_customer_price IS NULL OR min_customer_price >= 0),
  fixed_rate         numeric(12,2) CHECK (fixed_rate IS NULL OR fixed_rate >= 0),
  version            int           NOT NULL,
  effective_from     date          NOT NULL DEFAULT current_date,
  effective_until    date,
  is_current         boolean       NOT NULL DEFAULT true,
  reason             text,
  created_by         uuid          REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT vo_aggregator_rates_type_fields CHECK (
    (pricing_type = 'open'  AND share_percent IS NOT NULL AND fixed_rate IS NULL)
    OR
    (pricing_type = 'fixed' AND fixed_rate IS NOT NULL AND share_percent IS NULL AND min_customer_price IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS vo_aggregator_rates_current_uniq
  ON vo_aggregator_rates (aggregator_id, purpose, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_current;

CREATE INDEX IF NOT EXISTS vo_aggregator_rates_aggregator_idx ON vo_aggregator_rates (aggregator_id);

ALTER TABLE vo_aggregator_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vo_aggregator_rates_select" ON vo_aggregator_rates;
CREATE POLICY "vo_aggregator_rates_select" ON vo_aggregator_rates
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "vo_aggregator_rates_service_all" ON vo_aggregator_rates;
CREATE POLICY "vo_aggregator_rates_service_all" ON vo_aggregator_rates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION vo_aggregator_rate_new_version(
  p_aggregator_id      uuid,
  p_purpose            text,
  p_location_id        uuid,
  p_pricing_type       text,
  p_share_percent      numeric,
  p_min_customer_price numeric,
  p_fixed_rate         numeric,
  p_reason             text,
  p_effective_from     date,
  p_created_by         uuid
) RETURNS vo_aggregator_rates
LANGUAGE plpgsql
AS $$
DECLARE
  v_current vo_aggregator_rates;
  v_new     vo_aggregator_rates;
  v_from    date := COALESCE(p_effective_from, current_date);
BEGIN
  SELECT * INTO v_current
    FROM vo_aggregator_rates
   WHERE aggregator_id = p_aggregator_id
     AND purpose = p_purpose
     AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(p_location_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_current
   FOR UPDATE;

  IF FOUND THEN
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'A reason is required when changing an existing rate' USING ERRCODE = 'P0001';
    END IF;
    UPDATE vo_aggregator_rates
       SET is_current = false, effective_until = v_from
     WHERE id = v_current.id;
  END IF;

  INSERT INTO vo_aggregator_rates (
    aggregator_id, purpose, location_id, pricing_type, share_percent, min_customer_price, fixed_rate,
    version, effective_from, is_current, reason, created_by
  ) VALUES (
    p_aggregator_id, p_purpose, p_location_id, p_pricing_type, p_share_percent, p_min_customer_price, p_fixed_rate,
    COALESCE(v_current.version, 0) + 1, v_from, true, NULLIF(btrim(COALESCE(p_reason, '')), ''), p_created_by
  ) RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION vo_aggregator_rate_new_version(uuid, text, uuid, text, numeric, numeric, numeric, text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vo_aggregator_rate_new_version(uuid, text, uuid, text, numeric, numeric, numeric, text, date, uuid) TO service_role;
