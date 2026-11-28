import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { withCronHealth } from "@/lib/cron-ping";
import { listOpenJourneys } from "@/lib/journey/open-journeys";
import { selectLateAlerts } from "@/lib/journey/late-alerts";
import { OWNER_ROLES } from "@/lib/journey/roles";

const NOTIFY_TYPE = "journey_step_late";

/**
 * GET /api/cron/journey-late
 *
 * Daily. Tells the owner of an onboarding step once, when it is past its due
 * date (contract activated + 2 days). Sales steps go to the lead's assigned rep
 * (falling back to the sales roles); other owners go to their roles. Staff-only
 * in-app notification: it never contacts a customer.
 *
 * Each (contract, step) alerts once; dedupe is the existing notifications row
 * (type journey_step_late, entity_id = contract, same title).
 *
 * SAFE BY DEFAULT: without ?send=1 it only reports what it would send.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const send = request.nextUrl.searchParams.get("send") === "1";
  const admin = createAdminClient();

  const candidates = selectLateAlerts(await listOpenJourneys(admin), new Date());
  if (candidates.length === 0) return NextResponse.json({ send, candidates: 0, notified: 0 });

  const { data: existing } = await admin
    .from("notifications")
    .select("entity_id, title")
    .eq("type", NOTIFY_TYPE)
    .in("entity_id", [...new Set(candidates.map((c) => c.contractId))]);
  const alerted = new Set((existing ?? []).map((n) => `${n.entity_id}|${n.title}`));
  const fresh = candidates.filter((c) => !alerted.has(`${c.contractId}|${c.title}`));

  if (!send) {
    return NextResponse.json({ send: false, candidates: candidates.length, wouldNotify: fresh.map((f) => `${f.owner}: ${f.title}`) });
  }

  const roleUsers = new Map<string, string[]>();
  const usersForOwner = async (owner: keyof typeof OWNER_ROLES): Promise<string[]> => {
    if (!roleUsers.has(owner)) {
      const { data } = await admin.from("users").select("id").in("role", OWNER_ROLES[owner]).eq("is_active", true);
      roleUsers.set(owner, (data ?? []).map((u) => u.id as string));
    }
    return roleUsers.get(owner) ?? [];
  };

  let notified = 0;
  for (const f of fresh) {
    const ids = f.owner === "sales" && f.assignedTo ? [f.assignedTo] : await usersForOwner(f.owner);
    if (ids.length === 0) continue;
    await createNotificationsForUsers(ids, {
      type: NOTIFY_TYPE,
      title: f.title,
      body: f.body,
      url: f.url,
      entityType: "contract",
      entityId: f.contractId,
    });
    notified++;
  }

  return NextResponse.json({ send: true, candidates: candidates.length, notified });
}

export const GET = withCronHealth("cron/journey-late", handler);
