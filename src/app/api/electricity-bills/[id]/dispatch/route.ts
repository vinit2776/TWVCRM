import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";

interface EbBillRow {
  id: string;
  status: string;
  contract_id: string | null;
  location_id: string;
  bill_month: number;
  bill_year: number;
  customer_subtotal: number | null;
  customer_cgst: number | null;
  customer_sgst: number | null;
  customer_total: number | null;
  customer_utility_pct: number | null;
  customer_generator_pct: number | null;
  customer_units_billed: number | null;
  customer_utility_rate: number | null;
  customer_generator_rate: number | null;
  gst_rate: number | null;
  billing_statement_id: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * POST /api/electricity-bills/[id]/dispatch
 *
 * One-click "bill the customer": creates the billing_statements row with a
 * proper Utility/DG line-item breakdown, finalizes it immediately, and sends
 * it per the contract's billing_mode — Proforma+Razorpay link for
 * proforma_first, or the GST tax invoice directly for gst_direct. No separate
 * Finalize/Send step exists elsewhere in the app for statement_type=electricity
 * (it isn't fetched by the Rent or Usage tabs), so this route owns the whole
 * "bill to customer" action. Once sent, the statement shows up in Receivables
 * (AR) automatically (that view is generic on status/payment_status).
 *
 * If the send fails (e.g. missing customer contact), the statement is deleted
 * and the electricity bill stays "invoiced" so the operator can fix the
 * underlying issue and retry — mirrors the rollback pattern in
 * finalize-and-send/route.ts.
 */
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
        "customer_subtotal, customer_cgst, customer_sgst, customer_total, " +
        "customer_utility_pct, customer_generator_pct, customer_units_billed, " +
        "customer_utility_rate, customer_generator_rate, gst_rate, billing_statement_id",
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
  const monthLabel = new Date(bill.bill_year, bill.bill_month - 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

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

  // ── Fetch contract for lead_id + billing_mode ──────────────────────────────
  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id, billing_mode")
    .eq("id", bill.contract_id)
    .single();
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 422 });
  }

  // ── Build the Utility/DG line-item breakdown ───────────────────────────────
  // Reconstructed from the stored split % + total units — matches exactly how
  // approve_electricity_landlord_bill computed them (see 00322 migration).
  const totalUnits = Number(bill.customer_units_billed ?? 0);
  const utilityUnits = round2((totalUnits * Number(bill.customer_utility_pct ?? 0)) / 100);
  const generatorUnits = round2((totalUnits * Number(bill.customer_generator_pct ?? 0)) / 100);

  const items: Array<{ description: string; qty: number; unit_price: number; amount: number; hsn_sac_code: string }> = [];
  if (utilityUnits > 0) {
    const rate = Number(bill.customer_utility_rate ?? 0);
    items.push({
      description: `Electricity — Utility/Grid (${monthLabel})`,
      qty: utilityUnits,
      unit_price: rate,
      amount: round2(utilityUnits * rate),
      hsn_sac_code: "996912",
    });
  }
  if (generatorUnits > 0) {
    const rate = Number(bill.customer_generator_rate ?? 0);
    items.push({
      description: `Electricity — DG/Generator (${monthLabel})`,
      qty: generatorUnits,
      unit_price: rate,
      amount: round2(generatorUnits * rate),
      hsn_sac_code: "996912",
    });
  }

  const lineItems = [
    {
      type: "electricity",
      label: "Electricity Charges",
      subtotal: Number(bill.customer_subtotal ?? 0),
      items,
    },
  ];

  // ── Insert billing_statement — finalized immediately, no draft limbo ──────
  const nowIso = new Date().toISOString();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  istNow.setUTCDate(istNow.getUTCDate() + 7);
  const dueDate = istNow.toISOString().slice(0, 10);

  const { data: statement, error: stmtErr } = await supabase
    .from("billing_statements")
    .insert({
      contract_id: bill.contract_id,
      lead_id: contract.lead_id ?? null,
      period_start: periodStart,
      period_end: periodEnd,
      statement_type: "electricity",
      // customer_subtotal → fixed_amount; GST (CGST+SGST) → usage_amount; total → total_amount
      fixed_amount: bill.customer_subtotal ?? 0,
      usage_amount: (bill.customer_cgst ?? 0) + (bill.customer_sgst ?? 0),
      total_amount: bill.customer_total ?? 0,
      tax_percentage: bill.gst_rate ?? 18,
      line_items: lineItems,
      status: "finalized",
      finalized_at: nowIso,
      due_date: dueDate,
      notes: `Electricity bill — ${monthLabel}`,
    })
    .select("id, statement_number")
    .single();

  if (stmtErr || !statement) {
    return NextResponse.json(
      { error: stmtErr?.message ?? "Failed to create billing statement" },
      { status: 500 },
    );
  }

  // ── Send per the contract's billing mode ───────────────────────────────────
  const billingMode = (contract as { billing_mode?: string | null }).billing_mode;
  const isGstDirect = billingMode === "gst_direct";

  // Handoff v2 hook — same gate the regular rent/usage dispatch (billing.ts)
  // applies: when the flag is on and this is a gst_direct contract, skip the
  // CRM's own PDF/email and route to Tally Inbox instead — accounts issues
  // the signed GST invoice in Tally and uploads it from /accounting/inbox,
  // which is what actually sends it to the customer. Without this gate the
  // electricity dispatch route would always take the legacy CRM-direct path,
  // bypassing Tally Inbox regardless of the flag.
  const handoff = await handleStatementFinalized(
    supabase,
    statement.id,
    (billingMode as "proforma_first" | "gst_direct" | null) ?? null,
    "electricity_dispatch",
  );

  const dispatchResult = handoff.skipLegacyDispatch
    ? {
        success: true,
        proformaRef: statement.statement_number as string,
        totalAmount: bill.customer_total ?? 0,
        razorpayLinkUrl: null,
        emailedTo: null,
        emailSkipped: true,
        noContact: false,
      }
    : isGstDirect
      ? await dispatchGstDirect(supabase, statement.id, dbUser.id, [])
      : await dispatchProforma(supabase, statement.id, dbUser.id, []);

  if (!dispatchResult.success) {
    // Send failed — delete the orphaned statement so the operator can retry
    // cleanly (electricity bill stays "invoiced", not "dispatched").
    await supabase.from("billing_statements").delete().eq("id", statement.id);
    return NextResponse.json(
      {
        error: `Statement created but sending to the customer failed (rolled back): ${dispatchResult.error || "unknown error"}`,
        rolled_back: true,
      },
      { status: 502 },
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
    // The statement was already sent to the customer — can't cleanly roll
    // that back. Surface the linking failure so it can be fixed manually.
    return NextResponse.json(
      { error: `Statement sent, but failed to link back to the electricity bill: ${(linkErr as { message?: string }).message}` },
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
    statement_number: dispatchResult.proformaRef,
    razorpay_link_url: dispatchResult.razorpayLinkUrl,
    emailed_to: dispatchResult.emailedTo,
    no_contact: dispatchResult.noContact,
    routed_to_tally: handoff.skipLegacyDispatch,
    message: handoff.skipLegacyDispatch
      ? `Billing statement ${dispatchResult.proformaRef} created and routed to Tally Inbox — accounts will issue the signed GST invoice and it'll be sent to the customer on upload`
      : dispatchResult.noContact
        ? `Billing statement ${dispatchResult.proformaRef} created — customer has no email/phone on file, nothing was sent`
        : `Billing statement ${dispatchResult.proformaRef} created and sent to the customer`,
  });
}
