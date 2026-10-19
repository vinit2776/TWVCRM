-- Customer Value snapshot tables (phase 2, docs/plans/customer-value-phase2.md, section 5).
--
-- customer_value_monthly  one row per customer per month: the figures the
--                         scoring library reads, as last computed.
-- customer_value_scores   one row per customer per as-of date: the pillar
--                         scores, tier, trend and story. Written by a later PR;
--                         created here so the schema ships once.
--
-- Both are derived data. Nothing user-facing writes them: the nightly job and
-- the admin recompute/backfill routes use the service role, which bypasses RLS,
-- so there is deliberately no INSERT/UPDATE/DELETE policy. The only policy lets
-- an admin read, matching the Value tab being admin-only (it shows cost and
-- negotiation data).
--
-- Rollback:
--   DROP TABLE customer_value_scores;
--   DROP TABLE customer_value_monthly;

CREATE TABLE customer_value_monthly (
  lead_id               uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- First day of the month, e.g. 2026-10-01
  month                 date        NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),

  revenue_ex_gst        numeric     NOT NULL DEFAULT 0,
  invoiced_count        integer     NOT NULL DEFAULT 0,
  -- Null when no invoice that fell due this month could be timed.
  avg_days_late         numeric,
  measured_count        integer     NOT NULL DEFAULT 0,
  on_time_count         integer     NOT NULL DEFAULT 0,
  overdue_amount        numeric     NOT NULL DEFAULT 0,
  max_days_overdue      integer     NOT NULL DEFAULT 0,
  reminders             integer     NOT NULL DEFAULT 0,
  concessions_counted   numeric     NOT NULL DEFAULT 0,

  -- Null where it cannot be known (no contract in force, no door data, no
  -- billing-query table). Null is "unknown", never "zero".
  seats_paid            numeric,
  seats_used_avg        numeric,
  rent_per_seat         numeric,
  tickets_linked        integer     NOT NULL DEFAULT 0,
  tickets_unlinked      integer     NOT NULL DEFAULT 0,
  tickets_sla_breached  integer     NOT NULL DEFAULT 0,
  tickets_reopened      integer     NOT NULL DEFAULT 0,
  satisfaction_avg      numeric,
  satisfaction_count    integer     NOT NULL DEFAULT 0,
  bookings              integer     NOT NULL DEFAULT 0,
  billing_queries       integer,

  -- invoices_without_due_date, door ("mapped" | "unmapped" | "none"),
  -- billing_queries_available, partial_month, ticket_link_coverage.
  data_flags            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (lead_id, month)
);

CREATE INDEX idx_customer_value_monthly_month ON customer_value_monthly (month);

CREATE TABLE customer_value_scores (
  lead_id               uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  as_of                 date        NOT NULL,

  -- Each pillar is null when it could not be scored.
  payment               numeric,
  friction              numeric,
  engagement            numeric,
  profitability         numeric,
  -- {"payment": 1, "friction": 0.8, ...}: how much of each pillar's expected
  -- inputs were available.
  confidence            jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Null unless the customer could be graded.
  overall               numeric,
  tier                  text        CHECK (tier IN ('A', 'B', 'C', 'D')),
  status                text        NOT NULL CHECK (status IN ('graded', 'not_enough_data')),
  reason                text,
  trend_vs_90d          text        CHECK (trend_vs_90d IN ('up', 'down', 'flat')),

  -- Which method scored each metric (percentile or fixed scale) and the cohort size.
  method                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The rule-written sentences with the ids of the records they rest on, and the suggested action.
  story                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Which weights and cut-offs produced this row, so a later change is traceable.
  settings_version      text,
  computed_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (lead_id, as_of)
);

CREATE INDEX idx_customer_value_scores_as_of ON customer_value_scores (as_of);

ALTER TABLE customer_value_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_value_scores  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_value_monthly_admin_select" ON customer_value_monthly
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));

CREATE POLICY "customer_value_scores_admin_select" ON customer_value_scores
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));
