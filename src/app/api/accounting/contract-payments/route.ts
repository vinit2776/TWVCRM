import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createContractPaymentSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const contractId = searchParams.get("contract_id");
  const accountingPeriodId = searchParams.get("accounting_period_id");
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const offset = (page - 1) * limit;

  let query = supabase
    .from("contract_payments")
    .select(
      "*, contract:contracts!contract_payments_contract_id_fkey(id, contract_number, title, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, secondary_email)), creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)",
      { count: "exact" }
    );

  if (contractId) query = query.eq("contract_id", contractId);
  if (accountingPeriodId) query = query.eq("accounting_period_id", accountingPeriodId);
  if (status) query = query.eq("status", status);

  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    data,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createContractPaymentSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const input = result.data;

  // Build payment record
  const paymentRecord: Record<string, unknown> = {
    contract_id: input.contract_id,
    accounting_period_id: input.accounting_period_id || null,
    amount: input.amount,
    payment_mode: input.payment_mode,
    payment_reference: input.payment_reference || null,
    payment_date: input.payment_date,
    notes: input.notes || null,
    created_by: dbUser?.id,
  };

  // Auto-verify cash and card payments
  if (input.payment_mode === "cash" || input.payment_mode === "card") {
    paymentRecord.status = "verified";
  } else {
    paymentRecord.status = "pending";
  }

  // Cash handover tracking
  if (input.payment_mode === "cash") {
    paymentRecord.cash_handover_status = "pending_handover";
    paymentRecord.collected_by = dbUser?.id;
    paymentRecord.collected_at = new Date().toISOString();
  }

  const { data: payment, error: insertError } = await supabase
    .from("contract_payments")
    .insert(paymentRecord)
    .select("*, creator:users!contract_payments_created_by_fkey(id, full_name)")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (payment && dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract_payment",
      entityId: payment.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: payment } },
    });
  }

  return NextResponse.json({ data: payment }, { status: 201 });
}
