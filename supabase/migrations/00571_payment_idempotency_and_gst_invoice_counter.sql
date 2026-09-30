-- Payment idempotency + race-free GST invoice numbers.
--
-- 1. billing_payments.razorpay_payment_id becomes unique, so a retried or
--    concurrent Razorpay webhook delivery can't book the same payment twice.
--    The webhook treats the unique violation (23505) as "already recorded".
--
--    Rows that are ALREADY duplicated can't be fixed by a migration (they are
--    real receivables records; accounts has to decide which one to remove), so
--    those payment ids are excluded from the index predicate instead of making
--    this migration fail. Every other payment id — including every future one —
--    is protected. The ids are listed in a NOTICE so they can be reconciled.
--
-- 2. GST invoice numbers (TWV/INV/YY-YY/NNNN) were minted as
--    COUNT(existing in FY) + 1 with no lock, in three places. Two concurrent
--    issuances got the same number, and a cleared number (see 00166) made the
--    count lag the highest issued number. next_gst_invoice_number() replaces
--    that with a per-FY counter row, bumped under a row lock and floored at the
--    highest number already issued. A number handed out whose save then fails
--    becomes a gap — acceptable; a duplicate tax invoice number is not.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS next_gst_invoice_number(text);
--   DROP TABLE IF EXISTS gst_invoice_counters;
--   DROP INDEX IF EXISTS uq_billing_payments_razorpay_payment_id;

-- ── 1. billing_payments: one row per Razorpay payment ──────────────────────
DO $$
DECLARE
  dup_ids text[];
  predicate text := 'razorpay_payment_id IS NOT NULL';
BEGIN
  SELECT array_agg(razorpay_payment_id ORDER BY razorpay_payment_id)
    INTO dup_ids
    FROM (
      SELECT razorpay_payment_id
        FROM public.billing_payments
       WHERE razorpay_payment_id IS NOT NULL
       GROUP BY razorpay_payment_id
      HAVING COUNT(*) > 1
    ) d;

  IF dup_ids IS NOT NULL THEN
    RAISE NOTICE 'billing_payments has % Razorpay payment id(s) recorded more than once, left out of the unique index: %',
      array_length(dup_ids, 1), dup_ids;
    predicate := predicate || ' AND razorpay_payment_id NOT IN ('
      || (SELECT string_agg(quote_literal(x), ', ') FROM unnest(dup_ids) x) || ')';
  END IF;

  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_payments_razorpay_payment_id '
       || 'ON public.billing_payments (razorpay_payment_id) WHERE ' || predicate;
END $$;

-- ── 2a. Per-FY GST invoice counter ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gst_invoice_counters (
  fy_prefix   text        PRIMARY KEY,           -- e.g. 'TWV/INV/26-27/'
  last_seq    integer     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gst_invoice_counters ENABLE ROW LEVEL SECURITY;

-- Read-only for staff; only next_gst_invoice_number() (SECURITY DEFINER) writes.
DROP POLICY IF EXISTS "gst_invoice_counters_select" ON public.gst_invoice_counters;
CREATE POLICY "gst_invoice_counters_select" ON public.gst_invoice_counters
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.next_gst_invoice_number(p_fy_prefix text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq integer;
  v_max integer;
BEGIN
  IF p_fy_prefix IS NULL OR p_fy_prefix !~ '^TWV/INV/[0-9]{2}-[0-9]{2}/$' THEN
    RAISE EXCEPTION 'invalid GST invoice prefix: %', p_fy_prefix;
  END IF;

  -- Make sure the row exists, then take its lock. Concurrent callers queue
  -- here until the first one's transaction (this RPC call) commits.
  INSERT INTO gst_invoice_counters (fy_prefix, last_seq)
  VALUES (p_fy_prefix, 0)
  ON CONFLICT (fy_prefix) DO NOTHING;

  SELECT last_seq INTO v_seq
    FROM gst_invoice_counters
   WHERE fy_prefix = p_fy_prefix
     FOR UPDATE;

  -- Floor at the highest number already on a statement, so the counter can
  -- never hand out a number that exists (first use in an FY, or a number
  -- written by some other path).
  SELECT COALESCE(MAX(substr(gst_invoice_number, length(p_fy_prefix) + 1)::integer), 0)
    INTO v_max
    FROM billing_statements
   WHERE left(gst_invoice_number, length(p_fy_prefix)) = p_fy_prefix
     AND substr(gst_invoice_number, length(p_fy_prefix) + 1) ~ '^[0-9]+$';

  v_seq := GREATEST(v_seq, v_max) + 1;

  UPDATE gst_invoice_counters
     SET last_seq = v_seq, updated_at = now()
   WHERE fy_prefix = p_fy_prefix;

  RETURN p_fy_prefix || lpad(v_seq::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_gst_invoice_number(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_gst_invoice_number(text) TO service_role;
