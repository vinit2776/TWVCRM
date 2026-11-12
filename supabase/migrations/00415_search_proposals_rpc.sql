-- RPC: search_proposals
--
-- Deep search across proposals + joined lead + location fields, mirroring
-- search_contracts (00215_search_contracts_rpc.sql). Supabase's .or() filter
-- cannot reach embedded relation columns, so any cross-table search needs a
-- server-side function.
--
-- Searched fields:
--   proposals : proposal_number, title
--   leads     : first_name, last_name, company, email, phone, mobile
--   locations : name, code
--
-- Returns every proposals column (via to_jsonb) plus embedded lead/location
-- objects, so the API route can swap the code path transparently without
-- hand-maintaining a field list here as the proposals table grows.
--
-- Parameters:
--   p_search  TEXT — search term (case-insensitive, partial match)
--   p_status  TEXT — optional status filter (NULL = all)
--   p_limit   INT  — page size
--   p_offset  INT  — row offset for pagination
--
-- Returns: SETOF json rows (one per proposal), plus a total_count column.

CREATE OR REPLACE FUNCTION search_proposals(
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 25,
  p_offset INT  DEFAULT 0
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
  v_term TEXT := LOWER(TRIM(COALESCE(p_search, '')));
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      pr.*,
      l.id        AS lead_id_j,
      l.first_name AS lead_first_name,
      l.last_name  AS lead_last_name,
      l.company    AS lead_company,
      l.email      AS lead_email,
      loc.id       AS loc_id_j,
      loc.name     AS loc_name,
      loc.code     AS loc_code
    FROM proposals pr
    LEFT JOIN leads     l   ON l.id   = pr.lead_id
    LEFT JOIN locations loc ON loc.id = pr.location_id
    WHERE
      (p_status IS NULL OR pr.status::text = p_status)
      AND (
        v_term = ''
        OR LOWER(COALESCE(pr.proposal_number, '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(pr.title,           '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.first_name,       '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.last_name,        '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.company,          '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.email,            '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.phone,            '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.mobile,           '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(loc.name,           '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(loc.code,           '')) LIKE '%' || v_term || '%'
        OR LOWER(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')) LIKE '%' || v_term || '%'
      )
  ),
  counted AS (
    SELECT COUNT(*) AS cnt FROM base
  )
  SELECT
    (to_jsonb(b) - ARRAY[
      'lead_id_j', 'lead_first_name', 'lead_last_name', 'lead_company', 'lead_email',
      'loc_id_j', 'loc_name', 'loc_code'
    ] || jsonb_build_object(
      'lead', CASE WHEN b.lead_id_j IS NULL THEN NULL ELSE json_build_object(
        'id',         b.lead_id_j,
        'first_name', b.lead_first_name,
        'last_name',  b.lead_last_name,
        'company',    b.lead_company,
        'email',      b.lead_email
      ) END,
      'location', CASE WHEN b.loc_id_j IS NULL THEN NULL ELSE json_build_object(
        'id',   b.loc_id_j,
        'name', b.loc_name,
        'code', b.loc_code
      ) END
    ))::json AS data,
    (SELECT cnt FROM counted) AS total_count
  FROM base b
  ORDER BY b.created_at DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION search_proposals(TEXT, TEXT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION search_proposals(TEXT, TEXT, INT, INT) TO service_role;
