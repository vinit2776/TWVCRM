import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const upsertSchema = z.object({
  enabled: z.boolean(),
  service_number: z.string().nullable(),
  landlord_vendor_id: z.string().uuid().nullable(),
  landlord_utility_rate: z.number().min(0),
  landlord_utility_pct: z.number().min(0).max(100),
  landlord_generator_pct: z.number().min(0).max(100),
  landlord_generator_rate: z.number().min(0),
  bill_due_day_of_month: z.number().int().min(1).max(28),
  landlord_gst_applicable: z.boolean(),
  landlord_gst_rate: z.number().min(0).nullable(),
  tds_section: z.string().nullable(),
  tds_rate: z.number().min(0).nullable(),
}).refine(
  (d) => Math.abs(d.landlord_utility_pct + d.landlord_generator_pct - 100) < 0.01,
  { message: "Landlord split percentages must sum to 100", path: ["landlord_generator_pct"] }
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: config, error } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Fetch allocation summary: sum of ratios per contract mapped to this location
  const { data: contractConfigs } = await supabase
    .from("contract_electricity_config")
    .select("utility_ratio, generator_ratio, enabled, contract_id, contracts(status)")
    .eq("location_id", id)
    .eq("enabled", true);

  const enabledConfigs = (contractConfigs ?? []).filter(
    (c) => c.enabled && ["active", "renewal_in_progress"].includes((c.contracts as unknown as { status: string } | null)?.status ?? "")
  );

  const utilityAllocated = enabledConfigs.reduce((s, c) => s + (c.utility_ratio ?? 0), 0);
  const generatorAllocated = enabledConfigs.reduce((s, c) => s + (c.generator_ratio ?? 0), 0);

  return NextResponse.json({
    data: config,
    allocation: {
      utility_allocated: utilityAllocated,
      generator_allocated: generatorAllocated,
      contract_count: enabledConfigs.length,
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

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
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { data: existing } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  const { data, error } = await supabase
    .from("location_electricity_config")
    .upsert({ location_id: id, ...parsed.data }, { onConflict: "location_id" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "location_electricity_config",
    entityId: data.id,
    action: existing ? "update" : "create",
    performedBy: dbUser.id,
    changes: existing
      ? Object.fromEntries(
          Object.entries(parsed.data)
            .filter(([k, v]) => (existing as Record<string, unknown>)[k] !== v)
            .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }])
        )
      : { location_id: { old: null, new: id } },
  });

  return NextResponse.json({ data });
}
