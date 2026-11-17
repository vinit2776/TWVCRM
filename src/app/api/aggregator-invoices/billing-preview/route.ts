import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  AGG_BILLABLE_CASE_STATUSES,
  AGG_BILLING_MODE_KEY,
  parseAggBillingMode,
  previewLegacyVsNew,
  type BilledTerm,
} from "@/lib/aggregator-term-billing";

const querySchema = z.object({
  aggregator_id: z.string().uuid(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

/**
 * GET: read-only comparison of what the legacy monthly run and the
 * once-per-tenure run would bill per case for a period. Writes nothing.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const { aggregator_id, month, year } = parsed.data;

  const admin = await createAdminClient();
  const { data: cases, error } = await admin
    .from("cases")
    .select("id, case_number, rate, tenure_months, start_date, activated_at")
    .eq("aggregator_id", aggregator_id)
    .in("status", [...AGG_BILLABLE_CASE_STATUSES]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let alreadyBilled: BilledTerm[] = [];
  let ledgerAvailable = true;
  if ((cases ?? []).length > 0) {
    const { data: billed, error: billedError } = await admin
      .from("aggregator_case_terms_billed")
      .select("case_id, term_start")
      .in("case_id", (cases ?? []).map((c) => c.id));
    if (billedError?.code === "42P01") {
      ledgerAvailable = false;
    } else if (billedError) {
      return NextResponse.json({ error: billedError.message }, { status: 500 });
    } else {
      alreadyBilled = (billed ?? []) as BilledTerm[];
    }
  }

  const settings = await getCachedSettings(admin, [AGG_BILLING_MODE_KEY]);
  const rows = previewLegacyVsNew({ cases: cases ?? [], periodMonth: month, periodYear: year, alreadyBilled });
  const round = (n: number) => Math.round(n * 100) / 100;
  const legacy = round(rows.reduce((s, r) => s + r.legacy, 0));
  const oncePerTenure = round(rows.reduce((s, r) => s + r.oncePerTenure, 0));

  return NextResponse.json({
    currentMode: parseAggBillingMode(settings[AGG_BILLING_MODE_KEY]),
    ledgerAvailable,
    period: { month, year },
    cases: rows,
    totals: { legacy, oncePerTenure, difference: round(oncePerTenure - legacy) },
  });
}
