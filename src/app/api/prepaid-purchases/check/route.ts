import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPrepaidApplicableToSpace, escapeLike } from "@/lib/prepaid";

/**
 * GET /api/prepaid-purchases/check
 *
 * Find the best active prepaid purchase for a customer + space combination.
 * Called by the booking form after customer and space are selected.
 *
 * Query params:
 *   lead_id     — UUID of the lead (optional, used to match lead AND company)
 *   company_name — company name (optional fallback for corporate matching)
 *   space_id    — UUID of the space being booked (required for workspace_type match)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const leadId = searchParams.get("lead_id");
  const companyName = searchParams.get("company_name");
  const spaceId = searchParams.get("space_id");

  if (!spaceId) return NextResponse.json({ error: "space_id is required" }, { status: 400 });
  if (!leadId && !companyName) {
    return NextResponse.json({ data: null }); // no customer info — return empty
  }

  // Fetch the space's workspace_type so we can filter packages
  const { data: space } = await supabase
    .from("spaces")
    .select("id, workspace_type")
    .eq("id", spaceId)
    .single();

  const today = new Date().toISOString().split("T")[0];

  // Build OR filter: match by lead_id OR by company_name
  // Also optionally match the lead's company if we have a lead_id
  let companyFromLead: string | null = null;
  if (leadId) {
    const { data: lead } = await supabase
      .from("leads")
      .select("company")
      .eq("id", leadId)
      .single();
    companyFromLead = lead?.company || null;
  }

  // Fetch all active, paid, non-expired purchases for this lead, plus any bought
  // for their company. Queried separately so company names are matched literally
  // (a comma, bracket or % in a name must not alter the filter).
  const companyNames = [companyFromLead, companyName].filter((n): n is string => !!n && n.trim() !== "");
  const usable = () => supabase
    .from("prepaid_purchases")
    .select(`
      *,
      package:prepaid_packages(id, name, workspace_type, space_id, credit_type, total_credits)
    `)
    .eq("status", "active")
    .eq("payment_status", "paid")
    .gte("expires_at", today);

  const lookups = [
    ...(leadId ? [usable().eq("lead_id", leadId)] : []),
    ...companyNames.map((n) => usable().ilike("company_name", escapeLike(n.trim()))),
  ];
  if (lookups.length === 0) return NextResponse.json({ data: null });

  const results = await Promise.all(lookups);
  const error = results.find((r) => r.error)?.error;
  const byId = new Map<string, NonNullable<(typeof results)[number]["data"]>[number]>();
  for (const r of results) for (const row of r.data ?? []) byId.set(row.id, row);
  // soonest to expire first (FIFO)
  const purchases = [...byId.values()].sort((x, y) => String(x.expires_at).localeCompare(String(y.expires_at)));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter by workspace_type compatibility

  const compatible = (purchases || []).filter((p) => {
    const creditsRemaining = Number(p.total_credits) - Number(p.credits_used);
    if (creditsRemaining <= 0) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = p.package as any;
    if (!space) return false;
    if (!isPrepaidApplicableToSpace(pkg, space)) return false;
    return true;
  });

  if (compatible.length === 0) {
    return NextResponse.json({ data: null });
  }

  // Return the best match (soonest expiry with credits remaining)
  const best = compatible[0];
  const creditsRemaining = Math.max(0, Number(best.total_credits) - Number(best.credits_used));

  return NextResponse.json({
    data: {
      ...best,
      credits_remaining: creditsRemaining,
    },
  });
}
