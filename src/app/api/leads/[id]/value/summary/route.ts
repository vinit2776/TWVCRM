/**
 * GET /api/leads/[id]/value/summary
 *
 * Summary sub-tab of the lead's Value tab (docs/plans/customer-value-phase2.md,
 * section 7): the latest stored score, the last twelve months of it for the
 * line, and the invoices the story's sentences rest on.
 *
 * Two small reads of precomputed rows (customer_value_scores, plus the few
 * invoices named as evidence), never an aggregation over live records. Read
 * only; admin only. Uses the signed-in user's client, so the table's admin-only
 * RLS policy applies as a second gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { summariseShadow, type ShadowRow } from "@/lib/customer-value/shadow-margin";
import { monthlySeries, type StoredScoreRow } from "@/lib/customer-value/summary-view";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

const SCORE_COLUMNS =
  "as_of, payment, friction, engagement, profitability, confidence, overall, tier, status, reason, trend_vs_90d, method, story, settings_version, computed_at";

/** Months of history fetched: a little over the 12 the chart shows, so month ends are never cut off. */
const HISTORY_DAYS = 400;

function daysBefore(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const today = todayYmdIst();
  const { data, error } = await supabase
    .from("customer_value_scores")
    .select(SCORE_COLUMNS)
    .eq("lead_id", leadId)
    .gte("as_of", daysBefore(today, HISTORY_DAYS))
    .order("as_of", { ascending: true })
    .limit(500)
    .returns<StoredScoreRow[]>();
  if (error) {
    console.error("[api/leads/value/summary] scores query failed:", error.message);
    return NextResponse.json({ error: "Failed to load summary" }, { status: 500 });
  }

  const rows = data ?? [];
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;

  // The invoices named by the story's sentences, so each can be shown by its reference.
  const evidenceIds = [
    ...new Set((latest?.story?.sentences ?? []).flatMap((s) => s.evidence).slice(0, 50)),
  ];
  let evidence: Record<string, { reference: string; total: number | null; due_date: string | null }> = {};
  if (evidenceIds.length > 0) {
    const { data: statements } = await supabase
      .from("billing_statements")
      .select("id, statement_number, gst_invoice_number, total_amount, due_date")
      .in("id", evidenceIds)
      .eq("lead_id", leadId)
      .returns<Array<{ id: string; statement_number: string | null; gst_invoice_number: string | null; total_amount: number | null; due_date: string | null }>>();
    evidence = Object.fromEntries(
      (statements ?? []).map((s) => [
        s.id,
        { reference: s.gst_invoice_number || s.statement_number || "Invoice", total: s.total_amount === null ? null : Number(s.total_amount), due_date: s.due_date },
      ])
    );
  }

  // The shadow margin (after variable costs) sits beside the score and is not part of it. A failed read
  // here must not take the score away, so it just leaves the margin out.
  let shadowMargin = null;
  const marginRes = await supabase
    .from("customer_value_margin")
    .select("month, revenue, variable_cost, margin_after_variable, confidence")
    .eq("lead_id", leadId)
    .order("month", { ascending: false })
    .limit(3)
    .returns<Array<{ month: string; revenue: number | string; variable_cost: number | string; margin_after_variable: number | string; confidence: number | string | null }>>();
  if (marginRes.error) {
    console.error("[api/leads/value/summary] margin query failed:", marginRes.error.message);
  } else {
    const marginRows: ShadowRow[] = (marginRes.data ?? []).map((r) => ({
      month: r.month,
      revenue: Number(r.revenue),
      variable_cost: Number(r.variable_cost),
      margin_after_variable: Number(r.margin_after_variable),
      confidence: r.confidence === null ? null : Number(r.confidence),
    }));
    shadowMargin = summariseShadow(marginRows);
  }

  return NextResponse.json(
    { today, latest, series: monthlySeries(rows, today), evidence, shadowMargin },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
  );
}
