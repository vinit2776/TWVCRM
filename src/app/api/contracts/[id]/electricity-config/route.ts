import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const upsertSchema = z.object({
  location_id: z.string().uuid(),
  enabled: z.boolean(),
  billing_profile_id: z.string().uuid().nullable(),
}).refine(
  (d) => !d.enabled || !!d.billing_profile_id,
  { message: "A billing profile is required when electricity billing is enabled", path: ["billing_profile_id"] },
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("contract_electricity_config")
    .select(`
      *,
      locations(id, name, code),
      billing_profile:electricity_billing_profiles(*)
    `)
    .eq("contract_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also return location config so UI can show landlord tariff for reference
  let locationConfig = null;
  if (data?.location_id) {
    const { data: lc } = await supabase
      .from("location_electricity_config")
      .select("service_number, landlord_utility_rate, landlord_generator_rate, enabled, landlord_utility_pct, landlord_generator_pct")
      .eq("location_id", data.location_id)
      .maybeSingle();
    locationConfig = lc;
  }

  return NextResponse.json({ data, locationConfig });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager role required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Verify the location has electricity enabled
  const { data: locConfig } = await supabase
    .from("location_electricity_config")
    .select("enabled")
    .eq("location_id", parsed.data.location_id)
    .maybeSingle();

  if (!locConfig?.enabled) {
    return NextResponse.json(
      { error: "Electricity billing is not enabled for the selected location. Enable it under Locations → Electricity tab first." },
      { status: 422 }
    );
  }

  if (parsed.data.billing_profile_id) {
    const { data: profile } = await supabase
      .from("electricity_billing_profiles")
      .select("id, is_active")
      .eq("id", parsed.data.billing_profile_id)
      .maybeSingle();
    if (!profile) {
      return NextResponse.json({ error: "Selected billing profile not found" }, { status: 422 });
    }
    if (!profile.is_active) {
      return NextResponse.json({ error: "Selected billing profile is inactive" }, { status: 422 });
    }
  }

  const { data: existing } = await supabase
    .from("contract_electricity_config")
    .select("*")
    .eq("contract_id", id)
    .maybeSingle();

  const { data, error } = await supabase
    .from("contract_electricity_config")
    .upsert({ contract_id: id, ...parsed.data }, { onConflict: "contract_id" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "electricity_bill",
    entityId: data.id,
    action: existing ? "update" : "create",
    performedBy: dbUser.id,
    changes: existing
      ? Object.fromEntries(
          Object.entries(parsed.data)
            .filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)
            .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }])
        )
      : { contract_id: { old: null, new: id } },
  });

  return NextResponse.json({ data });
}
