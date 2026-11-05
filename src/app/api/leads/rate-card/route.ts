import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { WORKSPACE_TYPES } from "@/lib/constants";

// GET /api/leads/rate-card: our standard monthly price per seat, by workspace type and location.
// Used only to estimate what an enquiry could be worth when the customer gave no budget.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase.from("lead_rate_card").select("id, location_id, workspace_type, monthly_rate_per_seat");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

const putSchema = z.object({
  rates: z
    .array(
      z.object({
        location_id: z.string().uuid().nullable(),
        workspace_type: z.enum(WORKSPACE_TYPES),
        // null removes the row
        monthly_rate_per_seat: z.number().positive().max(10_000_000).nullable(),
      }),
    )
    .min(1)
    .max(200),
});

// PUT /api/leads/rate-card: admin or manager sets or clears rates.
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !["admin", "manager"].includes(me.role)) {
    return NextResponse.json({ error: "Only admin or manager can change the rate card" }, { status: 403 });
  }

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });

  const admin = createAdminClient();
  for (const r of parsed.data.rates) {
    // The unique index is on coalesce(location_id, ...), so match by hand instead of upsert.
    let find = admin.from("lead_rate_card").select("id").eq("workspace_type", r.workspace_type);
    find = r.location_id ? find.eq("location_id", r.location_id) : find.is("location_id", null);
    const { data: existing } = await find.maybeSingle();

    if (r.monthly_rate_per_seat === null) {
      if (existing) await admin.from("lead_rate_card").delete().eq("id", existing.id);
    } else if (existing) {
      const { error } = await admin
        .from("lead_rate_card")
        .update({ monthly_rate_per_seat: r.monthly_rate_per_seat, updated_by: me.id, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await admin.from("lead_rate_card").insert({
        location_id: r.location_id,
        workspace_type: r.workspace_type,
        monthly_rate_per_seat: r.monthly_rate_per_seat,
        updated_by: me.id,
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  logAudit(supabase, {
    entityType: "lead_rate_card",
    entityId: me.id,
    action: "update",
    performedBy: me.id,
    changes: { rates: { old: null, new: parsed.data.rates.length } },
  });
  return NextResponse.json({ ok: true });
}
