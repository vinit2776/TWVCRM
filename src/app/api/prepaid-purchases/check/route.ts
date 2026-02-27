import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

  // Fetch all active, non-expired purchases for this customer / company
  const orFilters: string[] = [];
  if (leadId) orFilters.push(`lead_id.eq.${leadId}`);
  if (companyFromLead) orFilters.push(`company_name.ilike.${companyFromLead}`);
  if (companyName && companyName !== companyFromLead) orFilters.push(`company_name.ilike.${companyName}`);

  if (orFilters.length === 0) {
    return NextResponse.json({ data: null });
  }

  const { data: purchases, error } = await supabase
    .from("prepaid_purchases")
    .select(`
      *,
      package:prepaid_packages(id, name, workspace_type, credit_type, total_credits)
    `)
    .eq("status", "active")
    .gte("expires_at", today)
    .or(orFilters.join(","))
    .order("expires_at", { ascending: true }); // soonest to expire first (FIFO)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter by workspace_type compatibility
  const spaceWorkspaceType = space?.workspace_type;

  const compatible = (purchases || []).filter((p) => {
    const creditsRemaining = Number(p.total_credits) - Number(p.credits_used);
    if (creditsRemaining <= 0) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkgWorkspaceType = (p.package as any)?.workspace_type;
    // Package applies if it has no workspace_type restriction OR matches the space's type
    if (pkgWorkspaceType && spaceWorkspaceType && pkgWorkspaceType !== spaceWorkspaceType) return false;
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
