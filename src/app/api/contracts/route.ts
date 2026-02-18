import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createContractSchema } from "@/lib/validations";
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
  const search = searchParams.get("search");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("contracts")
    .select("*, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email), location:locations!contracts_location_id_fkey(id, name, code)", { count: "exact" });

  if (status) query = query.eq("status", status);
  if (leadId) query = query.eq("lead_id", leadId);
  if (search) query = query.or(`contract_number.ilike.%${search}%,title.ilike.%${search}%`);
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
  const result = createContractSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  // Fetch the proposal — must exist and be accepted
  const { data: proposal, error: proposalError } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", result.data.proposal_id)
    .single();

  if (proposalError || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  if (proposal.status !== "accepted") {
    return NextResponse.json({ error: "Proposal must be accepted before creating a contract" }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Calculate end_date from start_date + tenure_months
  const startDate = new Date(result.data.start_date);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + result.data.tenure_months);

  // Calculate next_billing_date based on billing_cycle
  const nextBillingDate = new Date(startDate);
  switch (result.data.billing_cycle) {
    case "monthly":
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      break;
    case "quarterly":
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 3);
      break;
    case "half_yearly":
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 6);
      break;
    case "yearly":
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 12);
      break;
  }

  const { data, error } = await supabase
    .from("contracts")
    .insert({
      lead_id: proposal.lead_id,
      proposal_id: result.data.proposal_id,
      title: proposal.title,
      status: "draft",
      items: proposal.items,
      subtotal: proposal.subtotal,
      tax_percentage: proposal.tax_percentage,
      tax_amount: proposal.tax_amount,
      discount_percentage: proposal.discount_percentage,
      discount_amount: proposal.discount_amount,
      total_amount: proposal.total_amount,
      billing_cycle: result.data.billing_cycle,
      tenure_months: result.data.tenure_months,
      start_date: result.data.start_date,
      end_date: endDate.toISOString().split("T")[0],
      next_billing_date: nextBillingDate.toISOString().split("T")[0],
      seats: result.data.seats,
      terms_and_conditions: result.data.terms_and_conditions,
      notes: result.data.notes,
      location_id: result.data.location_id || proposal.location_id || null,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "contract",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}
