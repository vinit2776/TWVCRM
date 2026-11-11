-- Virtual Office terms library: versioned clauses that proposals, agreements and
-- renewal notices will assemble their terms from. Nothing reads these tables yet.
--
-- Seed clauses are SAMPLE wording, version 1, unapproved (approved_at NULL) until
-- legal has reviewed them.
--
-- Rollback: DROP FUNCTION IF EXISTS vo_clause_new_version(UUID, TEXT, TEXT[], TEXT[], TEXT[], INT, TEXT, UUID);
--           DROP TABLE IF EXISTS vo_clause_versions;
--           DROP TABLE IF EXISTS vo_clauses;

CREATE TABLE IF NOT EXISTS vo_clauses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vo_clause_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clause_id UUID NOT NULL REFERENCES vo_clauses(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  body TEXT NOT NULL,
  documents TEXT[] NOT NULL CHECK (documents <@ ARRAY['proposal','agreement','renewal']::TEXT[]),
  purposes TEXT[] NOT NULL CHECK (purposes <@ ARRAY['gst_new','gst_existing']::TEXT[]),
  company_types TEXT[] NOT NULL CHECK (
    company_types <@ ARRAY['individual','proprietorship','partnership','llp','pvt_ltd','public_ltd','trust','society','huf','other']::TEXT[]
  ),
  min_term_months INT CHECK (min_term_months IS NULL OR min_term_months >= 1),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clause_id, version)
);

-- At most one current version per clause.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vo_clause_versions_current
  ON vo_clause_versions (clause_id) WHERE is_current;

ALTER TABLE vo_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE vo_clause_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vo_clauses_select" ON vo_clauses;
CREATE POLICY "vo_clauses_select" ON vo_clauses FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "vo_clauses_service" ON vo_clauses;
CREATE POLICY "vo_clauses_service" ON vo_clauses FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "vo_clause_versions_select" ON vo_clause_versions;
CREATE POLICY "vo_clause_versions_select" ON vo_clause_versions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "vo_clause_versions_service" ON vo_clause_versions;
CREATE POLICY "vo_clause_versions_service" ON vo_clause_versions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Close the current version of a clause and insert version + 1, atomically.
-- A reason is required whenever a current version exists. Returns the new version id.
CREATE OR REPLACE FUNCTION vo_clause_new_version(
  p_clause_id UUID,
  p_body TEXT,
  p_documents TEXT[],
  p_purposes TEXT[],
  p_company_types TEXT[],
  p_min_term_months INT,
  p_reason TEXT,
  p_created_by UUID
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_current vo_clause_versions%ROWTYPE;
  v_new_id UUID;
BEGIN
  PERFORM 1 FROM vo_clauses WHERE id = p_clause_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clause not found';
  END IF;

  SELECT * INTO v_current FROM vo_clause_versions
    WHERE clause_id = p_clause_id AND is_current FOR UPDATE;

  IF FOUND AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'reason is required for a new version';
  END IF;

  IF FOUND THEN
    UPDATE vo_clause_versions SET is_current = FALSE WHERE id = v_current.id;
  END IF;

  INSERT INTO vo_clause_versions (
    clause_id, version, body, documents, purposes, company_types,
    min_term_months, is_current, reason, created_by
  ) VALUES (
    p_clause_id,
    COALESCE((SELECT MAX(version) FROM vo_clause_versions WHERE clause_id = p_clause_id), 0) + 1,
    p_body, p_documents, p_purposes, p_company_types,
    p_min_term_months, TRUE, NULLIF(btrim(p_reason), ''), p_created_by
  ) RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION vo_clause_new_version(UUID, TEXT, TEXT[], TEXT[], TEXT[], INT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION vo_clause_new_version(UUID, TEXT, TEXT[], TEXT[], TEXT[], INT, TEXT, UUID) TO service_role;

-- Seed: SAMPLE wording, version 1, unapproved. Needs legal review.
INSERT INTO vo_clauses (code, title) VALUES
  ('T01', 'Quote validity'),
  ('T02', 'Permitted use'),
  ('T03', 'Payment'),
  ('T04', 'Execution'),
  ('T05', 'Signer authority, company'),
  ('T06', 'Signer authority, LLP'),
  ('T07', 'Head-office certificate'),
  ('T08', 'Non-renewal'),
  ('T09', 'Renewal offer'),
  ('T10', 'Renewal fee'),
  ('T11', 'KYC on file'),
  ('T12', 'Multi-year term')
ON CONFLICT (code) DO NOTHING;

INSERT INTO vo_clause_versions (clause_id, version, body, documents, purposes, company_types, min_term_months)
SELECT c.id, 1, s.body, s.documents, s.purposes,
  COALESCE(s.company_types, ARRAY['individual','proprietorship','partnership','llp','pvt_ltd','public_ltd','trust','society','huf','other']),
  s.min_term
FROM (VALUES
  ('T01', 'This quote is valid for 7 days from the date above.',
    ARRAY['proposal'], ARRAY['gst_new','gst_existing'], NULL::INT, NULL::TEXT[]),
  ('T02', 'The address may be used only for the purpose stated above.',
    ARRAY['proposal','agreement','renewal'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T03', 'The fee is payable in full in advance for the term of {term} months, including any multi-year term. No deposit is taken.',
    ARRAY['proposal','agreement'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T04', 'The agreement is executed and shared after full payment and KYC approval.',
    ARRAY['proposal'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T05', 'A board resolution naming the signer is required. If the signer is not a director, their Aadhaar and PAN are also required.',
    ARRAY['proposal','agreement'], ARRAY['gst_new'], NULL, ARRAY['pvt_ltd','public_ltd']),
  ('T06', 'A partners resolution naming the signer is required. If the signer is not a designated partner, their Aadhaar and PAN are also required.',
    ARRAY['proposal','agreement'], ARRAY['gst_new'], NULL, ARRAY['llp']),
  ('T07', 'The head-office GST certificate is required. The address is used as an additional place of business only.',
    ARRAY['proposal','agreement'], ARRAY['gst_existing'], NULL, NULL),
  ('T08', 'On non-renewal, the customer must remove our address from all registrations and confirm in writing.',
    ARRAY['proposal','agreement','renewal'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T09', 'Renewal is offered before expiry and is billed to the party billed for this agreement.',
    ARRAY['proposal','agreement'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T10', 'The renewal fee is {fee_rule}, plus GST, for the term of {term} months.',
    ARRAY['renewal'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T11', 'KYC documents already on file are reused unless details have changed.',
    ARRAY['renewal'], ARRAY['gst_new','gst_existing'], NULL, NULL),
  ('T12', 'For a term of 24 months or more, the fee for the whole term is payable in advance. The fee is not revised during the term.',
    ARRAY['proposal','agreement'], ARRAY['gst_new','gst_existing'], 24, NULL)
) AS s(code, body, documents, purposes, min_term, company_types)
JOIN vo_clauses c ON c.code = s.code
ON CONFLICT (clause_id, version) DO NOTHING;
