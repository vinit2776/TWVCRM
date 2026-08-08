import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/validations";

const ADMIN_ROLES = ["admin", "manager"] as const;

const upsertSchema = z.object({
  location_id: z.string().uuid(),
  is_billable: z.boolean(),
  contract_id: z.string().uuid().nullable().optional(),
  service_charge_pct: z.number().min(0).max(100),
  notes: z.string().optional(),
}).refine(
  (d) => !d.is_billable || !!d.contract_id,
  { message: "contract_id is required when is_billable is true", path: ["contract_id"] }
);

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("transfer_billing_policies")
    .select(`
      id,
      location_id,
      is_billable,
      contract_id,
      service_charge_pct,
      notes,
      created_at,
      updated_at,
      location:locations!transfer_billing_policies_location_id_fkey(id, name),
      contract:contracts!transfer_billing_policies_contract_id_fkey(id, contract_number, status)
    `)
    .order("created_at", { ascending: false });

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
    return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  }

  const { data, error } = await supabase
    .from("transfer_billing_policies")
    .insert({ ...parsed.data, created_by: dbUser.id })
    .select("id, location_id, is_billable, service_charge_pct")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A policy already exists for this location. Use PATCH to update it." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "transfer_billing_policy",
    entityId: data.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { location_id: { old: null, new: parsed.data.location_id }, is_billable: { old: null, new: parsed.data.is_billable } },
  });

  return NextResponse.json({ data }, { status: 201 });
}
