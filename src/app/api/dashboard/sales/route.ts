import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { paymentCredit } from "@/lib/settlement";
import { asString, fetchByIds, round2, type DashRow } from "@/lib/dashboard-query";
import {
  SALES_STREAMS,
  classifyStatement,
  daysPastDue,
  effectiveDueDate,
  fyDateRange,
  fyMonthKeys,
  fyStartYearOf,
  overdueBucket,
  todayIst,
  unpaidFraction,
  type OverdueBucket,
  type SalesStream,
} from "@/lib/sales-widget";

export const maxDuration = 30;

/**
 * GET /api/dashboard/sales?fy=2026&location_id=<uuid>
 *   → per-month × per-stream invoiced / collected / outstanding / overdue for the
 *     financial year (April–March).
 * GET /api/dashboard/sales?view=documents&month=2026-09&stream=rent&measure=outstanding
 *   → the underlying statements behind one month (optionally one stream).
 *
 * Read-only. Source is finalized/exported, non-voided billing_statements,
 * attributed to the month of their billing period. Values are ex-GST; collected
 * and outstanding apportion each statement's ex-GST value by the share of its
 * (GST-inclusive) total that has been settled, so invoiced = collected +
 * outstanding always holds.
 *
 * Access: admin, manager, accounts.
 */

const PAGE = 1000;
const DOC_LIMIT = 25;

type Row = DashRow;
type Admin = Awaited<ReturnType<typeof createAdminClient>>;

const STATEMENT_COLUMNS =
  "id, statement_number, statement_type, created_via, contract_id, booking_id, invoice_id, case_id, aggregator_id, lead_id, " +
  "period_start, subtotal, total_amount, tax_percentage, fixed_amount, booking_usage_amount, " +
  "due_date, gst_invoice_due_date, written_off_amount, status";

