import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/prorata-link
 *
 * Creates a billing statement for the partial first month of a mid-month renewal,
 * then dispatches a proforma invoice with a Razorpay payment link to the client.
 * The statement flows into the Tally inbox for GST invoice issuance on payment.
 *
 * Idempotent: if a statement already exists (prorata_billing_statement_id is set),
 * re-dispatches the proforma (fresh Razorpay link) without creating a new statement.
 *
 * Body: { waive?: boolean, waive_reason?: string }  — admin-only waive path
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json().catch(() => ({}));

  const admin = createAdminClient();

  // Fetch the renewal contract with lead details
  const { data: contract, error: fetchErr } = await admin
    .from("contracts")
    .select(`
      *,
      lead:leads!contracts_lead_id_fkey(
        id, first_name, last_name, company, email, phone, mobile, gst_number, state
      )
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.is_renewal) {
    return NextResponse.json({ error: "Only renewal contracts have pro-rata collection" }, { status: 400 });
  }

  if (contract.prorata_payment_status === "not_applicable") {
    return NextResponse.json({ error: "This renewal starts on the 1st — no pro-rata needed" }, { status: 400 });
  }

  if (contract.prorata_payment_status === "paid") {
    return NextResponse.json({ error: "Pro-rata has already been paid" }, { status: 400 });
  }

  // Waive path (admin only)
  if (body.waive === true) {
    if (dbUser.role !== "admin") {
      return NextResponse.json({ error: "Only admins can waive the pro-rata collection" }, { status: 403 });
    }
    if (!body.waive_reason?.trim()) {
      return NextResponse.json({ error: "Waiver reason is required" }, { status: 400 });
    }

    await admin
      .from("contracts")
      .update({ prorata_payment_status: "waived" })
      .eq("id", id);

    logAudit(admin, {
      entityType: "contract",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        prorata_payment_status: { old: contract.prorata_payment_status, new: "waived" },
        prorata_waiver_reason: { old: null, new: body.waive_reason.trim() },
      },
    });

    return NextResponse.json({ success: true, waived: true });
  }

  // Send PI path
  const allowedSendRoles = ["admin", "manager", "accounts", "sales_rep"];
  if (!allowedSendRoles.includes(dbUser.role)) {
    return NextResponse.json({ error: "You do not have permission to send the pro-rata PI" }, { status: 403 });
  }

  // Calculate pro-rata period
  const startDate = new Date(contract.start_date + "T00:00:00Z");
  const startYear = startDate.getUTCFullYear();
  const startMonth = startDate.getUTCMonth(); // 0-indexed
  const startDay = startDate.getUTCDate();
  const daysInMonth = new Date(Date.UTC(startYear, startMonth + 1, 0)).getUTCDate();
  const prorataDays = daysInMonth - startDay + 1;

  // Last day of start month
  const periodEnd = new Date(Date.UTC(startYear, startMonth + 1, 0)).toISOString().slice(0, 10);

  // Pro-rata amounts
  const monthlySubtotal = Number(contract.subtotal);
  const prorataSubtotal = Math.round((monthlySubtotal / daysInMonth) * prorataDays * 100) / 100;
  const taxPercentage = Number(contract.tax_percentage || 18);
  const taxAmount = Math.round(prorataSubtotal * (taxPercentage / 100) * 100) / 100;
  const totalAmount = prorataSubtotal + taxAmount;

  // GST split: intrastate if buyer GSTIN starts with "33" (Tamil Nadu)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const buyerGstin = lead?.gst_number || null;
  const isInterstate = !buyerGstin || !String(buyerGstin).startsWith("33");
  const halfTax = Math.round(taxAmount / 2 * 100) / 100;
  const cgstAmount = isInterstate ? 0 : halfTax;
  const sgstAmount = isInterstate ? 0 : taxAmount - halfTax;
  const igstAmount = isInterstate ? taxAmount : 0;

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthLabel = monthNames[startMonth];

  const lineItems = [
    {
      type: "rent",
      label: "Pro-Rata Workspace Fee",
      items: [
        {
          description: `Pro-Rata Workspace Fee (${monthLabel} ${startDay}–${daysInMonth})`,
          quantity: 1,
          unit: "month",
          unit_price: prorataSubtotal,
          amount: prorataSubtotal,
        },
      ],
      subtotal: prorataSubtotal,
    },
  ];

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  let statementId = contract.prorata_billing_statement_id as string | null;

  // Create statement if it doesn't exist yet
  if (!statementId) {
    const { data: newStatement, error: stmtErr } = await admin
      .from("billing_statements")
      .insert({
        contract_id: id,
        lead_id: contract.lead_id,
        period_start: contract.start_date,
        period_end: periodEnd,
        due_date: dueDateStr,
        statement_type: "rent",
        fixed_amount: prorataSubtotal,
        usage_amount: 0,
        service_usage_amount: 0,
        booking_usage_amount: 0,
        subtotal: prorataSubtotal,
        tax_percentage: taxPercentage,
        tax_amount: taxAmount,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        igst_amount: igstAmount,
        is_interstate: isInterstate,
        buyer_gstin: buyerGstin,
        place_of_supply: lead?.state || null,
        total_amount: totalAmount,
        line_items: lineItems,
        prepaid_month: startMonth + 1,
        prepaid_year: startYear,
        status: "finalized",
      })
      .select("id")
      .single();

    if (stmtErr || !newStatement) {
      return NextResponse.json({ error: stmtErr?.message || "Failed to create billing statement" }, { status: 500 });
    }

    statementId = newStatement.id;

    await admin
      .from("contracts")
      .update({ prorata_billing_statement_id: statementId })
      .eq("id", id);
  }

  const mode = body.mode === "gst_direct" ? "gst_direct" : "proforma";
  const additionalCc: string[] = Array.isArray(body.cc)
    ? body.cc.filter((e: unknown) => typeof e === "string" && (e as string).includes("@"))
    : [];

  const result = mode === "gst_direct"
    ? await dispatchGstDirect(admin, statementId!, dbUser.id, additionalCc)
    : await dispatchProforma(admin, statementId!, dbUser.id, additionalCc);

  if (!result.success && !result.emailSkipped && !result.routedToTally) {
    return NextResponse.json({ error: result.error || "Failed to dispatch" }, { status: 500 });
  }

  logAudit(admin, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      prorata_pi_sent: { old: null, new: true },
      prorata_billing_statement_id: { old: null, new: statementId },
      prorata_amount: { old: null, new: totalAmount },
    },
  });

  return NextResponse.json({
    success: true,
    mode,
    statementId,
    totalAmount,
    prorataDays,
    periodStart: contract.start_date,
    periodEnd,
    razorpayLinkUrl: result.razorpayLinkUrl,
    emailedTo: result.emailedTo,
    emailSkipped: result.emailSkipped,
    noContact: result.noContact,
    routedToTally: result.routedToTally,
  });
}
