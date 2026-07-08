import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createProposalSchema } from "@/lib/validations";
import { autoUpdateLeadStatus } from "@/lib/auto-status";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const status = searchParams.get("status");
  const leadId = searchParams.get("lead_id");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("proposals")
    .select("*, lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company), location:locations!proposals_location_id_fkey(id, name, code, proposal_amenity_icons)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (leadId) query = query.eq("lead_id", leadId);
  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Latest PI billing_statements row per proposal (for the flow-status badge).
  // One extra round-trip, reduced to "most recent per proposal_id" in JS —
  // same pattern as the paid-amount aggregation in receivables/route.ts.
  const proposalIds = (data || []).map((p) => p.id as string);
  const latestByProposal = new Map<string, { handoff_state: string | null; payment_status: string }>();
  if (proposalIds.length > 0) {
    const { data: statements } = await supabase
      .from("billing_statements")
      .select("proposal_id, handoff_state, payment_status, created_at")
      .in("proposal_id", proposalIds)
      .order("created_at", { ascending: false });
    for (const s of statements || []) {
      const pid = s.proposal_id as string;
      if (!latestByProposal.has(pid)) {
        latestByProposal.set(pid, { handoff_state: s.handoff_state as string | null, payment_status: s.payment_status as string });
      }
    }
  }

  const enriched = (data || []).map((p) => ({
    ...p,
    latest_billing_statement: latestByProposal.get(p.id as string) ?? null,
  }));

  return NextResponse.json({
    data: enriched,
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createProposalSchema.safeParse(body);
  if (!result.success) {
    const fieldErrors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Calculate totals
  const items = result.data.items;
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * (result.data.tax_percentage / 100);
  const discountAmount = subtotal * (result.data.discount_percentage / 100);
  const totalAmount = subtotal + taxAmount - discountAmount;

  // Generate proposal number
  const { count } = await supabase.from("proposals").select("*", { count: "exact", head: true });
  const proposalNumber = `PROP-${String((count || 0) + 1).padStart(4, "0")}`;

  const depositMonths = result.data.security_deposit_months || 0;
  const depositAmount = result.data.security_deposit_amount ?? (depositMonths * subtotal);
  const depositPaymentStatus = depositMonths > 0 ? "pending" : "not_required";

  const { service_quotas, ...proposalFields } = result.data;

  const { data, error } = await supabase
    .from("proposals")
    .insert({
      ...proposalFields,
      proposal_number: proposalNumber,
      status: "draft",
      subtotal,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      security_deposit_months: depositMonths,
      security_deposit_amount: depositAmount,
      deposit_payment_status: depositPaymentStatus,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "proposal",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  // Persist service quotas from the proposal form into proposal_service_quotas
  if (data && service_quotas && service_quotas.length > 0) {
    try {
      const quotaRows = service_quotas.map(q => ({
        proposal_id: data.id,
        service_id: q.service_id,
        monthly_quota: q.monthly_quota,
        overage_rate: q.overage_rate,
      }));
      await supabase.from("proposal_service_quotas").insert(quotaRows);
    } catch (err) {
      console.error("[proposals] Failed to insert proposal_service_quotas:", err);
    }
  }

  // Auto-advance lead status → proposal_sent
  if (result.data.lead_id) {
    await autoUpdateLeadStatus(supabase, result.data.lead_id, "proposal");
  }

  return NextResponse.json({ data }, { status: 201 });
}
