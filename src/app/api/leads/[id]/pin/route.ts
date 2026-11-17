import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";

const bodySchema = z.object({ pinned: z.boolean() });

// POST /api/leads/[id]/pin   { pinned: true | false }
// Pins a lead so it stays highlighted in the Leads list and shown on every calendar day, whatever
// its follow-up date, until someone unpins it. One shared pin per lead. A pinned lead is never
// closed by the system: only a person unpins it or closes it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Validation failed" }, { status: 400 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only the sales team can pin a lead" }, { status: 403 });
  }

  const { data: lead } = await supabase.from("leads").select("id, pinned_at, archived_at").eq("id", id).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (lead.archived_at && parsed.data.pinned) {
    return NextResponse.json({ error: "An archived lead can't be pinned" }, { status: 409 });
  }

  const update = parsed.data.pinned
    ? { pinned_at: new Date().toISOString(), pinned_by: me.id }
    : { pinned_at: null, pinned_by: null };
  const { data, error } = await supabase.from("leads").update(update).eq("id", id).select("id, pinned_at, pinned_by").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "lead",
    entityId: id,
    action: "update",
    performedBy: me.id,
    changes: { pinned_at: { old: lead.pinned_at ?? null, new: update.pinned_at } },
  });

  return NextResponse.json({ data });
}