async function fetchStatements(admin: Admin, start: string, end: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("billing_statements")
      .select(STATEMENT_COLUMNS)
      .in("status", ["finalized", "exported"])
      .is("voided_at", null)
      .gte("period_start", start)
      .lte("period_start", end)
      .order("period_start")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const str = asString;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const today = todayIst();
  const fyParam = parseInt(sp.get("fy") ?? "", 10);
  const fy = Number.isFinite(fyParam) && fyParam >= 2020 && fyParam <= 2100 ? fyParam : fyStartYearOf(today);
  const locationId = sp.get("location_id");
  const view = sp.get("view") === "documents" ? "documents" : "summary";
  const { start, end } = fyDateRange(fy);

  try {
    const statements = await fetchStatements(admin, start, end);

    const [contracts, bookings, leads, aggregators] = await Promise.all([
      fetchByIds(admin, "contracts", "id, contract_number, location_id", statements.map((s) => str(s.contract_id)).filter(Boolean) as string[]),
      fetchByIds(admin, "bookings", "id, booking_number, location_id", statements.map((s) => str(s.booking_id)).filter(Boolean) as string[]),
      fetchByIds(admin, "leads", "id, first_name, last_name, company, location_id", statements.map((s) => str(s.lead_id)).filter(Boolean) as string[]),
      fetchByIds(admin, "aggregators", "id, name", statements.map((s) => str(s.aggregator_id)).filter(Boolean) as string[]),
    ]);
    const contractById = new Map(contracts.map((c) => [c.id as string, c]));
    const bookingById = new Map(bookings.map((b) => [b.id as string, b]));
    const leadById = new Map(leads.map((l) => [l.id as string, l]));
    const aggregatorById = new Map(aggregators.map((a) => [a.id as string, a]));

    const locationOf = (s: Row): string | null =>
      str(contractById.get(str(s.contract_id) ?? "")?.location_id) ??
      str(bookingById.get(str(s.booking_id) ?? "")?.location_id) ??
      str(leadById.get(str(s.lead_id) ?? "")?.location_id);

    const scoped = locationId ? statements.filter((s) => locationOf(s) === locationId) : statements;

    // Paid-to-date per statement, TDS included (shared settlement definition).
    const payments = await fetchByIds(
      admin,
      "billing_payments",
      "billing_statement_id, amount, tds_amount",
      scoped.map((s) => s.id as string),
      "billing_statement_id"
    );
    const paidByStatement = new Map<string, number>();
    for (const p of payments) {
      const id = p.billing_statement_id as string;
      paidByStatement.set(id, (paidByStatement.get(id) ?? 0) + paymentCredit(p as { amount: number; tds_amount: number }));
    }

    const customerOf = (s: Row): string => {
      const agg = aggregatorById.get(str(s.aggregator_id) ?? "");
      if (agg) return String(agg.name ?? "—");
      const l = leadById.get(str(s.lead_id) ?? "");
      if (!l) return "—";
      return (str(l.company) || `${str(l.first_name) ?? ""} ${str(l.last_name) ?? ""}`.trim() || "—");
    };

    // One enriched record per statement, split across streams.
    const enriched = scoped.map((s) => {
      const parts = classifyStatement({
        statement_type: str(s.statement_type),
        created_via: str(s.created_via),
        contract_id: str(s.contract_id),
        booking_id: str(s.booking_id),
        invoice_id: str(s.invoice_id),
        case_id: str(s.case_id),
        aggregator_id: str(s.aggregator_id),
        subtotal: s.subtotal as number | null,
        total_amount: s.total_amount as number | null,
        tax_percentage: s.tax_percentage as number | null,
        fixed_amount: s.fixed_amount as number | null,
        booking_usage_amount: s.booking_usage_amount as number | null,
      });
      const unpaid = unpaidFraction(
        s.total_amount as number | null,
        paidByStatement.get(s.id as string) ?? 0,
        s.written_off_amount as number | null
      );
      const due = effectiveDueDate({ gst_invoice_due_date: str(s.gst_invoice_due_date), due_date: str(s.due_date) });
      const days = daysPastDue(due, today);
      return { s, parts, unpaid, due, days, month: String(s.period_start).slice(0, 7) };
    });

    if (view === "documents") {
      const month = sp.get("month") ?? "";
      const streamParam = sp.get("stream");
      const stream = (SALES_STREAMS as readonly string[]).includes(streamParam ?? "") ? (streamParam as SalesStream) : null;
      const measure = ["invoiced", "collected", "outstanding"].includes(sp.get("measure") ?? "") ? sp.get("measure")! : "invoiced";

      const docs = enriched
        .filter((e) => e.month === month)
        .map((e) => {
          const invoiced = e.parts.filter((p) => !stream || p.stream === stream).reduce((a, p) => a + p.amount, 0);
          const outstanding = invoiced * e.unpaid;
          const streams = [...new Set(e.parts.filter((p) => !stream || p.stream === stream).map((p) => p.stream))];
          return {
            id: e.s.id as string,
            number: str(e.s.statement_number) ?? "—",
            customer: customerOf(e.s),
            streams,
            invoiced: round2(invoiced),
            collected: round2(invoiced - outstanding),
            outstanding: round2(outstanding),
            due_date: e.due,
            days_past_due: e.days,
          };
        })
        .filter((d) => d.invoiced > 0 && (measure !== "outstanding" || d.outstanding > 0.005) && (measure !== "collected" || d.collected > 0.005))
        .sort((a, b) => (b[measure as "invoiced" | "collected" | "outstanding"] - a[measure as "invoiced" | "collected" | "outstanding"]));

      return NextResponse.json({ data: { documents: docs.slice(0, DOC_LIMIT), total_count: docs.length } });
    }

    // ── Summary ────────────────────────────────────────────────────────────
    type Cell = { invoiced: number; collected: number; outstanding: number; overdue: number };
    const blank = (): Cell => ({ invoiced: 0, collected: 0, outstanding: 0, overdue: 0 });
    const monthKeys = fyMonthKeys(fy);
    const grid = new Map<string, Record<SalesStream, Cell>>(
      monthKeys.map((k) => [k, Object.fromEntries(SALES_STREAMS.map((st) => [st, blank()])) as Record<SalesStream, Cell>])
    );
    const buckets: Record<OverdueBucket, number> = { not_due: 0, d_1_30: 0, d_31_60: 0, d_60_plus: 0, no_due_date: 0 };

    for (const e of enriched) {
      const row = grid.get(e.month);
      if (!row) continue;
      for (const p of e.parts) {
        const out = p.amount * e.unpaid;
        const cell = row[p.stream];
        cell.invoiced += p.amount;
        cell.outstanding += out;
        cell.collected += p.amount - out;
        if (out > 0 && e.days != null && e.days > 0) cell.overdue += out;
        if (out > 0) buckets[overdueBucket(e.days)] += out;
      }
    }

    const months = monthKeys.map((key) => {
      const row = grid.get(key)!;
      return {
        key,
        streams: Object.fromEntries(
          SALES_STREAMS.map((st) => [st, {
            invoiced: round2(row[st].invoiced),
            collected: round2(row[st].collected),
            outstanding: round2(row[st].outstanding),
            overdue: round2(row[st].overdue),
          }])
        ),
      };
    });

    return NextResponse.json({
      data: {
        fy,
        today,
        months,
        overdue_buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round2(v)])),
      },
    });
  } catch (err) {
    // Message only — rows can carry customer data, so never log them.
    console.error("[dashboard/sales]", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Failed to load sales data" }, { status: 500 });
  }
}
