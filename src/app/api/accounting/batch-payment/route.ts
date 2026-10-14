import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";
import { PARTIAL_PAYMENT_REASONS } from "@/lib/constants";

const BANK_MODES = ["neft", "rtgs", "imps", "bank_transfer", "cheque"] as const;

const tdsBillSchema = z.object({
  section_code: z.string(),
  vendor_type: z.enum(["individual", "huf", "company"]),
  base_amount: z.number().positive(),
  tds_rate: z.number().positive(),
  tds_amount: z.number().positive(),
  pan_available: z.boolean(),
});

const billItemSchema = z.object({
  bill_id: z.string().uuid(),
  /**
   * Amount to pay — at most the approved outstanding. Paying less is a partial
   * payment and needs `partial_reason`, same as the single-bill flow.
   */
  amount: z.number().positive(),
  partial_reason: z.enum(PARTIAL_PAYMENT_REASONS.map((r) => r.code) as [string, ...string[]]).nullish(),
  /**
   * Optional GST amount to set on the bill before recording payment.
   * If omitted or null, the bill's existing gst_amount is used as-is.
   */
  gst_amount: z.number().min(0).nullable().optional(),
  /** Optional TDS deduction for this bill. */
  tds: tdsBillSchema.optional(),
});

const batchPaymentSchema = z.object({
  /** Client-generated UUID shared across all payment rows in this batch. */
  batch_ref: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_mode: z.enum([...BANK_MODES, "cash"]),
  payment_reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Petty cash book to debit when payment_mode is cash (optional, as for a single bill). */
  petty_cash_book_id: z.string().uuid().nullish(),
  bills: z.array(billItemSchema).min(1, "Select at least one bill"),
});

