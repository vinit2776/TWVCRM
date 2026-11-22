import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";

const bodySchema = z.object({ action: z.enum(["keep", "close"]) });

// POST /api/leads/[id]/park/review { action: "keep" | "close" }
// The answer to "this enquiry has waited a long time": keep it waiting (the clock restarts) or close
// it as no response (the lead is marked lost, reason No response, and leaves Waiting). Nothing is
// sent to the customer.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admin, manager and sales roles can review a waiting enquiry" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Say keep or close" }, { status: 400 });

  const admin = createAdminClient();
  const { data: flag } = await admin.from("app_settings").select("value").eq("key", "space_waiting_enabled").maybeSingle();
  if (flag?.value !== "true") return NextResponse.json({ error: "Waiting for space is not switched on yet" }, { status: 409 });

  const now = new Date().toISOString();
  if (parsed.data.action === "keep") {
    const { data } = await admin.from("parked_enquiries").update({ last_reviewed_at: now, review_notified_at: null }).eq("lead_id", id).neq("state", "released").select("id");
    if (!data || data.length === 0) return NextResponse.json({ error: "This enquiry is not waiting for space" }, { status: 409 });
    await supabase.from("activities").insert({ lead_id: id, type: "note", subject: "Waiting for space: reviewed", description: "Still waiting for space.", created_by: me.id });
    logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { space_review: { old: "due", new: "still waiting" } } });
    return NextResponse.json({ ok: true });
  }

  // Close: compare-and-set on the waiting row so two people cannot both do it.
  const { data: released } = await admin.from("parked_enquiries").update({ state: "released", released_by: me.id, released_at: now }).eq("lead_id", id).neq("state", "released").select("id");
  if (!released || released.length === 0) return NextResponse.json({ error: "Someone already took it out" }, { status: 409 });
  await admin.from("leads").update({ parked_at: null, status: "lost", lost_reason: "no_response", lost_at: now }).eq("id", id).not("status", "in", "(won,lost,junk)");
  try {
    await reconcileLeadEnquiries(admin, [id]);
  } catch (e) {
    console.error("[space review] enquiry reconcile failed:", e instanceof Error ? e.message : "unknown");
  }
  await supabase.from("activities").insert({ lead_id: id, type: "note", subject: "Waiting for space: closed", description: "Closed as no response after waiting for space.", created_by: me.id });
  logAudit(supabase, { entityType: "lead", entityId: id, action: "update", performedBy: me.id, changes: { status: { old: "waiting for space", new: "lost" }, lost_reason: { old: null, new: "no_response" } } });
  return NextResponse.json({ ok: true });
}
