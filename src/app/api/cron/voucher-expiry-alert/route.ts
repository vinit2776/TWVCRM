import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";
import { isContractOperational } from "@/lib/constants";
import { VOUCHER_RENEWAL_WINDOW_DAYS, voucherDaysRemaining } from "@/lib/voucher-validity";

const NOTIFY_TYPE = "voucher_expiry";
const URGENT_DAYS = 7;

/**
 * GET /api/cron/voucher-expiry-alert
 *
 * Daily. A UniFi voucher is capped at one year (voucher-validity.ts), so on a
 * longer contract it stops working before the contract does. This tells staff
 * VOUCHER_RENEWAL_WINDOW_DAYS ahead (and again inside the last week) so they
 * can click Replace on the contract's Vouchers card and the member gets a new code.
 *
 * Staff-only: in-app notification + push. It never revokes, issues or emails
 * anything — replacing a code members are using is a person's click. One alert
 * per contract per tier; dedupe is the existing notifications row (type
 * voucher_expiry, entity_id = contract, same title), so no schema change. A
 * contract whose vouchers all end on or after the contract itself is skipped:
 * that expiry is the contract ending, not a gap to fill.
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

  const horizon = new Date(Date.now() + VOUCHER_RENEWAL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  const { data: rows, error } = await admin
    .from("voucher_issuances")
    .select("contract_id, seat_number, valid_until, contract:contracts!voucher_issuances_contract_id_fkey(id, contract_number, status, end_date, lead:leads!contracts_lead_id_fkey(first_name, last_name, company))")
    .eq("is_active", true)
    .not("unifi_voucher_id", "is", null)
    .lte("valid_until", horizon);
  if (error) {
    console.error("[voucher-expiry-alert] query failed:", error.message);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  type Contract = {
    id: string;
    contract_number: string;
    status: string;
    end_date: string;
    lead: { first_name: string | null; last_name: string | null; company: string | null } | null;
  };
  const byContract = new Map<string, { contract: Contract; earliest: string; seats: number }>();
  for (const r of rows ?? []) {
    const contract = (Array.isArray(r.contract) ? r.contract[0] : r.contract) as unknown as Contract | null;
    if (!contract || !isContractOperational(contract)) continue;
    // Contract ends before (or with) the voucher: nothing to renew.
    if (contract.end_date <= (r.valid_until as string)) continue;
    const entry = byContract.get(contract.id);
    if (!entry) byContract.set(contract.id, { contract, earliest: r.valid_until as string, seats: 1 });
    else {
      entry.seats += 1;
      if ((r.valid_until as string) < entry.earliest) entry.earliest = r.valid_until as string;
    }
  }
  if (byContract.size === 0) return NextResponse.json({ contracts: 0, notified: 0 });

  const { data: users } = await admin
    .from("users")
    .select("id")
    .in("role", ["admin", "manager", "sales_rep"])
    .eq("is_active", true);
  const userIds = (users ?? []).map((u) => u.id as string);
  if (userIds.length === 0) return NextResponse.json({ skipped: "No active admin/manager/sales users" });

  const { data: existing } = await admin
    .from("notifications")
    .select("entity_id, title")
    .eq("type", NOTIFY_TYPE)
    .in("entity_id", [...byContract.keys()]);
  const alerted = new Set((existing ?? []).map((n) => `${n.entity_id}|${n.title}`));

  const fresh = [...byContract.values()]
    .map(({ contract, earliest, seats }) => {
      const days = voucherDaysRemaining(earliest);
      const urgent = days <= URGENT_DAYS;
      const title = days < 0
        ? `Wi-Fi voucher expired: ${contract.contract_number}`
        : `${urgent ? "Wi-Fi voucher expires this week" : "Wi-Fi voucher expiring soon"}: ${contract.contract_number} — ${earliest}`;
      const lead = contract.lead;
      const customer = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Customer";
      const when = days < 0 ? `expired ${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`;
      return {
        contract,
        title,
        body: `${customer} · ${seats} seat${seats > 1 ? "s" : ""}, earliest ${when}, but the contract runs to ${contract.end_date}. Open the contract's Vouchers card and click Replace on each seat so members get a fresh code.`,
      };
    })
    .filter(({ contract, title }) => !alerted.has(`${contract.id}|${title}`));

  if (dry) {
    return NextResponse.json({ dry: true, contracts: byContract.size, wouldNotify: fresh.map((f) => f.title) });
  }

  for (const { contract, title, body } of fresh) {
    await createNotificationsForUsers(userIds, {
      type: NOTIFY_TYPE,
      title,
      body,
      url: `/contracts/${contract.id}`,
      entityType: "contract",
      entityId: contract.id,
    });
  }

  if (fresh.length > 0) {
    const names = fresh.slice(0, 3).map((f) => f.contract.contract_number).join(", ");
    await sendPushToUsers(userIds, {
      title: `${fresh.length} contract${fresh.length > 1 ? "s" : ""} need Wi-Fi vouchers renewed`,
      body: `${names}${fresh.length > 3 ? ` +${fresh.length - 3} more` : ""} — open the contract's Vouchers card`,
      url: "/contracts",
      tag: `voucher-expiry-alert-${new Date().toISOString().slice(0, 10)}`,
    }).catch((err) => console.error("[voucher-expiry-alert] push failed:", err));
  }

  return NextResponse.json({ contracts: byContract.size, notified: fresh.length });
}

export const GET = withCronHealth("cron/voucher-expiry-alert", handler);
