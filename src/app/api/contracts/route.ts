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
    const fieldErrors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Validation failed: ${fieldErrors}`, details: result.error.issues }, { status: 400 });
  }

  const d = result.data;
  let title = d.workspace_description;
  let items = [{ description: d.workspace_description, quantity: d.seats, unit_price: d.monthly_membership_fee / d.seats, total: d.monthly_membership_fee }];
  let subtotal = d.monthly_membership_fee;
  let taxPercentage = 18;
  let taxAmount = subtotal * (taxPercentage / 100);
  let discountPercentage = 0;
  let discountAmount = 0;
  let totalAmount = d.monthly_membership_fee;
  let proposalLocationId: string | null = null;

  // If proposal provided, inherit financials from it
  if (d.proposal_id) {
    const { data: proposal, error: proposalError } = await supabase
      .from("proposals")
      .select("*")
      .eq("id", d.proposal_id)
      .single();

    if (proposalError || !proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    if (proposal.status !== "accepted") {
      return NextResponse.json({ error: "Proposal must be accepted before creating a contract" }, { status: 400 });
    }

    title = proposal.title;
    items = proposal.items;
    subtotal = proposal.subtotal;
    taxPercentage = proposal.tax_percentage;
    taxAmount = proposal.tax_amount;
    discountPercentage = proposal.discount_percentage;
    discountAmount = proposal.discount_amount;
    totalAmount = proposal.total_amount;
    proposalLocationId = proposal.location_id;
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Calculate end_date from start_date + tenure_months
  const startDate = new Date(d.start_date);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + d.tenure_months);

  // Calculate next_billing_date based on billing_cycle
  const nextBillingDate = new Date(startDate);
  switch (d.billing_cycle) {
    case "monthly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 1); break;
    case "quarterly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 3); break;
    case "half_yearly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 6); break;
    case "yearly": nextBillingDate.setMonth(nextBillingDate.getMonth() + 12); break;
  }

  const { data, error } = await supabase
    .from("contracts")
    .insert({
      lead_id: d.lead_id,
      proposal_id: d.proposal_id || null,
      title,
      status: "draft",
      items,
      subtotal,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      discount_percentage: discountPercentage,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      billing_cycle: d.billing_cycle,
      tenure_months: d.tenure_months,
      start_date: d.start_date,
      end_date: endDate.toISOString().split("T")[0],
      next_billing_date: nextBillingDate.toISOString().split("T")[0],
      seats: d.seats,
      terms_and_conditions: d.terms_and_conditions,
      notes: d.notes,
      location_id: d.location_id || proposalLocationId || null,
      // Membership agreement fields
      workspace_description: d.workspace_description,
      parking_space: d.parking_space,
      complimentary_services: d.complimentary_services,
      security_deposit_months: d.security_deposit_months,
      escalation_percentage: d.escalation_percentage,
      notice_period_months: d.notice_period_months,
      member_signatory_name: d.member_signatory_name,
      member_signatory_designation: d.member_signatory_designation,
      member_signatory_pan: d.member_signatory_pan ?? null,
      member_signatory_id_type: d.member_signatory_id_type ?? 'pan',
      agreement_date: d.agreement_date,
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
