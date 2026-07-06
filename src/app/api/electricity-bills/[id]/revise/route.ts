import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

interface EbBillRow {
  id: string;
  status: string;
  location_id: string;
  bill_month: number;
  bill_year: number;
  reimbursement_enabled: boolean;
  contract_id: string | null;
  landlord_bill_number: string | null;
  landlord_bill_date: string | null;
  landlord_subtotal: number;
  landlord_gst: number;
  landlord_tds: number;
  landlord_net_payable: number;
  landlord_total_amount: number;
  landlord_gst_applicable: boolean;
  landlord_gst_rate: number | null;
  landlord_gst_amount: number;
  customer_subtotal: number | null;
  customer_cgst: number | null;
  customer_sgst: number | null;
  customer_round_off: number | null;
  customer_total: number | null;
  customer_gst_amount: number | null;
  vendor_bill_id: string | null;
  billing_statement_id: string | null;
  notes: string | null;
  electricity_bill_lines: Array<{
    line_type: string;
    meter_label: string | null;
    label: string | null;
    units: number | null;
    rate: number | null;
    amount: number;
    sort_order: number;
  }>;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // ── Auth ────────────────────────────────────────────────────────────────────
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or manager can revise electricity bills" }, { status: 403 });
  }

  // ── Fetch bill with lines ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawBill, error: billErr } = await (supabase as any)
    .from("electricity_bills")
    .select("*, electricity_bill_lines(*)")
    .eq("id", id)
    .single();

  if (billErr || !rawBill) {
    return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  }
  const bill = rawBill as EbBillRow;

  if (!["invoiced", "dispatched"].includes(bill.status)) {
    return NextResponse.json(
      { error: `Only invoiced or dispatched bills can be revised (current status: ${bill.status})` },
      { status: 422 },
    );
  }

  // ── If dispatched: check the linked statement has no payments ─────────────
  if (bill.status === "dispatched" && bill.billing_statement_id) {
    const { data: payments } = await supabase
      .from("billing_payments")
      .select("id")
      .eq("billing_statement_id", bill.billing_statement_id)
      .limit(1);

    if (payments && payments.length > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot revise: the linked billing statement has payments recorded. " +
            "Reverse the payment first, then revise.",
        },
        { status: 422 },
      );
    }

    // Void the linked billing statement
    const { error: voidErr } = await supabase
      .from("billing_statements")
      .update({ status: "voided", voided_at: new Date().toISOString() })
      .eq("id", bill.billing_statement_id);

    if (voidErr) {
      return NextResponse.json(
        { error: `Failed to void billing statement: ${voidErr.message}` },
        { status: 500 },
      );
    }
  }

  // ── Mark old bill as revised ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: reviseErr } = await (supabase as any)
    .from("electricity_bills")
    .update({ status: "revised" })
    .eq("id", id);

  if (reviseErr) {
    return NextResponse.json(
      { error: `Failed to mark bill as revised: ${reviseErr.message}` },
      { status: 500 },
    );
  }

  // ── Create new draft bill (same location/month/year, blank confirmation) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: newBill, error: insertErr } = await (supabase as any)
    .from("electricity_bills")
    .insert({
      location_id: bill.location_id,
      bill_month: bill.bill_month,
      bill_year: bill.bill_year,
      reimbursement_enabled: bill.reimbursement_enabled,
      contract_id: bill.contract_id,
      landlord_bill_number: bill.landlord_bill_number,
      landlord_bill_date: bill.landlord_bill_date,
      landlord_subtotal: bill.landlord_subtotal,
      landlord_gst: bill.landlord_gst,
      landlord_tds: bill.landlord_tds,
      landlord_net_payable: bill.landlord_net_payable,
      landlord_total_amount: bill.landlord_total_amount,
      landlord_gst_applicable: bill.landlord_gst_applicable,
      landlord_gst_rate: bill.landlord_gst_rate,
      landlord_gst_amount: bill.landlord_gst_amount,
      customer_subtotal: bill.customer_subtotal,
      customer_cgst: bill.customer_cgst,
      customer_sgst: bill.customer_sgst,
      customer_round_off: bill.customer_round_off,
      customer_total: bill.customer_total,
      customer_gst_amount: bill.customer_gst_amount,
      status: "draft",
      revised_from_id: id,
      notes: bill.notes,
      created_by: dbUser.id,
    })
    .select("id")
    .single();

  if (insertErr || !newBill) {
    return NextResponse.json(
      { error: insertErr?.message ?? "Failed to create revised bill" },
      { status: 500 },
    );
  }

  // ── Copy lines to new bill ────────────────────────────────────────────────
  if (bill.electricity_bill_lines.length > 0) {
    const linesToInsert = bill.electricity_bill_lines.map((l) => ({
      electricity_bill_id: newBill.id,
      line_type: l.line_type,
      meter_label: l.meter_label,
      label: l.label,
      units: l.units,
      rate: l.rate,
      amount: l.amount,
      sort_order: l.sort_order,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: linesErr } = await (supabase as any)
      .from("electricity_bill_lines")
      .insert(linesToInsert);

    if (linesErr) {
      return NextResponse.json(
        { error: `Bill created but lines failed: ${linesErr.message}` },
        { status: 500 },
      );
    }
  }

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: bill.status, new: "revised" },
      revised_to: { old: null, new: newBill.id },
    },
  });

  return NextResponse.json({
    revised_bill_id: newBill.id,
    message: "Bill marked as revised. New draft created with the same data — update lines and reconfirm.",
  });
}
