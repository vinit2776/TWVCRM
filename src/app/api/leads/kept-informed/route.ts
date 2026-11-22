import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { daysLeft } from "@/lib/lead-loopin";

// GET /api/leads/kept-informed
// What colleagues asked the signed-in person to keep an eye on: not answered, not yet cleared.
// Soonest to clear first. Read-only. Empty when the switch is off.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) return NextResponse.json({ enabled: false, rows: [] });
  const { data: flag } = await createAdminClient().from("app_settings").select("value").eq("key", "lead_loopin_enabled").maybeSingle();
  if (flag?.value !== "true") return NextResponse.json({ enabled: false, rows: [] });

  const { data, error } = await supabase
    .from("lead_watchers")
    .select("id, lead_id, reason, expires_at, adder:users!lead_watchers_added_by_fkey(full_name), lead:leads!lead_watchers_lead_id_fkey(first_name, last_name, company)")
    .eq("user_id", me.id)
    .is("answer", null)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(100);
  if (error) {
    console.error("[kept-informed] load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load the list" }, { status: 500 });
  }
  type Row = { id: string; lead_id: string; reason: string; expires_at: string; adder: { full_name: string } | null; lead: { first_name: string; last_name: string | null; company: string | null } | null };
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    name: r.lead?.company || `${r.lead?.first_name ?? ""} ${r.lead?.last_name === "-" ? "" : (r.lead?.last_name ?? "")}`.trim() || "Unknown",
    addedBy: r.adder?.full_name ?? null,
    reason: r.reason,
    daysLeft: daysLeft(r.expires_at),
  }));
  return NextResponse.json({ enabled: true, rows });
}
