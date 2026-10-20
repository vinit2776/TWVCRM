-- Shadow margin per customer-month (Customer Value, phase 5, PR D:
-- docs/plans/customer-value-phase5-cost-simulator.md, section 5).
--
-- Margin after VARIABLE costs for each completed month, computed nightly from the
-- stored monthly figures and the cost rates in force that month. It is shown beside
-- the score and is NOT part of it: scoring is unchanged until PR E, and only once
-- we have looked at how many customers would change tier.
--
-- Derived data, like the other snapshot tables: only the nightly job writes it
-- (service role, so no write policy) and only an admin can read it.
--
-- A month's figure is only as good as its inputs, so each row keeps what was
-- costed and how, and a `confidence` (the share of the variable cost that rests on
-- measured data). A row is not written for a month with no seats or no revenue.
--
-- Rollback:
--   DROP TABLE customer_value_margin;

CREATE TABLE customer_value_margin (
  lead_id               uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- First day of the month, e.g. 2026-09-01
  month                 date        NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),

  revenue               numeric     NOT NULL,
  variable_cost         numeric     NOT NULL,
  margin_after_variable numeric     NOT NULL,
  -- Margin as a share of revenue; null when revenue is zero.
  margin_pct            numeric,
  -- Share of the variable cost resting on measured data, 0 to 1; null when nothing was costed.
  confidence            numeric     CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- { "<cost line>": { "amount": 0, "status": "live" | "part_live" | "needs_input" } } for each variable line.
  lines                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (lead_id, month)
);

CREATE INDEX idx_customer_value_margin_month ON customer_value_margin (month);

ALTER TABLE customer_value_margin ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_value_margin_admin_select" ON customer_value_margin
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin'));
