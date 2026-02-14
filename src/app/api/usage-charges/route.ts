import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createUsageChargeSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const contractId = searchParams.get("contract_id");
  const leadId = searchParams.get("lead_id");
  const status = searchParams.get("status");
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");

  const offset = (page - 1) * limit;

  let query = supabase
    .from("usage_charges")
    .select(
      "*, contract:contracts!usage_charges_contract_id_fkey(id, contract_number), lead:leads!usage_charges_lead_id_fkey(id, first_name, last_name, company)",
      { count: "exact" }
    );

  if (contractId) query = query.eq("contract_id", contractId);
  if (leadId) query = query.eq("lead_id", leadId);
  if (status) query = query.eq("status", status);
  if (dateFrom) query = query.gte("charge_date", dateFrom);
  if (dateTo) query = query.lte("charge_date", dateTo);

  query = query.order("charge_date", { ascending: false }).range(offset, offset + limit - 1);

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
  const result = createUsageChargeSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  // Fetch contract — must exist and be active
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, lead_id, status")
    .eq("id", result.data.contract_id)
    .single();

  if (contractError || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  if (contract.status !== "active") {
    return NextResponse.json({ error: "Contract is not active" }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      ...result.data,
      lead_id: contract.lead_id,
      status: "pending",
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  return NextResponse.json({ data }, { status: 201 });
}
