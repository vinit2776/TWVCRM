-- Renewal "agreed with" note.
--
-- Escalation negotiation was only visible as numbers: the parent contract's
-- escalation clause versus the renewal's own escalation_percentage. There was
-- nowhere to say *why* a customer got a lower increase (traded for more seats,
-- longer tenure, a one-off concession). This adds an optional internal note on
-- the renewal contract, set when the renewal is created or while its draft is
-- edited, and read by the lead's Value > Journey view.
--
-- Internal only: it is a new column, so it never reaches the agreement or any
-- invoice template. No RLS change (contracts already has policies).
--
-- Rollback: ALTER TABLE contracts DROP COLUMN renewal_agreed_note;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS renewal_agreed_note text
  CONSTRAINT contracts_renewal_agreed_note_length
    CHECK (renewal_agreed_note IS NULL OR char_length(renewal_agreed_note) <= 1000);

COMMENT ON COLUMN contracts.renewal_agreed_note IS
  'Optional internal note on what was agreed in the renewal negotiation (max 1000 chars). Set on renewal contracts only; never rendered into customer documents.';
