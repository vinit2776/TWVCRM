/**
 * POST /api/admin/customer-value/backfill
 *
 * Computes the monthly snapshot figures for the Customer Value tab
 * (customer_value_monthly) for one customer, or for all of them a page at a time.
 *
 * Safe by construction:
 *  - **Dry-run by default.** Nothing is written unless the body says
 *    `"dry_run": false`; an empty body only reports what it would do.
 *  - **Strict body.** An unknown key (a mistyped `dryRun`) is a 400, never ignored.
 *  - **Writes only snapshot tables.** It reads CRM records and upserts the
 *    derived monthly rows. It sends nothing to any customer and calls no
 *    dispatching endpoint.
 *  - Admin only. Idempotent: re-running just recomputes the same rows.
 *
 * Body: { lead_id?, limit? (1-100, default 25), after?, scores? (none|latest|history, default none),
 *         dry_run? (default true) }
 * Response includes `next_after`: pass it back as `after` to continue.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { backfillBodySchema } from "@/lib/customer-value/snapshot-backfill-schema";
import { listCustomerIds, refreshScores } from "@/lib/customer-value/scores-refresh";
import { todayYmdIst } from "@/lib/customer-value/journey";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // An empty body is fine (a dry run). A body that is present but not valid JSON is not.
  const text = await request.text();
  let json: unknown = {};
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
    }
  }
  const parsed = backfillBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }
  const { lead_id, limit, after, scores, dry_run } = parsed.data;

  try {
    // Which customers: the one asked for, or the next page of everyone with a contract.
    let leadIds: string[];
    let nextAfter: string | null = null;
    if (lead_id) {
      leadIds = [lead_id];
    } else {
      const all = (await listCustomerIds(admin)).filter((id) => !after || id > after);
      leadIds = all.slice(0, limit);
      nextAfter = all.length > limit ? leadIds[leadIds.length - 1] : null;
    }

    const result = await refreshScores(admin, todayYmdIst(), { write: !dry_run, scores, writeLeadIds: leadIds });
    return NextResponse.json({
      dry_run,
      wrote: result.wrote,
      requested: leadIds.length,
      scores,
      total_months: result.monthlyRows,
      score_rows: result.scoreRows,
      settings_version: result.settingsVersion,
      warnings: result.warnings,
      next_after: nextAfter,
      customers: result.summaries.map((s) => ({
        lead_id: s.leadId,
        months: s.months,
        first_month: s.firstMonth,
        last_month: s.lastMonth,
        tickets_linked: s.ticketsLinked,
        ticket_link_coverage: s.ticketLinkCoverage,
      })),
    });
  } catch (err) {
    // Log the failing read by name only: no customer data in logs.
    console.error("[customer-value/backfill] failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Backfill failed" }, { status: 500 });
  }
}
