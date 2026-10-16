import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";
import { listOpenJourneys } from "@/lib/journey/open-journeys";
import { OWNER_ROLES } from "@/lib/journey/roles";
import type { JourneyOwner } from "@/lib/journey/types";

const NOTIFY_TYPE = "journey_step";
// Only these owners are alerted. Everyone else sees their steps on the
// dashboard widget; extend this list deliberately, it is a noise decision.
const ALERT_OWNERS: JourneyOwner[] = ["it"];
// Don't alert on setup that has been open for a long time (e.g. the first run
// after deploy would otherwise flood IT with every historical contract).
const MAX_AGE_DAYS = 30;

/**
 * GET /api/cron/journey-nudge
 *
 * Daily. Tells the owning staff role when a customer-journey step they can act
 * on has appeared, e.g. IT: a contract went live and needs WiFi vouchers or
 * door access. Staff-only: in-app notification + push. It never contacts a
 * customer.
 *
 * Each (contract, step) alerts once; dedupe is the existing notifications row
 * (type journey_step, entity_id = contract, same title), so no schema change.
 *
 * SAFE BY DEFAULT: without ?send=1 it only reports what it would send. The
 * scheduled call in vercel.json passes ?send=1.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const send = request.nextUrl.searchParams.get("send") === "1";
  const admin = createAdminClient();

  const open = await listOpenJourneys(admin);
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;

  interface Alert {
    owner: JourneyOwner;
    contractId: string;
    title: string;
    body: string;
    url: string;
  }
  const candidates: Alert[] = [];
  for (const o of open) {
    // Alerts are per contract; a proposal-stage journey has no contract id.
    if (!o.contractId || !o.activatedAt || new Date(o.activatedAt).getTime() < cutoff) continue;
    for (const phase of o.journey.phases) {
      for (const s of phase.steps) {
        if (!ALERT_OWNERS.includes(s.owner) || !s.actionable) continue;
        candidates.push({
          owner: s.owner,
          contractId: o.contractId,
          title: `Setup needed: ${s.label} — ${o.ref}`,
          body: `${o.customer}${s.detail ? ` · ${s.detail}` : ""}. Open the contract to do it.`,
          url: s.href ?? `/contracts/${o.contractId}`,
        });
      }
    }
  }
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

  for (const owner of ALERT_OWNERS) {
    const batch = fresh.filter((f) => f.owner === owner);
    if (batch.length === 0) continue;
    const { data: users } = await admin
      .from("users")
      .select("id")
      .in("role", OWNER_ROLES[owner])
      .eq("is_active", true);
    const userIds = (users ?? []).map((u) => u.id as string);
    if (userIds.length === 0) continue;

    for (const f of batch) {
      await createNotificationsForUsers(userIds, {
        type: NOTIFY_TYPE,
        title: f.title,
        body: f.body,
        url: f.url,
        entityType: "contract",
        entityId: f.contractId,
      });
    }
    await sendPushToUsers(userIds, {
      title: `${batch.length} setup step${batch.length > 1 ? "s" : ""} waiting`,
      body: batch
        .slice(0, 2)
        .map((b) => b.title.replace("Setup needed: ", ""))
        .join("; ") + (batch.length > 2 ? ` +${batch.length - 2} more` : ""),
      url: "/dashboard",
      tag: `journey-nudge-${owner}-${new Date().toISOString().slice(0, 10)}`,
    }).catch((err) => console.error("[journey-nudge] push failed:", err));
  }

  return NextResponse.json({ send: true, candidates: candidates.length, notified: fresh.length });
}

export const GET = withCronHealth("cron/journey-nudge", handler);
