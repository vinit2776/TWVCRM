-- search_contracts: (1) return activated_at / terminated_at so the contracts
-- list can tell a withdrawn contract (terminated, never activated) from a
-- genuinely terminated one — without them every terminated row rendered as
-- "Withdrawn". (2) Two filter-only tokens so the two can be listed separately:
--   'withdrawn'       -> status terminated AND activated_at IS NULL
--   'terminated_only' -> status terminated AND activated_at IS NOT NULL
-- Plain 'terminated' keeps meaning every terminated contract, so other callers
-- are unaffected. Same signature as 00361, so CREATE OR REPLACE is safe.

CREATE OR REPLACE FUNCTION search_contracts(
  p_search        TEXT    DEFAULT NULL,
  p_status        TEXT    DEFAULT NULL,
  p_expiring_days INT     DEFAULT NULL,
  p_limit         INT     DEFAULT 25,
  p_offset        INT     DEFAULT 0,
  p_location_id   TEXT    DEFAULT NULL
)
RETURNS TABLE (
  data        json,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term    TEXT := LOWER(TRIM(COALESCE(p_search, '')));
  v_today   DATE := CURRENT_DATE;
  v_future  DATE := CURRENT_DATE + (COALESCE(p_expiring_days, 0) * INTERVAL '1 day');
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      c.*,
      l.id         AS lead_id_j,
      l.first_name,
      l.last_name,
      l.company,
      l.email      AS lead_email,
      l.phone      AS lead_phone,
      l.mobile     AS lead_mobile,
      loc.id       AS loc_id_j,
      loc.name     AS loc_name,
      loc.code     AS loc_code
    FROM contracts c
    LEFT JOIN leads     l   ON l.id   = c.lead_id
    LEFT JOIN locations loc ON loc.id = c.location_id
    WHERE
      -- location filter
      (p_location_id IS NULL OR c.location_id::text = p_location_id)
      -- status filter — p_status may be a single status or a comma-separated
      -- list. renewal_in_progress rows are only included while still within
      -- their own end_date, regardless of which statuses were requested.
      AND (
        p_status IS NULL
        OR (
          (
            c.status::text = ANY(string_to_array(p_status, ','))
            OR (c.status::text = 'terminated' AND c.activated_at IS NULL
                AND 'withdrawn' = ANY(string_to_array(p_status, ',')))
            OR (c.status::text = 'terminated' AND c.activated_at IS NOT NULL
                AND 'terminated_only' = ANY(string_to_array(p_status, ',')))
          )
          AND (c.status::text <> 'renewal_in_progress' OR c.end_date >= v_today)
        )
      )
      -- expiring-soon filter
      AND (p_expiring_days IS NULL OR (
            c.status::text = 'active'
        AND c.end_date >= v_today
        AND c.end_date <= v_future
      ))
      -- full-text search
      AND (
        v_term = ''
        OR LOWER(COALESCE(c.contract_number, ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(c.title,           ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.first_name,      ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.last_name,       ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.company,         ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.email,           ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.phone,           ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.mobile,          ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(loc.name,          ''))  LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(loc.code,          ''))  LIKE '%' || v_term || '%'
        -- combined first+last for "john doe" style queries
        OR LOWER(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')) LIKE '%' || v_term || '%'
      )
  ),
  counted AS (
    SELECT COUNT(*) AS cnt FROM base
  )
  SELECT
    json_build_object(
      'id',                   b.id,
      'contract_number',      b.contract_number,
      'title',                b.title,
      'status',               b.status,
      'billing_cycle',        b.billing_cycle,
      'tenure_months',        b.tenure_months,
      'start_date',           b.start_date,
      'end_date',             b.end_date,
      'next_billing_date',    b.next_billing_date,
      'total_amount',         b.total_amount,
      'subtotal',             b.subtotal,
      'tax_percentage',       b.tax_percentage,
      'tax_amount',           b.tax_amount,
      'discount_percentage',  b.discount_percentage,
      'discount_amount',      b.discount_amount,
      'seats',                b.seats,
      'lead_id',              b.lead_id,
      'location_id',          b.location_id,
      'proposal_id',          b.proposal_id,
      'parent_contract_id',   b.parent_contract_id,
      'is_renewal',           b.is_renewal,
      'renewal_sequence',     b.renewal_sequence,
      'renewal_declined',     b.renewal_declined,
      'deposit_carried_from', b.deposit_carried_from,
      'unifi_voucher_id',     b.unifi_voucher_id,
      'activated_at',         b.activated_at,
      'terminated_at',        b.terminated_at,
      'created_at',           b.created_at,
      'updated_at',           b.updated_at,
      'lead', json_build_object(
        'id',         b.lead_id_j,
        'first_name', b.first_name,
        'last_name',  b.last_name,
        'company',    b.company,
        'email',      b.lead_email,
        'phone',      b.lead_phone,
        'mobile',     b.lead_mobile
      ),
      'location', json_build_object(
        'id',   b.loc_id_j,
        'name', b.loc_name,
        'code', b.loc_code
      )
    )                        AS data,
    (SELECT cnt FROM counted) AS total_count
  FROM base b
  ORDER BY
    CASE WHEN p_expiring_days IS NOT NULL THEN b.end_date::text ELSE NULL END ASC NULLS LAST,
    b.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION search_contracts(TEXT, TEXT, INT, INT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_contracts(TEXT, TEXT, INT, INT, INT, TEXT) TO service_role;
