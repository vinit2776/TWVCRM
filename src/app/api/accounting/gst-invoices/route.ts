import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// GET — List GST invoice status for all contracts in a period
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd = new Date(year, month, 0).toISOString().split("T")[0];

  // Get accounting period
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("year", year)
    .eq("month", month)
    .single();

  // Get active contracts
  const { data: contracts } = await supabase
    .from("contracts")
    .select(
      "id, contract_number, title, status, start_date, total_amount, tenure_months, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, secondary_email, phone, mobile)"
    )
    .lte("start_date", periodEnd)
    .in("status", ["active", "completed"]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeContracts = (contracts || []).filter((c: any) => {
    const startDate = new Date(c.start_date);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + c.tenure_months);
    return endDate.toISOString().split("T")[0] >= periodStart;
  });

  // Get contract payments with GST info for this period
  const contractIds = activeContracts.map((c) => c.id);
  const { data: payments } = contractIds.length > 0 && period
    ? await supabase
        .from("contract_payments")
        .select("id, contract_id, amount, gst_invoice_number, gst_invoice_path, gst_invoice_status, gst_invoice_sent_at, gst_invoice_sent_to, status")
        .eq("accounting_period_id", period.id)
        .in("contract_id", contractIds)
    : { data: [] };

  // Group payments by contract_id once (O(n+m)) instead of scanning per contract (O(n×m))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentsByContract = new Map<string, any[]>();
  (payments || []).forEach((p) => {
    const list = paymentsByContract.get(p.contract_id) ?? [];
    list.push(p);
    paymentsByContract.set(p.contract_id, list);
  });

  // Build per-contract GST status
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = activeContracts.map((contract: any) => {
    const contractPayments = paymentsByContract.get(contract.id) ?? [];
    const totalBillable = Number(contract.total_amount);
    const totalPaid = contractPayments
      .filter((p) => p.status === "verified")
      .reduce((s, p) => s + Number(p.amount), 0);

    // Find the "primary" payment that has GST info (first one with invoice data)
    const gstPayment = contractPayments.find((p) => p.gst_invoice_number || p.gst_invoice_path);

    return {
      contract_id: contract.id,
      contract_number: contract.contract_number,
      company: contract.lead?.company || `${contract.lead?.first_name} ${contract.lead?.last_name}`,
      lead_email: contract.lead?.email,
      lead_secondary_email: contract.lead?.secondary_email,
      lead_phone: contract.lead?.phone || contract.lead?.mobile || null,
      total_billable: totalBillable,
      total_paid: totalPaid,
      payment_id: gstPayment?.id || contractPayments[0]?.id || null,
      gst_invoice_number: gstPayment?.gst_invoice_number || null,
      gst_invoice_path: gstPayment?.gst_invoice_path || null,
      gst_invoice_status: gstPayment?.gst_invoice_status || null,
      gst_invoice_sent_at: gstPayment?.gst_invoice_sent_at || null,
      gst_invoice_sent_to: gstPayment?.gst_invoice_sent_to || null,
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