/**
 * POST /api/accounting/batch-payment
 *
 * Records a single-instrument payment covering multiple approved vendor bills.
 * All bills get the same payment_mode / payment_reference / payment_date /
 * batch_ref, but each bill's gst_amount can be set individually before the
 * payment is recorded.
 *
 * Roles: admin and accounts (all modes, as for a single bill), office_admin (cash only).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  // Role gate
  if (!["admin", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to record payments" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = batchPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { batch_ref, payment_date, payment_mode, payment_reference, notes, petty_cash_book_id, bills } = parsed.data;

  // Payment mode gate by role
  if (dbUser.role === "office_admin" && payment_mode !== "cash") {
    return NextResponse.json(
      { error: "Petty cash payments only — bank payments must be processed by the Accounts team" },
      { status: 403 }
    );
  }

  const adminSupabase = createAdminClient();

  // Fetch all bills in one query (admin client so we skip RLS)
  const billIds = bills.map((b) => b.bill_id);
  const { data: dbBills, error: fetchErr } = await adminSupabase
    .from("vendor_bills")
    .select("id, bill_number, approval_status, payment_status, payment_hold_status, payment_hold_reason, total_amount, amount_paid, approved_amount, gst_amount")
    .in("id", billIds);

  if (fetchErr || !dbBills) {
    return NextResponse.json({ error: "Failed to fetch bills" }, { status: 500 });
  }

  // Validate each bill before touching anything
  const billMap = new Map(dbBills.map((b) => [b.id, b]));
  const validationErrors: string[] = [];

  for (const item of bills) {
    const bill = billMap.get(item.bill_id);
    if (!bill) { validationErrors.push(`Bill ${item.bill_id} not found`); continue; }

    if (bill.approval_status !== "approved") {
      validationErrors.push(`${bill.bill_number}: not approved`);
      continue;
    }
    if (bill.payment_status === "paid") {
      validationErrors.push(`${bill.bill_number}: already fully paid`);
      continue;
    }
    // Validation runs before anything is paid, so one held bill refuses the whole batch.
    if (bill.payment_hold_status === "on_hold") {
      const reason = bill.payment_hold_reason ? ` (${bill.payment_hold_reason.replace(/_/g, " ")})` : "";
      validationErrors.push(`${bill.bill_number}: on hold${reason}`);
      continue;
    }

    // Compute approved ceiling with (possibly updated) GST
    const gstToUse = item.gst_amount != null ? item.gst_amount : Number(bill.gst_amount ?? 0);
    const approvedBase = Number(bill.approved_amount ?? bill.total_amount);
    const ceiling = approvedBase + gstToUse;
    const alreadyPaid = Number(bill.amount_paid ?? 0);
    const outstanding = ceiling - alreadyPaid;

    if (item.amount > outstanding + 0.5) {
      validationErrors.push(
        `${bill.bill_number}: amount ₹${item.amount.toFixed(2)} exceeds outstanding ₹${outstanding.toFixed(2)}`
      );
    } else if (item.amount < outstanding - 0.5 && !item.partial_reason) {
      validationErrors.push(
        `${bill.bill_number}: ₹${item.amount.toFixed(2)} of ₹${outstanding.toFixed(2)} outstanding is a partial payment — select a reason`
      );
    }
  }

  if (validationErrors.length > 0) {
    return NextResponse.json({ error: validationErrors.join("; ") }, { status: 422 });
  }

  // Process bills sequentially — update GST if changed, insert payment, update bill
  const processed: { bill_id: string; bill_number: string; amount: number }[] = [];
  const failed: { bill_id: string; bill_number: string; error: string }[] = [];

  for (const item of bills) {
    const bill = billMap.get(item.bill_id)!;

    try {
      // 1. Update gst_amount on the bill if caller supplied a value different from stored
      const storedGst = Number(bill.gst_amount ?? 0);
      const newGst = item.gst_amount != null ? item.gst_amount : storedGst;

      // The wizard's per-bill GST step is the user's confirmation, so stamp it the
      // way the single-bill flow does (including an explicit zero-GST confirmation).
      if (item.gst_amount != null) {
        const gstNow = new Date().toISOString();
        const { error: gstErr } = await adminSupabase
          .from("vendor_bills")
          .update({
            gst_amount: newGst,
            base_amount: Number(bill.total_amount), // total_amount IS the base
            gst_set_by: dbUser.id,
            gst_set_at: gstNow,
            gst_zero_confirmed: newGst === 0,
            gst_zero_confirmed_by: newGst === 0 ? dbUser.id : null,
          })
          .eq("id", bill.id);

        if (gstErr) {
          failed.push({ bill_id: bill.id, bill_number: bill.bill_number, error: gstErr.message });
          continue;
        }
      }

      // 2. Compute final ceiling and new amount_paid
      const approvedBase = Number(bill.approved_amount ?? bill.total_amount);
      const finalCeiling = approvedBase + newGst;
      const alreadyPaid = Number(bill.amount_paid ?? 0);
      const newAmountPaid = alreadyPaid + item.amount;
      const paymentStatus = newAmountPaid >= finalCeiling - 0.01 ? "paid" : "partially_paid";
      const isPartial = item.amount < finalCeiling - alreadyPaid - 0.01;

      // 3. Insert vendor_bill_payments row
      const { data: paymentRow, error: payErr } = await adminSupabase
        .from("vendor_bill_payments")
        .insert({
          bill_id: bill.id,
          amount: item.amount,
          payment_mode,
          payment_reference: payment_reference ?? null,
          payment_date,
          notes: notes ?? null,
          recorded_by: dbUser.id,
          batch_ref,
          partial_reason: isPartial ? item.partial_reason ?? null : null,
          petty_cash_book_id: payment_mode === "cash" ? petty_cash_book_id ?? null : null,
        })
        .select("id")
        .single();

      if (payErr) {
        failed.push({ bill_id: bill.id, bill_number: bill.bill_number, error: payErr.message });
        continue;
      }

      // 3b. Insert TDS deduction if provided for this bill
      if (item.tds && paymentRow?.id) {
        const pd = new Date(payment_date);
        await adminSupabase.from("vendor_bill_tds").insert({
          bill_id: bill.id,
          payment_id: paymentRow.id,
          section_code: item.tds.section_code,
          vendor_type: item.tds.vendor_type,
          base_amount: item.tds.base_amount,
          tds_rate: item.tds.tds_rate,
          tds_amount: item.tds.tds_amount,
          pan_available: item.tds.pan_available,
          period_month: pd.getMonth() + 1,
          period_year: pd.getFullYear(),
          created_by: dbUser.id,
        });
      }

      // 4. Update vendor_bills totals
      const { error: billErr } = await adminSupabase
        .from("vendor_bills")
        .update({
          amount_paid: newAmountPaid,
          payment_status: paymentStatus,
          payment_mode,
          payment_reference: payment_reference ?? null,
          payment_date,
        })
        .eq("id", bill.id);

      if (billErr) {
        failed.push({ bill_id: bill.id, bill_number: bill.bill_number, error: billErr.message });
        continue;
      }

      // 5. Audit log (fire-and-forget)
      logAudit(adminSupabase, {
        entityType: "vendor_bill",
        entityId: bill.id,
        action: "update",
        performedBy: dbUser.id,
        changes: {
          amount_paid: { old: alreadyPaid, new: newAmountPaid },
          payment_status: { old: bill.payment_status, new: paymentStatus },
          batch_ref: { old: null, new: batch_ref },
          ...(isPartial ? { partial_payment_reason: { old: null, new: item.partial_reason ?? null } } : {}),
        },
      }).catch(() => {});

      processed.push({ bill_id: bill.id, bill_number: bill.bill_number, amount: item.amount });
    } catch (err) {
      failed.push({
        bill_id: bill.id,
        bill_number: bill.bill_number,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const totalPaid = processed.reduce((s, p) => s + p.amount, 0);

  // Debit the petty cash book once for everything that was actually paid
  // (overdraft allowed, as for a single bill).
  if (payment_mode === "cash" && petty_cash_book_id && totalPaid > 0) {
    const { data: pcBook } = await adminSupabase
      .from("petty_cash_books")
      .select("id, current_balance")
      .eq("id", petty_cash_book_id)
      .single();
    if (pcBook) {
      await adminSupabase
        .from("petty_cash_books")
        .update({ current_balance: Number(pcBook.current_balance) - totalPaid })
        .eq("id", petty_cash_book_id);
    }
  }

  return NextResponse.json({
    batch_ref,
    processed_count: processed.length,
    failed_count: failed.length,
    total_paid: totalPaid,
    processed,
    failed,
  }, { status: failed.length === 0 ? 200 : 207 });
}
