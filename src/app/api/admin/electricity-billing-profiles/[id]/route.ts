import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const ADMIN_ROLES = ["admin", "manager"] as const;

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  customer_utility_pct: z.number().min(0).max(100).optional(),
  customer_generator_pct: z.number().min(0).max(100).optional(),
  utility_markup_type: z.enum(["per_unit", "percent"]).optional(),
  utility_markup_value: z.number().min(0).optional(),
  generator_markup_type: z.enum(["per_unit", "percent"]).optional(),
  generator_markup_value: z.number().min(0).optional(),
  customer_gst_rate: z.number().min(0).max(28).optional(),
  is_active: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { data: current } = await supabase
    .from("electricity_billing_profiles")
    .select("customer_utility_pct, customer_generator_pct")
    .eq("id", id)
    .single();

  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const willUtilityPct = parsed.data.customer_utility_pct ?? current.customer_utility_pct;
  const willGeneratorPct = parsed.data.customer_generator_pct ?? current.customer_generator_pct;
  if (Math.round((willUtilityPct + willGeneratorPct) * 100) !== 10000) {
    return NextResponse.json({ error: "Utility % and Generator % must add up to 100" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("electricity_billing_profiles")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "electricity_billing_profile",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(
      Object.entries(parsed.data).map(([k, v]) => [k, { old: null, new: v }]),
    ),
  });

  return NextResponse.json({ data });
}
