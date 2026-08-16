-- Generalise billing_queries into a CRM-wide clarification loop.
--
-- billing_queries could only ever hang off a billing statement
-- (billing_statement_id was a hard FK). Queries now need to hang off any
-- transaction — statements, Tally Inbox bookings and deposits, vendor bills,
-- contracts, purchase orders and requests — so the table becomes polymorphic,
-- keyed by (entity_type, entity_id) and resolved through the QUERY_ENTITIES
-- registry in src/lib/queries/registry.ts.
--
-- Two other things change at the same time, because both were guesses that
-- explicit targeting lets us replace with rules:
--
--   * audience — who a query is actually addressed to. Previously every
--     message notified all five roles in BILLING_QUERY_ROLES, and the
--     "Awaiting you" tab inferred whose turn it was from the last speaker's
--     role. Now the asker says, and isAwaitingUser() reads it.
--   * kind — 'question' (just needs an answer) vs 'action_needed' (someone
--     has to change something before it can be resolved).
--
-- This is an in-place rename + backfill rather than a new table alongside:
-- billing_queries is three weeks old with low row counts, so there is no
-- dual-write window and no data migration risk. Existing rows all become
-- entity_type = 'billing_statement' with audience = 'all', which reproduces
-- their current behaviour exactly.
--
-- NOTE ON DELETES: (entity_type, entity_id) cannot carry ON DELETE CASCADE
-- the way billing_statement_id did. None of the entities in scope are hard
-- deleted — statements are voided, contracts expire, bills are rejected — so
-- threads are never orphaned in practice. Where an entity row has genuinely
-- gone, the registry's toSummary() returns null and the UI renders
-- "transaction no longer available" instead of failing. Threads are audit
-- records; keeping them is correct.

-- ── Tables ────────────────────────────────────────────────────────────────
ALTER TABLE billing_queries         RENAME TO queries;
ALTER TABLE billing_query_messages  RENAME TO query_messages;

-- Renaming a table leaves its constraints, indexes and triggers under the old
-- names. Those names are load-bearing: PostgREST embedded selects address
-- foreign keys by constraint name (users!queries_created_by_fkey), so leaving
-- them as billing_* would mean new code reading queries through old names.
--
-- Every rename below is guarded. Postgres auto-names inline CHECK constraints
-- (<table>_<column>_check) and there is no RENAME ... IF EXISTS, so a name
-- that turned out even slightly different would fail the migration. The file
-- is transactional so a failure rolls back cleanly rather than leaving a
-- half-renamed schema — but guarding means it applies first time whatever the
-- auto-generated names happen to be, instead of needing a round trip to find
-- out. Each rename becomes a no-op when its old name isn't there.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('queries',        'billing_queries_pkey',                    'queries_pkey'),
      ('queries',        'billing_queries_created_by_fkey',         'queries_created_by_fkey'),
      ('queries',        'billing_queries_resolved_by_fkey',        'queries_resolved_by_fkey'),
      ('queries',        'billing_queries_status_check',            'queries_status_check'),
      ('query_messages', 'billing_query_messages_pkey',             'query_messages_pkey'),
      ('query_messages', 'billing_query_messages_query_id_fkey',    'query_messages_query_id_fkey'),
      ('query_messages', 'billing_query_messages_created_by_fkey',  'query_messages_created_by_fkey'),
      ('query_messages', 'billing_query_messages_event_type_check', 'query_messages_event_type_check'),
      ('query_messages', 'billing_query_messages_body_required',    'query_messages_body_required')
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
       WHERE c.conname = r.old_name AND rel.relname = r.tbl
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('idx_billing_queries_statement',    'idx_queries_entity_legacy'),
      ('idx_billing_queries_status',       'idx_queries_status'),
      ('idx_billing_queries_updated',      'idx_queries_updated'),
      ('idx_billing_query_messages_query', 'idx_query_messages_query')
    ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = r.old_name AND relkind = 'i') THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_trigger tg
      JOIN pg_class rel ON rel.oid = tg.tgrelid
     WHERE tg.tgname = 'update_billing_queries_updated_at' AND rel.relname = 'queries'
  ) THEN
    ALTER TRIGGER update_billing_queries_updated_at ON queries RENAME TO update_queries_updated_at;
  END IF;
END $$;

-- ── Polymorphic key ───────────────────────────────────────────────────────
ALTER TABLE queries
  ADD COLUMN entity_type TEXT,
  ADD COLUMN entity_id   UUID;

