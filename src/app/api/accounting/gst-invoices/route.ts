import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// GET — List GST invoice status for all contracts in a period
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd = new Date(year, month, 0).toISOString().split("T")[0];

  // Get accounting period
  const { data: period } = await adminSupabase
    .from("accounting_periods")
    .select("id")
    .eq("year", year)
    .eq("month", month)
    .single();

  // Get active contracts
  const { data: contracts } = await adminSupabase
    .from("contracts")
    .select(
      "id, contract_number, title, status, start_date, total_amount, tenure_months, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, secondary_email, phone, mobile)"
    )
    .lte("start_date", periodEnd)
    .in("status", ["active", "renewal_in_progress"]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeContracts = (contracts || []).filter((c: any) => {
    const startDate = new Date(c.start_date);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + c.tenure_months);
    return endDate.toISOString().split("T")[0] >= periodStart;
  });

  // Get contract payments with GST info for this period
  const contractIds = activeContracts.map((c) => c.id);

  // Fetch contract_payments AND billing_statements in parallel —
  // GST invoice data may live on either table depending on how payment was recorded.
  const [paymentsResult, statementsResult] = await Promise.all([
    contractIds.length > 0 && period
      ? adminSupabase
          .from("contract_payments")
          .select("id, contract_id, amount, gst_invoice_number, gst_invoice_path, gst_invoice_status, gst_invoice_sent_at, gst_invoice_sent_to, status")
          .eq("accounting_period_id", period.id)
          .in("contract_id", contractIds)
      : Promise.resolve({ data: [] }),
    contractIds.length > 0
      ? adminSupabase
          .from("billing_statements")
          .select("id, contract_id, status, gst_invoice_number, gst_invoice_path, emailed_at, emailed_to")
          .in("contract_id", contractIds)
          .gte("period_start", periodStart)
          .lte("period_end", periodEnd)
          .neq("status", "voided")
      : Promise.resolve({ data: [] }),
  ]);

  const payments = paymentsResult.data || [];
  const statements = statementsResult.data || [];

  // Group by contract_id (O(n+m))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentsByContract = new Map<string, any[]>();
  payments.forEach((p) => {
    const list = paymentsByContract.get(p.contract_id) ?? [];
    list.push(p);
    paymentsByContract.set(p.contract_id, list);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statementByContract = new Map<string, any>();
  statements.forEach((s) => {
    // Prefer finalized/exported over draft; take first finalized if multiple
    const existing = statementByContract.get(s.contract_id);
    if (!existing || (existing.status === "draft" && s.status !== "draft")) {
      statementByContract.set(s.contract_id, s);
    }
  });

  // Build per-contract GST status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = activeContracts.map((contract: any) => {
    const contractPayments = paymentsByContract.get(contract.id) ?? [];
    const stmt = statementByContract.get(contract.id) ?? null;

    const totalBillable = Number(contract.total_amount);
    const totalPaid = contractPayments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);

    // GST invoice data: prefer billing_statement (system-generated PDF) over
    // contract_payment (legacy manual upload). Fall back to whichever has data.
    const gstPayment = contractPayments.find((p) => p.gst_invoice_number || p.gst_invoice_path);
    const stmtHasGst = !!(stmt?.gst_invoice_number || stmt?.gst_invoice_path);
    const payHasGst = !!gstPayment;

    // Which source holds the GST PDF?
    const gstSource: "statement" | "payment" | null =
      stmtHasGst ? "statement" : payHasGst ? "payment" : null;

    const gstInvoiceNumber = stmtHasGst
      ? stmt.gst_invoice_number
      : gstPayment?.gst_invoice_number || null;
    const gstInvoicePath = stmtHasGst
      ? stmt.gst_invoice_path
      : gstPayment?.gst_invoice_path || null;
    const gstInvoiceStatus = stmtHasGst
      ? (stmt.emailed_at ? "sent" : stmt.gst_invoice_number ? "invoiced" : null)
      : gstPayment?.gst_invoice_status || null;
    const gstInvoiceSentAt = stmtHasGst ? stmt.emailed_at : gstPayment?.gst_invoice_sent_at || null;
    const gstInvoiceSentTo = stmtHasGst ? stmt.emailed_to : gstPayment?.gst_invoice_sent_to || null;

    return {
      contract_id: contract.id,
      contract_number: contract.contract_number,
      company: contract.lead?.company || `${contract.lead?.first_name} ${contract.lead?.last_name}`,
      lead_email: contract.lead?.email,
      lead_secondary_email: contract.lead?.secondary_email,
      lead_phone: contract.lead?.phone || contract.lead?.mobile || null,
      total_billable: totalBillable,
      total_paid: totalPaid,
      // Payment-side fields (legacy upload flow)
      payment_id: gstPayment?.id || contractPayments[0]?.id || null,
      // Billing-statement fields (system generate flow)
      billing_statement_id: stmt?.id || null,
      billing_statement_status: stmt?.status || null,
      // Resolved GST invoice info (whichever source has it)
      gst_source: gstSource,
      gst_invoice_number: gstInvoiceNumber,
      gst_invoice_path: gstInvoicePath,
      gst_invoice_status: gstInvoiceStatus,
      gst_invoice_sent_at: gstInvoiceSentAt,
      gst_invoice_sent_to: gstInvoiceSentTo,
    };
  });

  return NextResponse.json({ data: entries });
}

// PATCH — Batch update GST invoice numbers (allowed when period is locked)
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await request.json();
  const { entries } = body as {
    entries: Array<{
      payment_id: string;
      gst_invoice_number: string;
    }>;
  };

  if (!entries || entries.length === 0) {
    return NextResponse.json({ error: "At least one entry is required" }, { status: 400 });
  }

  // Update all entries in parallel instead of sequentially
  const updateResults = await Promise.all(
    entries.map(async (entry) => {
      const { data: updated, error } = await supabase
        .from("contract_payments")
        .update({
          gst_invoice_number: entry.gst_invoice_number.trim(),
          gst_invoice_status: entry.gst_invoice_number.trim() ? "invoiced" : null,
        })
        .eq("id", entry.payment_id)
        .select("id, gst_invoice_number, gst_invoice_status")
        .single();

      if (!error && updated) {
        logAudit(supabase, {
          entityType: "contract_payment",
          entityId: entry.payment_id,
          action: "update",
          performedBy: dbUser.id,
          changes: { gst_invoice_number: { old: null, new: entry.gst_invoice_number.trim() } },
        });
        return updated;
      }
      return null;
    })
  );

  const results = updateResults.filter(Boolean);
  return NextResponse.json({ data: results, updated_count: results.length });
}
