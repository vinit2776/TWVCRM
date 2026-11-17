import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_MANAGE_ROLES, ENERGY_ALERT_VIEW_ROLES, ruleCreateSchema } from "@/lib/energy-alerts/schema";
import { loadMode } from "@/lib/energy-alerts/evaluate";

/** GET: every rule with its location, last-7-days email count and open-episode flag, plus the
 *  locations a rule can be made for and the global mode. POST: create (always starts in test mode unless told). */
export async function GET() {
  const auth = await requireRole(ENERGY_ALERT_VIEW_ROLES);
  if ("error" in auth) return auth.error;
  const { admin } = auth;

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [rules, locations, open, events, mode] = await Promise.all([
    admin.from("energy_alert_rules").select("*, location:locations(name)").order("created_at", { ascending: false }),
    admin.from("location_electricity_config").select("location_id, onegrid_default_device_id, location:locations(name)").eq("onegrid_enabled", true),
    admin.from("energy_alert_episodes").select("rule_id").eq("status", "open"),
    admin.from("energy_alert_events").select("rule_id, status").in("status", ["sent", "test"]).gte("slot_ts", weekAgo),
    loadMode(admin),
  ]);
  const err = rules.error ?? locations.error ?? open.error ?? events.error;
  if (err) {
    console.error("[api/energy-alerts/rules] read failed:", err.message);
    return NextResponse.json({ error: "Failed to load energy alert rules" }, { status: 500 });
  }
  const openSet = new Set((open.data ?? []).map((e) => e.rule_id as string));
  const counts = new Map<string, number>();
  for (const e of events.data ?? []) counts.set(e.rule_id as string, (counts.get(e.rule_id as string) ?? 0) + 1);
  return NextResponse.json({
    mode,
    canManage: (ENERGY_ALERT_MANAGE_ROLES as readonly string[]).includes(auth.role),
    isAdmin: auth.role === "admin",
    locations: (locations.data ?? []).map((c) => {
      const l = c.location as { name: string } | { name: string }[] | null;
      return { id: c.location_id as string, name: (Array.isArray(l) ? l[0]?.name : l?.name) ?? "Location", onegrid_default_device_id: c.onegrid_default_device_id as string | null };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    rules: (rules.data ?? []).map((r) => ({ ...r, emails_7d: counts.get(r.id as string) ?? 0, has_open_episode: openSet.has(r.id as string) })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = ruleCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data, error } = await auth.admin.from("energy_alert_rules").insert({ ...parsed.data, created_by: auth.userId }).select("*").single();
  if (error) {
    console.error("[api/energy-alerts/rules] create failed:", error.message);
    return NextResponse.json({ error: "Could not create the rule" }, { status: 500 });
  }
  await logAudit(auth.admin, { entityType: "energy_alert_rule", entityId: data.id, action: "create", performedBy: auth.userId, changes: { name: { old: null, new: data.name }, mode: { old: null, new: data.mode } } });
  return NextResponse.json({ data }, { status: 201 });
}
