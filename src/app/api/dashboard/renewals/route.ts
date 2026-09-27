import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/renewals?location_id=<uuid>
 * Returns active contracts ending in the next 60 days, with revenue-at-risk
 * bucketed into 0–30d and 31–60d windows.
 *
 * Access: admin, manager, accounts.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const in60 = new Date(today);
  in60.setDate(in60.getDate() + 60);
  const in60Str = in60.toISOString().split("T")[0];

  const query = adminSupabase
    .from("contracts")
    .select(
      "id, contract_number, end_date, total_amount, billing_cycle, tenure_months, seats, renewal_declined, renewal_reminder_count, lead:leads(id, first_name, last_name, company, location_id)"
    )
    .eq("status", "active")
    .eq("is_test_contract", false)
    .gte("end_date", todayStr)
    .lte("end_date", in60Str)
    .order("end_date", { ascending: true });

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter by location through the lead relationship
  type Lead = { id: string; first_name: string; last_name: string; company: string | null; location_id: string | null };
  type Row = {
    id: string;
    contract_number: string | null;
    end_date: string;
    total_amount: number | null;
    billing_cycle: string;
    tenure_months: number | null;
    seats: number | null;
    renewal_declined: boolean | null;
    renewal_reminder_count: number | null;
    lead: Lead | null;
  };

  const all = (data ?? []) as unknown as Row[];
  const filtered = locationId
    ? all.filter((c) => c.lead?.location_id === locationId)
    : all;

  // Estimate monthly value: total_amount / tenure_months (fallback to total)
  function monthlyValue(c: Row): number {
    const total = Number(c.total_amount ?? 0);
    const months = Math.max(c.tenure_months ?? 1, 1);
    return total / months;
  }

  // Check which contracts already have a renewal draft in progress
  const contractIds = filtered.map((c) => c.id);
  const { data: existingRenewals } = await adminSupabase
    .from("contracts")
    .select("parent_contract_id, status")
    .in("parent_contract_id", contractIds.length > 0 ? contractIds : ["__none__"])
    .in("status", ["draft", "sent", "viewed", "accepted", "active"]);

  const renewalStatusMap = new Map<string, string>();
  for (const r of existingRenewals || []) {
    if (r.parent_contract_id) {
      renewalStatusMap.set(r.parent_contract_id, r.status);
    }
  }

  const bucket0_30: Row[] = [];
  const bucket31_60: Row[] = [];
  for (const c of filtered) {
    const days = Math.round((new Date(c.end_date).getTime() - today.getTime()) / 86_400_000);
    if (days <= 30) bucket0_30.push(c);
    else bucket31_60.push(c);
  }

  const sumMonthly = (arr: Row[]) => arr.reduce((s, c) => s + monthlyValue(c), 0);

  const items = filtered.slice(0, 8).map((c) => {
    const renewalDraftStatus = renewalStatusMap.get(c.id) || null;
    const declined = !!c.renewal_declined;
    const reminderCount = c.renewal_reminder_count || 0;

    let renewal_status: string;
    if (declined) renewal_status = "declined";
    else if (renewalDraftStatus === "active") renewal_status = "renewed";
    else if (renewalDraftStatus) renewal_status = "in_progress";
    else if (reminderCount > 0) renewal_status = "reminded";
    else renewal_status = "pending";

    return {
      id: c.id,
      contract_number: c.contract_number,
      end_date: c.end_date,
      days_left: Math.max(0, Math.round((new Date(c.end_date).getTime() - today.getTime()) / 86_400_000)),
      monthly_value: Math.round(monthlyValue(c)),
      seats: c.seats ?? 0,
      customer: c.lead
        ? `${c.lead.first_name} ${c.lead.last_name}${c.lead.company ? ` · ${c.lead.company}` : ""}`
        : "Unknown",
      lead_id: c.lead?.id ?? null,
      renewal_status,
      reminder_count: reminderCount,
    };
  });

  // Summary counts
  const declinedCount = filtered.filter((c) => c.renewal_declined).length;
  const inProgressCount = filtered.filter((c) => renewalStatusMap.has(c.id)).length;

  return NextResponse.json({
    data: {
      total_count: filtered.length,
      total_monthly_at_risk: Math.round(sumMonthly(filtered)),
      bucket_0_30: { count: bucket0_30.length, monthly_value: Math.round(sumMonthly(bucket0_30)) },
      bucket_31_60: { count: bucket31_60.length, monthly_value: Math.round(sumMonthly(bucket31_60)) },
      declined_count: declinedCount,
      in_progress_count: inProgressCount,
      items,
    },
  });
}
