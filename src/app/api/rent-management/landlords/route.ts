import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { RENT_MANAGEMENT_ROLES } from "@/lib/constants";

const createLandlordSchema = z.object({
  name: z.string().min(1, "Name is required"),
  contact_person: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal("")),
  phone: z.string().nullish(),
  pan_number: z.string().nullish(),
  gstin: z.string().nullish(),
  registered_address: z.string().nullish(),
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
  const search = searchParams.get("search") || "";

  let query = supabase
    .from("landlords")
    .select("*, bank_accounts:landlord_bank_accounts(*)")
    .order("name");

  if (search) {
    query = query.or(`name.ilike.%${search}%,contact_person.ilike.%${search}%,pan_number.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Attach active lease counts
  const landlordIds = (data || []).map((l) => l.id);
  const counts: Record<string, number> = {};
  if (landlordIds.length > 0) {
    const { data: leaseCounts } = await supabase
      .from("property_leases")
      .select("landlord_id")
      .in("landlord_id", landlordIds)
      .eq("status", "active");
    for (const row of leaseCounts || []) {
      counts[row.landlord_id] = (counts[row.landlord_id] || 0) + 1;
    }
  }

  const enriched = (data || []).map((l) => ({ ...l, active_lease_count: counts[l.id] || 0 }));
  return NextResponse.json({ data: enriched });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const parsed = createLandlordSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from("landlords")
    .insert({ ...parsed.data, created_by: dbUser.id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, { entityType: "landlord", entityId: data.id, action: "create", performedBy: dbUser.id });
  return NextResponse.json({ data }, { status: 201 });
}
