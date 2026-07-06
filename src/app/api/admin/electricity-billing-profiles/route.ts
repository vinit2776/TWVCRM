import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const ADMIN_ROLES = ["admin", "manager"] as const;

const upsertSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().nullish(),
  customer_utility_pct: z.number().min(0).max(100),
  customer_generator_pct: z.number().min(0).max(100),
  utility_markup_type: z.enum(["per_unit", "percent"]),
  utility_markup_value: z.number().min(0),
  generator_markup_type: z.enum(["per_unit", "percent"]),
  generator_markup_value: z.number().min(0),
  customer_gst_rate: z.number().min(0).max(28),
}).refine(
  (d) => Math.round((d.customer_utility_pct + d.customer_generator_pct) * 100) === 10000,
  { message: "Utility % and Generator % must add up to 100", path: ["customer_generator_pct"] },
);

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("electricity_billing_profiles")
    .select("*")
    .order("is_active", { ascending: false })
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("electricity_billing_profiles")
    .insert(parsed.data)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "electricity_billing_profile",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { name: { old: null, new: parsed.data.name } },
  });

  return NextResponse.json({ data }, { status: 201 });
}
