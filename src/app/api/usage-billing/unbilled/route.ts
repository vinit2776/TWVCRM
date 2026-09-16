import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { countOldUsageDrafts, getUnbilledUsage } from "@/lib/usage-billing";
import { requireUsageBillingUser } from "../auth";

/**
 * GET /api/usage-billing/unbilled
 *
 * Every unbilled usage charge, grouped contract → month, with what each month
 * can send. Read-only. See src/lib/usage-billing.ts for the rules.
 */
export async function GET() {
  const auth = await requireUsageBillingUser();
  if ("response" in auth) return auth.response;

  const admin = createAdminClient();
  try {
    const [groups, oldDrafts] = await Promise.all([getUnbilledUsage(admin), countOldUsageDrafts(admin)]);
    return NextResponse.json({ data: groups, old_drafts: oldDrafts });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load unbilled usage" }, { status: 500 });
  }
}
