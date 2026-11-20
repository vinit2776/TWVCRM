-- Migration 00740: petty cash ledger + atomic balance changes
-- Until now a book was one editable number, changed by read-then-write in several places
-- (approve an expense, issue cash, pay a vendor bill in cash, reverse that payment).
-- Now every change to petty_cash_books.current_balance writes an immutable ledger row
-- (trigger), so balance = sum of the ledger and a mismatch can always be traced.
-- Approve / reject / issue become single locked transactions (RPCs, service role only).
-- Rollback: DROP the triggers + functions + petty_cash_ledger, and restore
-- reverse_vendor_bill_payment from 00597.

CREATE TABLE IF NOT EXISTS petty_cash_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       UUID NOT NULL REFERENCES petty_cash_books(id),
  kind          VARCHAR(20) NOT NULL CHECK (kind IN
                  ('opening','issue','spend','vendor_payment','vendor_reversal','adjustment','return')),
  amount        NUMERIC(12,2) NOT NULL,          -- signed: + money in, - money out
  balance_after NUMERIC(12,2) NOT NULL,
  entry_id      UUID REFERENCES petty_cash_entries(id),
  request_id    UUID REFERENCES petty_cash_requests(id),
  note          TEXT,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pc_ledger_book ON petty_cash_ledger(book_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pc_ledger_entry ON petty_cash_ledger(entry_id);

ALTER TABLE petty_cash_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read petty_cash_ledger"
  ON petty_cash_ledger FOR SELECT TO authenticated USING (true);
GRANT SELECT ON petty_cash_ledger TO authenticated;
GRANT ALL ON petty_cash_ledger TO service_role;

-- Rows are never edited or removed; a correction is a new row.
CREATE OR REPLACE FUNCTION pc_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'petty_cash_ledger rows cannot be changed or deleted';
END $$;
DROP TRIGGER IF EXISTS pc_ledger_no_change ON petty_cash_ledger;
CREATE TRIGGER pc_ledger_no_change BEFORE UPDATE OR DELETE ON petty_cash_ledger
  FOR EACH ROW EXECUTE FUNCTION pc_ledger_immutable();

-- Every book starts its statement from today's balance.
INSERT INTO petty_cash_ledger (book_id, kind, amount, balance_after, note)
SELECT b.id, 'opening', b.current_balance, b.current_balance, 'Opening balance when the statement started'
FROM petty_cash_books b
WHERE NOT EXISTS (SELECT 1 FROM petty_cash_ledger l WHERE l.book_id = b.id);

-- Any change to a balance, from any code path, is recorded. Callers label it by setting
-- transaction-local settings (pc.kind / pc.entry_id / pc.request_id / pc.user_id / pc.note);
-- an unlabelled change shows up as "adjustment" rather than going unrecorded.
CREATE OR REPLACE FUNCTION pc_book_balance_to_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_kind TEXT := COALESCE(NULLIF(current_setting('pc.kind', true), ''), 'adjustment');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_balance = 0 THEN RETURN NEW; END IF;
    INSERT INTO petty_cash_ledger (book_id, kind, amount, balance_after, note)
    VALUES (NEW.id, 'opening', NEW.current_balance, NEW.current_balance, 'Opening balance');
    RETURN NEW;
  END IF;
  INSERT INTO petty_cash_ledger (book_id, kind, amount, balance_after, entry_id, request_id, note, created_by)
  VALUES (
    NEW.id, v_kind, NEW.current_balance - OLD.current_balance, NEW.current_balance,
    NULLIF(current_setting('pc.entry_id', true), '')::uuid,
    NULLIF(current_setting('pc.request_id', true), '')::uuid,
    COALESCE(NULLIF(current_setting('pc.note', true), ''), 'Balance changed outside the petty cash screens'),
    NULLIF(current_setting('pc.user_id', true), '')::uuid
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pc_book_balance_ledger_upd ON petty_cash_books;
CREATE TRIGGER pc_book_balance_ledger_upd AFTER UPDATE OF current_balance ON petty_cash_books
  FOR EACH ROW WHEN (OLD.current_balance IS DISTINCT FROM NEW.current_balance)
  EXECUTE FUNCTION pc_book_balance_to_ledger();
DROP TRIGGER IF EXISTS pc_book_balance_ledger_ins ON petty_cash_books;
CREATE TRIGGER pc_book_balance_ledger_ins AFTER INSERT ON petty_cash_books
  FOR EACH ROW EXECUTE FUNCTION pc_book_balance_to_ledger();

-- ---------------------------------------------------------------------------
-- Approve an expense: one locked transaction. p_expected_status stops two approvers
-- from both acting on the same stage.
CREATE OR REPLACE FUNCTION pc_approve_entry(
  p_entry_id UUID, p_approver_id UUID, p_expected_status TEXT,
  p_next_status TEXT, p_level TEXT, p_note TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry   petty_cash_entries%ROWTYPE;
  v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_entry FROM petty_cash_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND'; END IF;
  IF v_entry.status::text IS DISTINCT FROM p_expected_status THEN RAISE EXCEPTION 'ENTRY_CHANGED'; END IF;
  IF p_next_status NOT IN ('pending_admin', 'approved') THEN RAISE EXCEPTION 'BAD_STATUS'; END IF;

  UPDATE petty_cash_entries SET status = p_next_status::pc_entry_status WHERE id = p_entry_id;
  INSERT INTO petty_cash_approvals (approval_type, entry_id, approver_id, approval_level, decision, note)
  VALUES ('entry', p_entry_id, p_approver_id, p_level::pc_approval_level, 'approved', p_note);

  IF p_next_status = 'approved' THEN
    PERFORM set_config('pc.kind', 'spend', true);
    PERFORM set_config('pc.entry_id', p_entry_id::text, true);
    PERFORM set_config('pc.user_id', p_approver_id::text, true);
    PERFORM set_config('pc.note', v_entry.entry_number || ' — ' || v_entry.description, true);
    UPDATE petty_cash_books SET current_balance = current_balance - v_entry.amount
     WHERE id = v_entry.book_id RETURNING current_balance INTO v_balance;
    PERFORM set_config('pc.kind', '', true);
    PERFORM set_config('pc.entry_id', '', true);
    PERFORM set_config('pc.user_id', '', true);
    PERFORM set_config('pc.note', '', true);
  END IF;

  RETURN jsonb_build_object('status', p_next_status, 'balance', v_balance);
END $$;

CREATE OR REPLACE FUNCTION pc_reject_entry(
  p_entry_id UUID, p_approver_id UUID, p_expected_status TEXT, p_level TEXT, p_note TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_entry petty_cash_entries%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM petty_cash_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND'; END IF;
  IF v_entry.status::text IS DISTINCT FROM p_expected_status THEN RAISE EXCEPTION 'ENTRY_CHANGED'; END IF;
  UPDATE petty_cash_entries SET status = 'rejected', rejection_note = p_note WHERE id = p_entry_id;
  INSERT INTO petty_cash_approvals (approval_type, entry_id, approver_id, approval_level, decision, note)
  VALUES ('entry', p_entry_id, p_approver_id, p_level::pc_approval_level, 'rejected', p_note);
  RETURN jsonb_build_object('status', 'rejected');
END $$;

-- Issue approved cash to a book.
CREATE OR REPLACE FUNCTION pc_issue_request(
  p_request_id UUID, p_issuer_id UUID, p_method TEXT, p_reference TEXT, p_proof_url TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req     petty_cash_requests%ROWTYPE;
  v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_req FROM petty_cash_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;
  IF v_req.status::text <> 'approved' THEN RAISE EXCEPTION 'REQUEST_CHANGED'; END IF;

  UPDATE petty_cash_requests SET
    status = 'issued', issued_by = p_issuer_id, issued_at = NOW(),
    issuance_method = p_method::pc_issuance_method,
    issuance_reference = p_reference, issuance_proof_url = p_proof_url
  WHERE id = p_request_id;

  PERFORM set_config('pc.kind', 'issue', true);
  PERFORM set_config('pc.request_id', p_request_id::text, true);
  PERFORM set_config('pc.user_id', p_issuer_id::text, true);
  PERFORM set_config('pc.note', v_req.request_number || ' — ' || v_req.purpose, true);
  UPDATE petty_cash_books SET current_balance = current_balance + v_req.amount_requested
   WHERE id = v_req.book_id RETURNING current_balance INTO v_balance;
  PERFORM set_config('pc.kind', '', true);
  PERFORM set_config('pc.request_id', '', true);
  PERFORM set_config('pc.user_id', '', true);
  PERFORM set_config('pc.note', '', true);

  RETURN jsonb_build_object('status', 'issued', 'balance', v_balance);
END $$;

-- A cash vendor-bill payment debits a book (overdraft allowed, as before).
CREATE OR REPLACE FUNCTION pc_debit_book(
  p_book_id UUID, p_amount NUMERIC, p_user_id UUID, p_note TEXT
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_balance NUMERIC(12,2);
BEGIN
  PERFORM 1 FROM petty_cash_books WHERE id = p_book_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOOK_NOT_FOUND'; END IF;
  PERFORM set_config('pc.kind', 'vendor_payment', true);
  PERFORM set_config('pc.user_id', COALESCE(p_user_id::text, ''), true);
  PERFORM set_config('pc.note', COALESCE(p_note, 'Vendor bill paid in cash'), true);
  UPDATE petty_cash_books SET current_balance = current_balance - p_amount
   WHERE id = p_book_id RETURNING current_balance INTO v_balance;
  PERFORM set_config('pc.kind', '', true);
  PERFORM set_config('pc.user_id', '', true);
  PERFORM set_config('pc.note', '', true);
  RETURN v_balance;
END $$;

REVOKE ALL ON FUNCTION pc_approve_entry(UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pc_reject_entry(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pc_issue_request(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pc_debit_book(UUID, NUMERIC, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pc_approve_entry(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pc_reject_entry(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pc_issue_request(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pc_debit_book(UUID, NUMERIC, UUID, TEXT) TO service_role;

-- Same function as 00597, plus labelling so the reversal reads as such in the statement.
CREATE OR REPLACE FUNCTION reverse_vendor_bill_payment(
  p_payment_id UUID,
  p_actor      UUID,
  p_reason     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay        vendor_bill_payments%ROWTYPE;
  v_bill       vendor_bills%ROWTYPE;
  v_new_paid   NUMERIC(12,2);
  v_ceiling    NUMERIC(12,2);
  v_status     TEXT;
  v_last       vendor_bill_payments%ROWTYPE;
  v_tds_total  NUMERIC(12,2);
  v_pc_credit  NUMERIC(12,2) := 0;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_pay FROM vendor_bill_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  -- Lock the bill first, then re-read the payment, so two concurrent reversals
  -- of the same payment serialise on the bill row.
  SELECT * INTO v_bill FROM vendor_bills WHERE id = v_pay.bill_id FOR UPDATE;
  SELECT * INTO v_pay FROM vendor_bill_payments WHERE id = p_payment_id;
  IF v_pay.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ALREADY_REVERSED'; END IF;

  -- A deposited TDS entry is tied to a filed challan; undoing the payment would
  -- leave the challan depositing tax that was never deducted.
  IF EXISTS (
    SELECT 1 FROM vendor_bill_tds
    WHERE payment_id = p_payment_id AND reversed_at IS NULL AND status = 'deposited'
  ) THEN
    RAISE EXCEPTION 'TDS_DEPOSITED';
  END IF;

  SELECT COALESCE(SUM(tds_amount), 0) INTO v_tds_total
  FROM vendor_bill_tds WHERE payment_id = p_payment_id AND reversed_at IS NULL;

  UPDATE vendor_bill_payments
     SET reversed_at = now(), reversed_by = p_actor, reversal_reason = btrim(p_reason)
   WHERE id = p_payment_id;

  UPDATE vendor_bill_tds SET reversed_at = now()
   WHERE payment_id = p_payment_id AND reversed_at IS NULL;

  -- Cash payments debited a petty cash book when they were recorded.
  IF v_pay.payment_mode = 'cash' AND v_pay.petty_cash_book_id IS NOT NULL THEN
    PERFORM set_config('pc.kind', 'vendor_reversal', true);
    PERFORM set_config('pc.user_id', COALESCE(p_actor::text, ''), true);
    PERFORM set_config('pc.note', 'Vendor bill payment reversed', true);
    UPDATE petty_cash_books
       SET current_balance = current_balance + v_pay.amount
     WHERE id = v_pay.petty_cash_book_id;
    PERFORM set_config('pc.kind', '', true);
    PERFORM set_config('pc.user_id', '', true);
    PERFORM set_config('pc.note', '', true);
    v_pc_credit := v_pay.amount;
  END IF;

  v_new_paid := GREATEST(COALESCE(v_bill.amount_paid, 0) - v_pay.amount, 0);
  v_ceiling  := COALESCE(v_bill.approved_amount, v_bill.total_amount, 0) + COALESCE(v_bill.gst_amount, 0);
  v_status   := CASE
                  WHEN v_new_paid >= v_ceiling - 0.01 AND v_new_paid > 0 THEN 'paid'
                  WHEN v_new_paid > 0.005 THEN 'partially_paid'
                  ELSE 'unpaid'
                END;

  -- The bill's denormalised "last payment" columns point at the newest payment
  -- that is still standing.
  SELECT * INTO v_last FROM vendor_bill_payments
   WHERE bill_id = v_bill.id AND reversed_at IS NULL
   ORDER BY payment_date DESC, created_at DESC LIMIT 1;

  UPDATE vendor_bills SET
    amount_paid       = v_new_paid,
    payment_status    = v_status::bill_payment_status,
    payment_mode      = v_last.payment_mode,
    payment_reference = v_last.payment_reference,
    payment_date      = v_last.payment_date,
    -- A cheque signature belongs to the cheque payment it signed; once no cheque
    -- payment stands, the signature is void too.
    cheque_signed_at  = CASE WHEN v_last.payment_mode = 'cheque' THEN v_bill.cheque_signed_at ELSE NULL END,
    cheque_signed_by  = CASE WHEN v_last.payment_mode = 'cheque' THEN v_bill.cheque_signed_by ELSE NULL END
  WHERE id = v_bill.id;

  RETURN jsonb_build_object(
    'bill_id', v_bill.id,
    'amount_reversed', v_pay.amount,
    'amount_paid', v_new_paid,
    'payment_status', v_status,
    'petty_cash_credited', v_pc_credit,
    'tds_reversed', v_tds_total,
    'previous', jsonb_build_object(
      'amount_paid', v_bill.amount_paid,
      'payment_status', v_bill.payment_status
    )
  );
END;
$$;
