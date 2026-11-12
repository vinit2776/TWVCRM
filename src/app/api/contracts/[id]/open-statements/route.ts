import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { balanceDue, paymentCredit } from "@/lib/settlement";
import { statementReference } from "@/lib/receivables";

/**
 * GET /api/contracts/[id]/open-statements — this contract's unpaid finalized
 * statements, with balance due.
 *
 * Exists for the "allocate to invoice" picker when accounts verify a reported
 * payment. The AR feed can't serve it: it returns every open statement in the
 * business with the full contract/lead/proposal/case join tree, which is a
 * lot of round trips to answer "which of this one customer's invoices is
 * still owed".
 *
 * Balance is computed with the shared settlement helpers rather than a local
 * subtraction, so a TDS-bearing partial payment doesn't make an invoice look
 * more owed than it is.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!dbUser || !["admin", "manager", "accounts", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: statements, error } = await supabase
    .from("billing_statements")
    .select("id, statement_number, gst_invoice_number, total_amount, due_date")
    .eq("contract_id", id)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (statements ?? []).map((s) => s.id as string);
  const paid = new Map<string, number>();

  if (ids.length > 0) {
    const { data: payments } = await supabase
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", ids);

    for (const p of payments ?? []) {
      const row = p as { billing_statement_id: string; amount: number; tds_amount: number | null };
      paid.set(row.billing_statement_id, (paid.get(row.billing_statement_id) ?? 0) + paymentCredit(row));
    }
  }

  const data = (statements ?? []).map((s) => ({
    id: s.id as string,
    statement_number: (s.statement_number as string | null) ?? null,
    gst_invoice_number: (s.gst_invoice_number as string | null) ?? null,
    // What the invoice is actually called on screen — the GST number once one
    // exists, so a picker here matches the AR row for the same invoice.
    reference: statementReference(s as { statement_number: string | null; gst_invoice_number: string | null }),
    total_amount: Number(s.total_amount ?? 0),
    due_date: (s.due_date as string | null) ?? null,
    balance_due: Math.round(balanceDue(s.total_amount as number, paid.get(s.id as string) ?? 0)),
  }));

  return NextResponse.json({ data });
}
