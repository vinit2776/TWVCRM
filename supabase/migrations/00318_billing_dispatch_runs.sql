-- Migration 00318: billing_dispatch_runs + billing_dispatch_jobs
--
-- Implements the transactional outbox pattern for background billing dispatch.
-- A "run" is one "Run & Send" invocation. A "job" is one contract within a run.
-- The pump cron (/api/cron/billing-dispatch-pump) processes BATCH_SIZE=5 jobs
-- per tick using claim_dispatch_batch() RPC for safe FOR UPDATE SKIP LOCKED.
--
-- Modelled after tally_sync_jobs (migration 00235) — same proven pattern.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. billing_dispatch_runs — one row per "Run & Send" invocation
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_dispatch_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  month           INT         NOT NULL CHECK (month BETWEEN 1 AND 12),
  year            INT         NOT NULL CHECK (year >= 2024),
  mode            TEXT        NOT NULL CHECK (mode IN ('rent', 'usage', 'both')),
  status          TEXT        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_jobs      INT         NOT NULL DEFAULT 0,
  done_jobs       INT         NOT NULL DEFAULT 0,
  failed_jobs     INT         NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup: "what ran this month?" (used by UI guard against double-runs)
CREATE INDEX IF NOT EXISTS billing_dispatch_runs_month_idx
  ON billing_dispatch_runs (year, month, mode, status, created_at DESC);

CREATE OR REPLACE FUNCTION update_billing_dispatch_runs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER billing_dispatch_runs_updated_at
  BEFORE UPDATE ON billing_dispatch_runs
  FOR EACH ROW EXECUTE FUNCTION update_billing_dispatch_runs_updated_at();

ALTER TABLE billing_dispatch_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "billing_dispatch_runs_read"
  ON billing_dispatch_runs FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "billing_dispatch_runs_insert"
  ON billing_dispatch_runs FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "billing_dispatch_runs_update"
  ON billing_dispatch_runs FOR UPDATE
  TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. billing_dispatch_jobs — one row per contract within a run
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_dispatch_jobs (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID        NOT NULL REFERENCES billing_dispatch_runs(id) ON DELETE CASCADE,
  contract_id             UUID        NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  contract_number         TEXT        NOT NULL,  -- denormalized for display without joins
  customer_name           TEXT,                  -- denormalized for display
  billing_mode            TEXT,                  -- 'proforma_first' | 'gst_direct' — snapshot at enqueue time
  billing_statement_id    UUID        REFERENCES billing_statements(id) ON DELETE SET NULL,
  status                  TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  attempt_count           INT         NOT NULL DEFAULT 0,
  max_attempts            INT         NOT NULL DEFAULT 3,
  last_error              TEXT,
  error_suggestion        TEXT,   -- human-readable fix hint shown in the UI
  dispatched_to           TEXT,   -- email address actually sent to
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast pump query: "give me next N pending jobs for this run"
CREATE INDEX IF NOT EXISTS billing_dispatch_jobs_pump_idx
  ON billing_dispatch_jobs (run_id, status, attempt_count, created_at)
  WHERE status IN ('pending', 'failed');

-- Fast lookup by run (status panel)
CREATE INDEX IF NOT EXISTS billing_dispatch_jobs_run_idx
  ON billing_dispatch_jobs (run_id, created_at);

CREATE OR REPLACE FUNCTION update_billing_dispatch_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER billing_dispatch_jobs_updated_at
  BEFORE UPDATE ON billing_dispatch_jobs
  FOR EACH ROW EXECUTE FUNCTION update_billing_dispatch_jobs_updated_at();

ALTER TABLE billing_dispatch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "billing_dispatch_jobs_read"
  ON billing_dispatch_jobs FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "billing_dispatch_jobs_insert"
  ON billing_dispatch_jobs FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "billing_dispatch_jobs_update"
  ON billing_dispatch_jobs FOR UPDATE
  TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. claim_dispatch_batch(run_id, batch_size)
--
-- Atomically claims up to batch_size pending (or retriable failed) jobs using
-- FOR UPDATE SKIP LOCKED — prevents two pump invocations from processing the
-- same job concurrently and sending duplicate invoices.
--
-- Returns the claimed job IDs. The pump marks them 'processing' immediately
-- after claiming so the SKIP LOCKED guard holds for the full processing window.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION claim_dispatch_batch(
  p_run_id    UUID,
  p_batch     INT DEFAULT 5
)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  UPDATE billing_dispatch_jobs
  SET    status     = 'processing',
         started_at = now(),
         updated_at = now()
  WHERE  id IN (
    SELECT id
    FROM   billing_dispatch_jobs
    WHERE  run_id = p_run_id
      AND  status IN ('pending', 'failed')
      AND  attempt_count < max_attempts
    ORDER  BY created_at
    LIMIT  p_batch
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. recover_stale_dispatch_jobs(stale_minutes)
--
-- Re-queues jobs stuck in 'processing' for longer than stale_minutes.
-- Called at the top of each pump tick to handle crashed/timed-out invocations.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recover_stale_dispatch_jobs(
  p_stale_minutes INT DEFAULT 6
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  recovered INT;
BEGIN
  UPDATE billing_dispatch_jobs
  SET    status     = 'pending',
         started_at = NULL,
         updated_at = now()
  WHERE  status = 'processing'
    AND  started_at < now() - (p_stale_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. increment_dispatch_run_counters(run_id, sent, failed)
--
-- Atomically bumps the run's done_jobs and failed_jobs counters.
-- Called after each batch so the status panel shows live progress.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION increment_dispatch_run_counters(
  p_run_id  UUID,
  p_sent    INT DEFAULT 0,
  p_failed  INT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE billing_dispatch_runs
  SET    done_jobs   = done_jobs   + p_sent,
         failed_jobs = failed_jobs + p_failed,
         updated_at  = now()
  WHERE  id = p_run_id;
END;
$$;
