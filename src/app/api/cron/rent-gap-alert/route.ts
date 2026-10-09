import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getUnbilledQueue } from "@/lib/unbilled-queue";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";

const NOTIFY_TYPE = "rent_gap";

/**
 * GET /api/cron/rent-gap-alert
 *
 * Daily. Tells admin/manager/accounts/sales staff about rent months no billing run covered
 * and that can be raised from the Rent gap list (rows with a backfillTarget —
 * the same rule the contract page uses). A contract created after the
 * month-end run, or any other miss, otherwise sits unnoticed until someone
 * opens Billing → Unbilled.
 *
 * Staff-only: in-app notification + push. It never emails or invoices a
 * customer. Each (contract, month) alerts once — dedupe is the existing
 * notifications row (type rent_gap, entity_id = contract, same title), so no
 * schema change. Waived months drop out of the queue and stop alerting.
 *
 * ?dry=1 returns what would be sent without writing anything.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = request.nextUrl.searchParams.get("dry") === "1";
  const admin = createAdminClient();

  const { rows } = await getUnbilledQueue(admin);
  const gaps = rows.filter((r) => r.category === "rent_gap" && r.backfillTarget);
  if (gaps.length === 0) return NextResponse.json({ gaps: 0, notified: 0 });

  const { data: users } = await admin
    .from("users")
    .select("id")
    .in("role", ["admin", "manager", "accounts", "sales_rep"])
    .eq("is_active", true);
  const userIds = (users ?? []).map((u) => u.id as string);
  if (userIds.length === 0) return NextResponse.json({ skipped: "No active admin/manager/accounts/sales users" });

  const { data: existing } = await admin
    .from("notifications")
    .select("entity_id, title")
    .eq("type", NOTIFY_TYPE)
    .in("entity_id", [...new Set(gaps.map((g) => g.contractId))]);
  const alerted = new Set((existing ?? []).map((n) => `${n.entity_id}|${n.title}`));

  const fresh = gaps
    .map((g) => ({ g, title: `Rent not invoiced: ${g.contractNumber} — ${g.periodLabel.split(" · ")[0]}` }))
    .filter(({ g, title }) => !alerted.has(`${g.contractId}|${title}`));

  if (dry) {
    return NextResponse.json({ dry: true, gaps: gaps.length, wouldNotify: fresh.map((f) => f.title) });
  }

  for (const { g, title } of fresh) {
    await createNotificationsForUsers(userIds, {
      type: NOTIFY_TYPE,
      title,
      body: `${g.customerName}${g.detail ? ` · ${g.detail}` : ""}. Review it under Billing → Unbilled → Rent gap: raise the invoice, or waive the month if it was collected outside the CRM.`,
      url: `/contracts/${g.contractId}`,
      entityType: "contract",
      entityId: g.contractId,
    });
  }

  if (fresh.length > 0) {
    const names = fresh.slice(0, 3).map((f) => f.g.contractNumber).join(", ");
    await sendPushToUsers(userIds, {
      title: `${fresh.length} rent month${fresh.length > 1 ? "s" : ""} not invoiced`,
      body: `${names}${fresh.length > 3 ? ` +${fresh.length - 3} more` : ""} — check Billing → Unbilled`,
      url: "/billing",
      tag: `rent-gap-alert-${new Date().toISOString().slice(0, 10)}`,
    }).catch((err) => console.error("[rent-gap-alert] push failed:", err));
  }

  return NextResponse.json({ gaps: gaps.length, notified: fresh.length });
}

export const GET = withCronHealth("cron/rent-gap-alert", handler);
