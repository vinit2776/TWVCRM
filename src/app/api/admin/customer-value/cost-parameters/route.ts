/**
 * /api/admin/customer-value/cost-parameters
 *
 * The rates behind the Customer Value cost simulator (docs/plans/customer-value-phase5-cost-simulator.md).
 * Admin only, both ways: it is cost data.
 *
 * GET   every stored row (an append-only history, small), newest first, with who set each one
 * POST  { scope, location_id?, lead_id?, key, value | null, effective_from }
 *       adds a row; it never edits one, so a changed rate cannot rewrite a past month.
 *       A null value clears the value from that date. Audit-logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { costParameterWriteSchema } from "@/lib/customer-value/cost-parameters";

const MAX_ROWS = 2000;

async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  return { supabase, userId: dbUser.id as string } as const;
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from("value_cost_parameters")
    .select("id, scope, location_id, lead_id, key, value, effective_from, created_at, set_by_user:users!value_cost_parameters_set_by_fkey(full_name)")
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) {
    console.error("[api/admin/cost-parameters] read failed:", error.message);
    return NextResponse.json({ error: "Failed to load cost parameters" }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = costParameterWriteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const p = parsed.data;

  // Writes use the service role: the table has no write policy on purpose.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("value_cost_parameters")
    .insert({
      scope: p.scope,
      location_id: p.scope === "location" ? p.location_id : null,
      lead_id: p.scope === "lead" ? p.lead_id : null,
      key: p.key,
      value: p.value,
      effective_from: p.effective_from,
      set_by: auth.userId,
    })
    .select("id, scope, location_id, lead_id, key, value, effective_from, created_at")
    .single();

  if (error) {
    // A center or customer id that does not exist.
    if (error.code === "23503") return NextResponse.json({ error: "That center or customer does not exist" }, { status: 400 });
    console.error("[api/admin/cost-parameters] write failed:", error.message);
    return NextResponse.json({ error: "Failed to save the cost parameter" }, { status: 500 });
  }

  await logAudit(admin, {
    entityType: "value_cost_parameter",
    entityId: data.id,
    action: "create",
    performedBy: auth.userId,
    changes: {
      key: { old: null, new: p.key },
      scope: { old: null, new: p.scope },
      value: { old: null, new: p.value },
      effective_from: { old: null, new: p.effective_from },
      ...(p.location_id ? { location_id: { old: null, new: p.location_id } } : {}),
      ...(p.lead_id ? { lead_id: { old: null, new: p.lead_id } } : {}),
    },
  });

  return NextResponse.json({ data }, { status: 201 });
}
