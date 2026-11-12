-- Which invoice the reporter says the payment covers.
--
-- 00510 deliberately left allocation to accounts at verify time, on the
-- reasoning that ops know the customer rather than the invoice. That was
-- backwards. Ops are holding the customer's actual message — "paid your
-- invoice 0290" — and accounts are holding a bank credit with no invoice
-- reference on it at all. Asking accounts to choose meant asking the one
-- person in the loop who cannot know.
--
-- So the answer is captured where it is known and carried through to the
-- verify step, which pre-selects it. Accounts can still reallocate: the
-- customer may name the wrong invoice, or pay one and cite another. This
-- column is what the reporter was told, never a decision — the money settles
-- against billing_payment_id, which is set from whatever accounts actually
-- record.
--
-- Nullable on purpose. A reporter who genuinely wasn't told which invoice
-- must still be able to file the report; forcing a guess here would put a
-- confident wrong answer in front of accounts, which is worse than a blank
-- they know to resolve themselves.

ALTER TABLE query_payment_reports
  ADD COLUMN claimed_statement_id UUID REFERENCES billing_statements(id) ON DELETE SET NULL;

CREATE INDEX idx_qpr_claimed_statement
  ON query_payment_reports (claimed_statement_id)
  WHERE claimed_statement_id IS NOT NULL;

COMMENT ON COLUMN query_payment_reports.claimed_statement_id IS
  'The invoice the reporter was told this payment covers. Pre-selects the allocation at verify time; accounts may still reallocate. Not authoritative — billing_payment_id is.';

NOTIFY pgrst, 'reload schema';
