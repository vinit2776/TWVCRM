-- 00623_find_lead_by_phone.sql
-- Matches an inbound WhatsApp number to an existing lead by DIGITS ONLY, so a saved contact
-- written "98765 43210" or "+91-98765-43210" is recognised and never duplicated. Looks at the
-- lead's phone and mobile and at its additional contacts (lead_contacts). When several leads
-- share a number it prefers the one with an active contract, then one not marked junk, then
-- the most recently updated. Also returns the matched additional contact's name, if any, so the
-- person writing in can be named.

CREATE OR REPLACE FUNCTION find_lead_by_phone(p_last10 text)
RETURNS TABLE (lead_id uuid, contact_name text)
LANGUAGE sql STABLE
AS $$
  WITH hits AS (
    SELECT l.id AS lead_id, NULL::text AS contact_name
    FROM leads l
    WHERE right(regexp_replace(coalesce(l.phone,  ''), '\D', '', 'g'), 10) = p_last10
       OR right(regexp_replace(coalesce(l.mobile, ''), '\D', '', 'g'), 10) = p_last10
    UNION ALL
    SELECT c.lead_id, c.full_name
    FROM lead_contacts c
    WHERE right(regexp_replace(coalesce(c.phone,  ''), '\D', '', 'g'), 10) = p_last10
       OR right(regexp_replace(coalesce(c.mobile, ''), '\D', '', 'g'), 10) = p_last10
  )
  SELECT h.lead_id, h.contact_name
  FROM hits h
  JOIN leads l ON l.id = h.lead_id
  WHERE length(p_last10) = 10
  ORDER BY
    EXISTS (SELECT 1 FROM contracts k WHERE k.lead_id = l.id AND k.status = 'active') DESC,
    (l.status <> 'junk') DESC,
    -- A hit on the lead's own number beats a hit on an additional contact of another lead.
    (h.contact_name IS NULL) DESC,
    l.updated_at DESC NULLS LAST
  LIMIT 1;
$$;

-- Rollback: DROP FUNCTION find_lead_by_phone(text);
