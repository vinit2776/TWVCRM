-- Backfill deposit_payment_medium for deposits paid through a Razorpay link.
--
-- The payment webhook marked these paid but never stamped the medium (fixed
-- in the same PR as this migration), so the Tally Inbox showed them with a
-- blank "how it arrived" column — worse than manually recorded deposits,
-- which have always set it.
--
-- Scoped to rows that carry a Razorpay link id: that is direct evidence the
-- money came through a link, so 'razorpay' is a fact about them rather than a
-- guess. Deposits with a null medium and NO link id are deliberately left
-- alone — they predate the medium column or were marked paid by some other
-- route, and inventing a medium for them would put unreliable data in front
-- of accounts on a screen whose entire job is telling them what actually
-- happened. A blank is honest; a wrong value is not.
--
-- Rollback:
--   UPDATE proposals SET deposit_payment_medium = NULL
--    WHERE deposit_payment_medium = 'razorpay'
--      AND deposit_razorpay_link_id IS NOT NULL;

UPDATE proposals
   SET deposit_payment_medium = 'razorpay'
 WHERE deposit_payment_status = 'paid'
   AND deposit_payment_medium IS NULL
   AND deposit_razorpay_link_id IS NOT NULL;
