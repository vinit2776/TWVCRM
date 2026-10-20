import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { AUTO_RESOLVE_EFFECTIVE_FROM_KEY, reconcileLeadEnquiries } from "@/lib/enquiry-progress-load";

/**
 * GET /api/cron/enquiry-reconcile
 *
 * Daily catch-all for automatic enquiry resolution. Activating a contract or marking a lead
 * lost resolves its enquiries immediately; this sweep covers everything else — chiefly the
 * "no activity for 21 days" rule, and any activation path that doesn't call it directly.
 * Only enquiries received on/after app_settings.enquiry_auto_resolve_effective_from are
 * touched; with no such setting it does nothing.
 */
const MAX_LEADS_PER_RUN = 1000;
const CHUNK = 50;

async function handler(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();

  const { data: setting } = await admin.from("app_settings").select("value").eq("key", AUTO_RESOLVE_EFFECTIVE_FROM_KEY).maybeSingle();
  if (!setting?.value) return NextResponse.json({ message: "No auto-resolve cut-off set; nothing to do", resolved: 0 });

  const { data: open, error } = await admin
    .from("lead_enquiries")
    .select("lead_id")
    .is("resolved_at", null)
    .not("lead_id", "is", null)
    .gte("received_at", setting.value as string)
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leadIds = Array.from(new Set((open ?? []).map((r) => r.lead_id as string))).slice(0, MAX_LEADS_PER_RUN);
  let resolved = 0;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    resolved += await reconcileLeadEnquiries(admin, leadIds.slice(i, i + CHUNK));
  }
  return NextResponse.json({ message: `Resolved ${resolved} enquiries`, leads_checked: leadIds.length, resolved });
}

export const GET = withCronHealth("cron/enquiry-reconcile", handler);
