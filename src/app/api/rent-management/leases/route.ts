import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";
import { zodErrorResponse } from "@/lib/validations";

const createLeaseSchema = z.object({
  location_id: z.string().uuid("Valid location required"),
  landlord_id: z.string().uuid().nullish(),
  lease_number: z.string().nullish(),
  registered_deed_number: z.string().nullish(),
  lease_start_date: z.string().min(1, "Start date required"),
  lease_end_date: z.string().min(1, "End date required"),
  lock_in_end_date: z.string().nullish(),
  base_rent_amount: z.number().positive("Rent amount must be positive"),
  security_deposit_amount: z.number().min(0).default(0),
  rent_due_day: z.number().int().min(1).max(28).default(1),
  advance_months: z.number().int().min(0).default(0),
  escalation_type: z.enum(["none", "percentage", "flat", "step_up"]).default("none"),
  escalation_value: z.number().nullish(),
  escalation_frequency: z.enum(["annual", "bi_annual", "custom"]).default("annual"),
  next_escalation_date: z.string().nullish(),
  tds_applicable: z.boolean().default(true),
  tds_section: z.enum(["194I", "194IB"]).default("194I"),
  tds_rate: z.number().min(0).max(100).default(10),
  notes: z.string().nullish(),
});

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !RENT_MANAGEMENT_ROLES.includes(dbUser.role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const locationId = searchParams.get("location_id");

  let query = supabase
    .from("property_leases")
    .select("*, location:locations(id, name, city), landlord:landlords(id, name, kyc_status)")
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (locationId) query = query.eq("location_id", locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createLeaseSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  if (parsed.data.lease_start_date >= parsed.data.lease_end_date)
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });

  const { data, error } = await supabase
    .from("property_leases")
    .insert({ ...parsed.data, created_by: dbUser.id })
    .select("*, location:locations(id, name), landlord:landlords(id, name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, { entityType: "property_lease", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}