UPDATE queries
   SET entity_type = 'billing_statement',
       entity_id   = billing_statement_id;

ALTER TABLE queries
  ALTER COLUMN entity_type SET NOT NULL,
  ALTER COLUMN entity_id   SET NOT NULL;

-- The old statement index is now meaningless (its column is going away).
DROP INDEX IF EXISTS idx_queries_entity_legacy;
ALTER TABLE queries DROP COLUMN billing_statement_id;

-- entity_type is validated against QUERY_ENTITY_TYPES in the app layer rather
-- than a CHECK constraint, so adding the next surface stays a registry entry
-- and not a migration. Same convention as handoff_state (00303) and the
-- role gating on this table's own RLS policies.

-- ── Targeting, kind, and the fields the later PRs fill in ─────────────────
-- audience/kind are wired in this PR. needed_by, template_key and
-- last_nudged_at are added here so the table's shape settles in one
-- migration, and are read by the depth + nag PRs that follow.
ALTER TABLE queries
  ADD COLUMN kind              TEXT   NOT NULL DEFAULT 'question'
      CHECK (kind IN ('question', 'action_needed')),
  ADD COLUMN audience          TEXT   NOT NULL DEFAULT 'all'
      CHECK (audience IN ('all', 'roles', 'users')),
  ADD COLUMN audience_roles    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN audience_user_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN needed_by         DATE,
  ADD COLUMN template_key      TEXT,
  ADD COLUMN last_nudged_at    TIMESTAMPTZ,
  -- cardinality(), not array_length(): array_length('{}', 1) is NULL, and a
  -- CHECK passes when its expression is NULL — so the array_length form
  -- would let audience='roles' with no roles straight through while looking
  -- like it guarded against it. cardinality('{}') is 0.
  ADD CONSTRAINT queries_audience_targets_present CHECK (
        audience = 'all'
     OR (audience = 'roles' AND cardinality(audience_roles)    >= 1)
     OR (audience = 'users' AND cardinality(audience_user_ids) >= 1)
  );

-- escalated_at (00419) is carried through the rename untouched — the
-- escalation cron still clears it whenever a thread gets a new message.

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX idx_queries_entity     ON queries (entity_type, entity_id);
CREATE INDEX idx_queries_open_due   ON queries (needed_by) WHERE status = 'open';
CREATE INDEX idx_queries_aud_users  ON queries USING GIN (audience_user_ids);
CREATE INDEX idx_queries_aud_roles  ON queries USING GIN (audience_roles);

-- ── Timeline events ───────────────────────────────────────────────────────
-- 'retargeted' joins the typed timeline so re-addressing a thread shows up
-- inline with the replies rather than silently changing who gets paged.
ALTER TABLE query_messages DROP CONSTRAINT query_messages_event_type_check;
ALTER TABLE query_messages ADD  CONSTRAINT query_messages_event_type_check
  CHECK (event_type IN ('message', 'resolved', 'reopened', 'retargeted'));

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Policies survive the rename but keep their old names; rename them so the
-- policy list reads against the table it actually guards. Behaviour is
-- unchanged: authenticated users can read/insert, role gating stays in the
-- app layer (src/lib/queries/registry.ts), same convention as 00416.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('queries',        'Authenticated users can read billing_queries',          'Authenticated users can read queries'),
      ('queries',        'Authenticated users can insert billing_queries',        'Authenticated users can insert queries'),
      ('queries',        'Authenticated users can update billing_queries',        'Authenticated users can update queries'),
      ('query_messages', 'Authenticated users can read billing_query_messages',   'Authenticated users can read query_messages'),
      ('query_messages', 'Authenticated users can insert billing_query_messages', 'Authenticated users can insert query_messages')
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = r.tbl AND policyname = r.old_name) THEN
      EXECUTE format('ALTER POLICY %I ON %I RENAME TO %I', r.old_name, r.tbl, r.new_name);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE queries IS
  'One clarification thread raised on any transaction, keyed by (entity_type, entity_id) and resolved through QUERY_ENTITIES in src/lib/queries/registry.ts. audience decides who it is addressed to; visibility is open to every role authorized on that entity.';
COMMENT ON TABLE query_messages IS
  'Every message in a queries thread, including the opening question and the resolved/reopened/retargeted status markers. Append-only.';
COMMENT ON COLUMN queries.audience IS
  'all = every role authorized on this entity type (minus read-only roles); roles = audience_roles; users = audience_user_ids. Routing only — it never hides the thread.';

NOTIFY pgrst, 'reload schema';
