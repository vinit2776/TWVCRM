import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { parseAutoRenewTiming } from "@/lib/auto-renewal";
import { planAutoRenewals } from "@/lib/auto-renewal-plan";
import { loadAutoRenewFacts } from "@/lib/auto-renewal-plan-server";

const VIEW_ROLES = ["admin", "manager", "sales_rep", "accounts"];

/**
 * GET /api/auto-renewals: every contract with auto-renewal on, grouped the way the
 * daily report groups them. Read only; the same planner the job uses.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!me || !VIEW_ROLES.includes(me.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const [facts, settings] = await Promise.all([
    loadAutoRenewFacts(admin, today),
    getCachedSettings(admin, ["auto_renew_draft_lead_days", "auto_renew_notice_lead_days", "auto_renew_confirmation_days"]),
  ]);
  if (facts === null) return NextResponse.json({ data: null, unavailable: "Auto-renewal is not set up on this database yet." });

  const plan = planAutoRenewals(facts, today, parseAutoRenewTiming(settings));
  return NextResponse.json({
    data: {
      today,
      counts: {
        total: plan.items.length,
        held: plan.held.length,
        dueNow: plan.dueNow.length,
        onAutopilot: plan.items.length - plan.held.length,
      },
      rows: plan.items.map((i) => ({
        id: i.facts.id,
        contractNumber: i.facts.contractNumber,
        customer: i.facts.customer,
        location: i.facts.location,
        endDate: i.facts.endDate,
        rollOn: i.rollOn,
        stage: i.stage,
        holds: i.holds,
        next: i.next,
        nextRent: i.nextRent,
        nextRentPct: i.nextRentPct,
        programmedPct: i.programmedPct,
        nextRentIsDraft: i.nextRentIsDraft,
      })),
    },
  });
}
