import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const upsertSchema = z.object({
  enabled: z.boolean(),
  reimbursement_enabled: z.boolean(),
  landlord_vendor_id: z.string().uuid().nullable(),
  landlord_utility_pct: z.number().min(0).max(100),
  landlord_generator_pct: z.number().min(0).max(100),
  landlord_generator_rate: z.number().min(0),
  bill_due_day_of_month: z.number().int().min(1).max(28),
  landlord_gst_applicable: z.boolean(),
  landlord_gst_rate: z.number().min(0).nullable(),
  tds_section: z.string().nullable(),
  tds_rate: z.number().min(0).nullable(),
  customer_utility_pct: z.number().min(0).max(100),
  customer_generator_pct: z.number().min(0).max(100),
  markup_type: z.enum(["per_unit", "percent"]),
  markup_value: z.number().min(0),
  customer_generator_rate: z.number().min(0),
}).refine(
  (d) => Math.abs(d.landlord_utility_pct + d.landlord_generator_pct - 100) < 0.01,
  { message: "Landlord split percentages must sum to 100", path: ["landlord_generator_pct"] }
).refine(
  (d) => Math.abs(d.customer_utility_pct + d.customer_generator_pct - 100) < 0.01,
  { message: "Customer split percentages must sum to 100", path: ["customer_generator_pct"] }
);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("location_electricity_config")
    .select("*")
    .eq("location_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createAdminClient();
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

  // Fetch existing config for audit diff
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
