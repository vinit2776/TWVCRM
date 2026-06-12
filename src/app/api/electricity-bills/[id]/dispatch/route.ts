import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

interface EbBillRow {
  id: string;
  status: string;
  contract_id: string | null;
  location_id: string;
  bill_month: number;
  bill_year: number;
  customer_subtotal: number | null;
  customer_gst_amount: number | null;
  customer_total: number | null;
  billing_statement_id: string | null;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createAdminClient();

  // ── Auth ────────────────────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const allowed = ["admin", "manager", "accounts"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Fetch bill ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawBill, error: billErr } = await (supabase as any)
    .from("electricity_bills")
    .select(
      "id, status, contract_id, location_id, bill_month, bill_year, " +
        "customer_subtotal, customer_gst_amount, customer_total, billing_statement_id",
    )
    .eq("id", id)
    .single();

  if (billErr || !rawBill) {
    return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  }
  const bill = rawBill as EbBillRow;

  if (bill.status !== "invoiced") {
    return NextResponse.json(
      { error: "Only confirmed (invoiced) bills can be dispatched" },
      { status: 422 },
    );
  }
  if (bill.billing_statement_id) {
    return NextResponse.json(
      { error: "Bill has already been dispatched" },
      { status: 422 },
    );
  }
  if (!bill.contract_id) {
    return NextResponse.json(
      {
        error:
          "Bill has no linked contract — reimbursement must be enabled and a contract assigned before dispatch",
      },
      { status: 422 },
    );
  }

  // ── Period dates ─────────────────────────────────────────────────────────────
  const paddedMonth = String(bill.bill_month).padStart(2, "0");
  const periodStart = `${bill.bill_year}-${paddedMonth}-01`;
  const lastDay = new Date(bill.bill_year, bill.bill_month, 0).getDate();
  const periodEnd = `${bill.bill_year}-${paddedMonth}-${String(lastDay).padStart(2, "0")}`;

  // ── PI-first guard: no non-voided electricity statement for same contract + period ─
  const { data: existing } = await supabase
    .from("billing_statements")
    .select("id, statement_number, status")
    .eq("contract_id", bill.contract_id)
    .eq("period_start", periodStart)
    .eq("statement_type", "electricity")
    .neq("status", "voided")
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      {
        error: `An electricity statement already exists for this contract and period (${existing.statement_number})`,
        existing_statement_id: existing.id,
      },
      { status: 409 },
    );
  }

  // ── Fetch contract to get lead_id ─────────────────────────────────────────
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id")
    .eq("id", bill.contract_id)
    .single();
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 422 });
  }

  // ── Insert billing_statement ──────────────────────────────────────────────
  const { data: statement, error: stmtErr } = await supabase
    .from("billing_statements")
    .insert({
      contract_id: bill.contract_id,
      lead_id: contract.lead_id ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      statement_type: "electricity",
      // customer_subtotal → fixed_amount; GST → usage_amount; total → total_amount
      fixed_amount: bill.customer_subtotal ?? 0,
      usage_amount: bill.customer_gst_amount ?? 0,
      total_amount: bill.customer_total ?? 0,
      status: "draft",
      notes: `Electricity bill — ${new Date(bill.bill_year, bill.bill_month - 1).toLocaleString("en-IN", { month: "long", year: "numeric" })}`,
    })
    .select("id, statement_number")
    .single();

  if (stmtErr || !statement) {
    return NextResponse.json(
      { error: stmtErr?.message ?? "Failed to create billing statement" },
      { status: 500 },
    );
  }

  // ── Link statement back to the electricity bill ───────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: linkErr } = await (supabase as any)
    .from("electricity_bills")
    .update({
      billing_statement_id: statement.id,
      status: "dispatched",
    })
    .eq("id", id);

  if (linkErr) {
    // Best-effort rollback of the orphaned statement
    await supabase.from("billing_statements").delete().eq("id", statement.id);
    return NextResponse.json(
      { error: (linkErr as { message?: string }).message ?? "Failed to link statement" },
      { status: 500 },
    );
  }

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "invoiced", new: "dispatched" },
      billing_statement_id: { old: null, new: statement.id },
    },
  });

  return NextResponse.json({
    statement_id: statement.id,
    statement_number: statement.statement_number,
    message: `Billing statement ${statement.statement_number} created`,
  });
}
