"use client";

import { formatCurrency, cn } from "@/lib/utils";
import type { BillsMonthlySummary } from "@/lib/bills-monthly-summary";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_FMT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const CHART_HEIGHT = 150;

function parseMonth(key: string): Date | null {
  return key === "none" ? null : new Date(`${key}-01T00:00:00Z`);
}

export function monthLabel(key: string): string {
  const d = parseMonth(key);
  return d ? LONG_FMT.format(d) : "No invoice date";
}

function shortMoney(n: number): string {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${Math.round(n)}`;
}

/** Every calendar month between the first and last bill, so gaps show as gaps. */
function fillMonths(summary: BillsMonthlySummary) {
  const dated = summary.months.filter((m) => m.month !== "none");
  const undated = summary.months.find((m) => m.month === "none");
  if (dated.length === 0) return undated ? [undated] : [];
  const byKey = new Map(dated.map((m) => [m.month, m]));
  const out = [];
  const [sy, sm] = dated[0].month.split("-").map(Number);
  const [ey, em] = dated[dated.length - 1].month.split("-").map(Number);
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (y++, (m = 1)) : m++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(
      byKey.get(key) ?? {
        month: key, billCount: 0, total: 0, paid: 0, partiallyPaid: 0, unpaid: 0, rejected: 0, openQueries: 0,
      },
    );
  }
  if (undated) out.push(undated);
  return out;
}

const SEGMENTS = [
  { key: "unpaid", label: "Unpaid", className: "bg-red-500" },
  { key: "partiallyPaid", label: "Partially paid", className: "bg-yellow-500" },
  { key: "paid", label: "Paid", className: "bg-green-600" },
  { key: "rejected", label: "Rejected", className: "bg-gray-400" },
] as const;

interface Props {
  summary: BillsMonthlySummary;
  onSelectMonth: (month: string) => void;
}

export function VendorBillsSummary({ summary, onSelectMonth }: Props) {
  const months = fillMonths(summary);
  const max = Math.max(1, ...months.map((m) => m.total));
  const hasPartial = summary.partiallyPaid > 0;
  const hasRejected = summary.rejected > 0;
  const outstanding = summary.unpaid + summary.partiallyPaid;

  const tiles = [
    { label: "Total shown", value: formatCurrency(summary.total), sub: `${summary.billCount} bills · ${summary.months.length} ${summary.months.length === 1 ? "month" : "months"}` },
    { label: "Paid", value: formatCurrency(summary.paid) },
    { label: "Unpaid", value: formatCurrency(outstanding), sub: hasPartial ? "incl. partially paid" : undefined },
    ...(hasRejected ? [{ label: "Rejected", value: formatCurrency(summary.rejected), sub: "not owed" }] : []),
    { label: "Open queries", value: String(summary.openQueries), sub: summary.openQueries ? `on ${summary.billsWithOpenQueries} ${summary.billsWithOpenQueries === 1 ? "bill" : "bills"}` : undefined },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="text-xl font-semibold">{t.value}</p>
            {t.sub && <p className="text-xs text-muted-foreground">{t.sub}</p>}
          </div>
        ))}
      </div>

      <div className="rounded-lg border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p className="text-sm font-medium">Billed by month and payment status</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {SEGMENTS.filter((s) => (s.key !== "partiallyPaid" || hasPartial) && (s.key !== "rejected" || hasRejected)).map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.className)} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="flex items-end gap-2 border-b" style={{ height: CHART_HEIGHT + 24, minWidth: months.length * 48 }}>
            {months.map((m) => {
              const barHeight = Math.max(m.total > 0 ? 4 : 0, Math.round((m.total / max) * CHART_HEIGHT));
              return (
                <button
                  key={m.month}
                  type="button"
                  disabled={m.billCount === 0}
                  onClick={() => onSelectMonth(m.month)}
                  title={m.billCount ? `${monthLabel(m.month)} · ${formatCurrency(m.total)} · ${m.billCount} bills` : `${monthLabel(m.month)} · no bills`}
                  className="flex-1 flex flex-col items-center justify-end h-full min-w-10 group disabled:cursor-default"
                >
                  <span className="text-[11px] text-muted-foreground mb-1">{m.billCount ? shortMoney(m.total) : "—"}</span>
                  <div className="w-full max-w-14 flex flex-col rounded-t overflow-hidden group-hover:opacity-80" style={{ height: barHeight }}>
                    {SEGMENTS.map((s) => {
                      const amount = m[s.key];
                      return amount > 0 ? <div key={s.key} className={s.className} style={{ flex: amount }} /> : null;
                    })}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 mt-1" style={{ minWidth: months.length * 48 }}>
            {months.map((m) => {
              const d = parseMonth(m.month);
              return (
                <span key={m.month} className="flex-1 min-w-10 text-center text-[11px] text-muted-foreground">
                  {d ? MONTH_NAMES[d.getUTCMonth()] : "n/a"}
                  {d && (d.getUTCMonth() === 0 || m === months[0]) ? ` '${String(d.getUTCFullYear()).slice(2)}` : ""}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
