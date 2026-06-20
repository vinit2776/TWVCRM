import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const ADMIN_ROLES = ["admin", "manager"] as const;

const updateSchema = z.object({
  is_billable: z.boolean().optional(),
  contract_id: z.string().uuid().nullable().optional(),
  service_charge_pct: z.number().min(0).max(100).optional(),
  notes: z.string().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  // Fetch current to validate billable+contract_id constraint
  const { data: current } = await supabase
    .from("transfer_billing_policies")
    .select("is_billable, contract_id")
    .eq("id", id)
    .single();

  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const willBeBillable = parsed.data.is_billable ?? current.is_billable;
  const willHaveContract = parsed.data.contract_id !== undefined
    ? parsed.data.contract_id
    : current.contract_id;

  if (willBeBillable && !willHaveContract) {
    return NextResponse.json({ error: "contract_id is required when is_billable is true" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("transfer_billing_policies")
    .update(parsed.data)
    .eq("id", id)
    .select("id, location_id, is_billable, service_charge_pct")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "transfer_billing_policy",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(
      Object.entries(parsed.data).map(([k, v]) => [k, { old: null, new: v }])
    ),
  });

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admins can delete billing policies" }, { status: 403 });
  }

  const { error } = await supabase.from("transfer_billing_policies").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "transfer_billing_policy",
    entityId: id,
    action: "delete",
    performedBy: dbUser.id,
    changes: {},
  });

  return NextResponse.json({ data: { id } });
}
