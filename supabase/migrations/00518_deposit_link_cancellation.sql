-- Let a proposal's security-deposit payment link be cancelled.
--
-- Deposit top-ups have had this since they were built: an admin can cancel a
-- pending top-up with a reason, and the endpoint also cancels the payment
-- link at Razorpay so the customer cannot still pay it. Proposal deposits
-- never got the equivalent, so a link, once issued, stayed payable forever.
--
-- That is not theoretical. At the time of writing four proposals carry live
-- deposit links totalling ₹2,59,000 with nothing chasing them, and one of
-- those proposals is REJECTED. Paying that link today would mark the deposit
-- paid and — because the payments webhook also sets status = 'accepted' —
-- resurrect a dead proposal into an accepted one. The webhook guard ships in
-- the same PR as this migration.
--
-- Cancelling records who did it and why rather than just blanking the link
-- columns, so a deposit that quietly stopped being collectable can still be
-- explained months later. The link ids themselves are cleared, which is what
-- takes the proposal out of the chase.

ALTER TABLE proposals
  ADD COLUMN deposit_link_cancelled_at  TIMESTAMPTZ,
  ADD COLUMN deposit_link_cancelled_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deposit_link_cancel_reason TEXT;

-- A cancellation is only a cancellation with all three parts: when, who, why.
-- Half a record here is worse than none, because it looks like an answer.
ALTER TABLE proposals
  ADD CONSTRAINT proposals_deposit_link_cancel_complete CHECK (
    (deposit_link_cancelled_at IS NULL
      AND deposit_link_cancelled_by IS NULL
      AND deposit_link_cancel_reason IS NULL)
    OR
    (deposit_link_cancelled_at IS NOT NULL
      AND deposit_link_cancel_reason IS NOT NULL
      AND length(trim(deposit_link_cancel_reason)) > 0)
  );

CREATE INDEX idx_proposals_deposit_link_cancelled
  ON proposals (deposit_link_cancelled_at)
  WHERE deposit_link_cancelled_at IS NOT NULL;

COMMENT ON COLUMN proposals.deposit_link_cancel_reason IS
  'Why the security-deposit payment link was withdrawn. Required whenever deposit_link_cancelled_at is set. The deposit itself may still be owed — this records that the link is dead, not that the money is.';

NOTIFY pgrst, 'reload schema';
