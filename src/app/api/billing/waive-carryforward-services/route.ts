import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing/waive-carryforward-services
 *
 * Marks service_usage_records as billed (clearing them from the
 * carry-forward pending list) without linking them to a statement.
 * Admin / manager only.
 *
 * Body: { service_record_ids: string[] }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager access required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { service_record_ids?: string[] };
  const ids = Array.isArray(body.service_record_ids) ? body.service_record_ids.filter(Boolean) : [];
  if (ids.length === 0) return NextResponse.json({ error: "service_record_ids is required" }, { status: 400 });

  const admin = createAdminClient();

  const { error } = await admin
    .from("service_usage_records")
    .update({
      is_billed: true,
      notes: "[WAIVED — carry-forward cleared by admin]",
    })
    .in("id", ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "service_usage_record",
    entityId: ids[0],
    action: "update",
    performedBy: dbUser.id,
    changes: { is_billed: { old: false, new: true }, waive_reason: { old: null, new: "carry-forward cleared" } },
  });

  return NextResponse.json({ ok: true, waived: ids.length });
}
