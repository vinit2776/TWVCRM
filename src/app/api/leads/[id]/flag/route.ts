import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";

const flagSchema = z.object({ reason: z.string().trim().min(3, "Say why in a few words").max(300) });

async function context(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return { error: NextResponse.json({ error: "Only admin, manager and sales roles can flag a lead" }, { status: 403 }) } as const;
  }
  const { data: lead } = await supabase.from("leads").select("id, flagged_at, flag_reason").eq("id", id).single();
  if (!lead) return { error: NextResponse.json({ error: "Lead not found" }, { status: 404 }) } as const;
  return { supabase, me, lead } as const;
}

// POST /api/leads/[id]/flag { reason }
// Mark a lead for attention. The reason is required; setting it again replaces the reason and who set it.
// Staff only: nothing is sent to the customer and no status changes.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, me, lead } = ctx;

  const parsed = flagSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Validation failed" }, { status: 400 });

  const now = new Date().toISOString();
  const { error } = await createAdminClient()
    .from("leads")
    .update({ flagged_at: now, flagged_by: me.id, flag_reason: parsed.data.reason })
    .eq("id", id);
  if (error) {
    console.error("[flag] update failed", error.code, error.message);
    return NextResponse.json({ error: "Could not flag it" }, { status: 500 });
  }
  logAudit(supabase, {
    entityType: "lead",
    entityId: id,
    action: "update",
    performedBy: me.id,
    changes: { flag: { old: lead.flagged_at ? lead.flag_reason : null, new: parsed.data.reason } },
  });
  return NextResponse.json({ data: { flagged_at: now, flag_reason: parsed.data.reason, flagger: { full_name: me.full_name } } }, { status: 201 });
}

// DELETE /api/leads/[id]/flag
// Clear the flag.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await context(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, me, lead } = ctx;
  if (!lead.flagged_at) return NextResponse.json({ error: "This lead is not flagged" }, { status: 409 });

  const { error } = await createAdminClient()
    .from("leads")
    .update({ flagged_at: null, flagged_by: null, flag_reason: null })
    .eq("id", id);
  if (error) {
    console.error("[flag] clear failed", error.code, error.message);
    return NextResponse.json({ error: "Could not clear the flag" }, { status: 500 });
  }
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { flag: { old: lead.flag_reason, new: null } } });
  return NextResponse.json({ data: { flagged_at: null } });
}
