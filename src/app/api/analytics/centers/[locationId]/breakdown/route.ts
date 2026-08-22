/**
 * GET /api/analytics/centers/[locationId]/breakdown?metric=sales|billed|collections&start=&end=
 *
 * The line items behind one of the three summary numbers, for one center and
 * period — backs the "click a number to see what it's made of" interaction
 * on the Center Analytics comparison table. Admin only.
 *
 * Same definitions as summary/trend (see center-metrics.ts and
 * docs/plans/center-analytics-data-source.md):
 *   - sales: contracts activated in range (full contract value, one row per contract)
 *   - billed: finalized/exported billing statements whose period starts in range
 *   - collections: payments against those same statements
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { paymentCredit } from "@/lib/settlement";
import { statementReference } from "@/lib/receivables";
import { parseDateRange, istDayBounds } from "@/lib/analytics/center-metrics";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const };
  }
  return { error: null, status: 200 as const };
}

const metricSchema = z.enum(["sales", "billed", "collections"]);

function partyOf(lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null) {
  if (!lead) return "(unknown)";
  return lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "(unnamed)";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ locationId: string }> }
) {
  const { locationId } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const metricParsed = metricSchema.safeParse(request.nextUrl.searchParams.get("metric"));
  if (!metricParsed.success) {
    return NextResponse.json({ error: "metric must be sales, billed, or collections" }, { status: 400 });
  }
  const metric = metricParsed.data;

  let range;
  try {
    range = parseDateRange(request.nextUrl.searchParams);
  } catch (message) {
    return NextResponse.json({ error: String(message) }, { status: 400 });
  }

  const { data: locationContracts, error: contractsErr } = await supabase
    .from("contracts")
    .select("id, contract_number, lead_id, total_amount, activated_at")
    .eq("location_id", locationId);
  if (contractsErr) return NextResponse.json({ error: contractsErr.message }, { status: 500 });
  const contracts = locationContracts ?? [];
  const contractIds = contracts.map((c) => c.id as string);
  const contractById = new Map(contracts.map((c) => [c.id as string, c]));

  const leadIds = Array.from(new Set(contracts.map((c) => c.lead_id as string).filter(Boolean)));
  const { data: leads } = leadIds.length > 0
    ? await supabase.from("leads").select("id, first_name, last_name, company").in("id", leadIds)
    : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null; company: string | null }> };
  const leadById = new Map((leads ?? []).map((l) => [l.id as string, l]));

  if (metric === "sales") {
    const { startIso } = istDayBounds(range.start);
    const { endIso } = istDayBounds(range.end);
    const items = contracts
      .filter((c) => c.activated_at && c.activated_at >= startIso && c.activated_at <= endIso)
      .map((c) => ({
        id: c.id as string,
        reference: (c.contract_number as string) || "—",
        client_name: partyOf(leadById.get(c.lead_id as string) ?? null),
        date: c.activated_at as string,
        amount: Number(c.total_amount || 0),
        href: `/contracts/${c.id}`,
      }))
      .sort((a, b) => b.amount - a.amount);
    const total = items.reduce((s, i) => s + i.amount, 0);
    return NextResponse.json({ data: { metric, range, total: Math.round(total), items } });
  }

  // billed / collections both start from the same statement set.
  let statements: Array<{ id: string; contract_id: string; total_amount: number; period_start: string; period_end: string; due_date: string | null; statement_number: string | null; gst_invoice_number: string | null }> = [];
  if (contractIds.length > 0) {
    const { data, error } = await supabase
      .from("billing_statements")
      .select("id, contract_id, total_amount, period_start, period_end, due_date, statement_number, gst_invoice_number")
      .in("contract_id", contractIds)
      .in("status", ["finalized", "exported"])
      .gte("period_start", range.start)
      .lte("period_start", range.end);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    statements = data ?? [];
  }

  if (metric === "billed") {
    const items = statements
      .map((s) => ({
        id: s.id,
        reference: statementReference(s),
        client_name: partyOf(leadById.get(contractById.get(s.contract_id)?.lead_id as string) ?? null),
        date: s.period_start,
        amount: Number(s.total_amount || 0),
        // /billing has no per-statement detail route — link to the parent
        // contract, which lists its own billing statements.
        href: `/contracts/${s.contract_id}`,
      }))
      .sort((a, b) => b.amount - a.amount);
    const total = items.reduce((s, i) => s + i.amount, 0);
    return NextResponse.json({ data: { metric, range, total: Math.round(total), items } });
  }

  // collections
  const statementById = new Map(statements.map((s) => [s.id, s]));
  const statementIds = statements.map((s) => s.id);
  let payments: Array<{ id: string; billing_statement_id: string; amount: number; tds_amount: number | null; payment_date: string; payment_mode: string }> = [];
  if (statementIds.length > 0) {
    const { data, error } = await supabase
      .from("billing_payments")
      .select("id, billing_statement_id, amount, tds_amount, payment_date, payment_mode")
      .in("billing_statement_id", statementIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    payments = data ?? [];
  }
  const items = payments
    .map((p) => {
      const stmt = statementById.get(p.billing_statement_id);
      const contract = stmt ? contractById.get(stmt.contract_id) : undefined;
      return {
        id: p.id,
        reference: stmt ? statementReference(stmt) : "—",
        client_name: partyOf(contract ? leadById.get(contract.lead_id as string) ?? null : null),
        date: p.payment_date,
        amount: paymentCredit(p),
        href: contract ? `/contracts/${contract.id}` : null,
      };
    })
    .sort((a, b) => b.amount - a.amount);
  const total = items.reduce((s, i) => s + i.amount, 0);
  return NextResponse.json({ data: { metric, range, total: Math.round(total), items } });
}
