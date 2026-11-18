import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { escapeLike, istDateString } from "@/lib/prepaid";

/**
 * GET /api/leads/[id]/packages
 *
 * Every package this lead can use: ones bought for them, and ones bought for
 * their company (any contact of that company may use those).
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: lead } = await supabase.from("leads").select("id, company").eq("id", id).single();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const select = `
    id, credit_type, total_credits, credits_used, expires_at, status, payment_status, lead_id, company_name,
    cancellation_window_hours,
    package:prepaid_packages(name),
    locations:prepaid_purchase_locations(location:locations(name))
  `;
  const company = lead.company?.trim();
  const [own, shared] = await Promise.all([
    supabase.from("prepaid_purchases").select(select).eq("lead_id", id),
    company
      ? supabase.from("prepaid_purchases").select(select).is("lead_id", null).ilike("company_name", escapeLike(company))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = own.error ?? shared.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const today = istDateString();
  /* eslint-disable @typescript-eslint/no-explicit-any -- joined rows are loosely typed by the client */
  const one = (v: any) => (Array.isArray(v) ? v[0] : v);
  const rows = [...(own.data ?? []), ...(shared.data ?? [])].map((p: any) => {
    const remaining = Math.max(0, Number(p.total_credits) - Number(p.credits_used));
    let status: string = p.status;
    if (p.payment_status === "pending_payment") status = "pending_payment";
    else if (status === "active") {
      if (remaining <= 0) status = "exhausted";
      else if (p.expires_at < today) status = "expired";
    }
    return {
      id: p.id,
      name: one(p.package)?.name ?? "Prepaid package",
      credit_type: p.credit_type,
      total_credits: Number(p.total_credits),
      credits_remaining: remaining,
      expires_at: p.expires_at,
      status,
      for_company: !p.lead_id,
      company_name: p.company_name,
      cancellation_window_hours: p.cancellation_window_hours == null ? null : Number(p.cancellation_window_hours),
      locations: (p.locations ?? []).map((l: any) => one(l.location)?.name).filter(Boolean),
    };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rank = (s: string) => (s === "active" ? 0 : s === "pending_payment" ? 1 : 2);
  rows.sort((a, b) => rank(a.status) - rank(b.status) || a.expires_at.localeCompare(b.expires_at));
  return NextResponse.json({ data: rows });
}
