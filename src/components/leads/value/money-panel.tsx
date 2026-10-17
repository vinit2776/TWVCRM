"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { ValueStat } from "@/components/leads/value/value-stat";
import type { ConcessionKind, Money, MoneyInvoice } from "@/lib/customer-value/money";
import { formatCurrency, formatDate } from "@/lib/utils";

const STATEMENT_TYPE_LABELS: Record<string, string> = {
  combined: "Rent and usage",
  rent: "Rent",
  usage: "Usage",
  electricity: "Electricity",
  reimbursement: "Reimbursement",
  vo_renewal: "Virtual office renewal",
};

const CONCESSION_KIND_LABELS: Record<ConcessionKind, string> = {
  rent_waiver: "Rent waived (given)",
  moratorium: "Skipped months",
  booking_waiver: "Booking waivers",
  refund: "Refunds",
  credit_note: "Credit notes",
};

const INITIAL_INVOICE_ROWS = 12;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Signed average days to pay in plain words. */
function avgDaysText(avg: number | null): string {
  if (avg === null) return "Not enough data";
  const rounded = Math.round(Math.abs(avg) * 10) / 10;
  if (rounded === 0) return "On the due date";
  return `${rounded} days ${avg > 0 ? "late" : "early"}`;
}

function timingBadge(inv: MoneyInvoice): { text: string; color: string } {
  if (inv.daysLate !== null) {
    if (inv.daysLate <= 0) {
      return {
        text: inv.daysLate === 0 ? "On time" : `${plural(-inv.daysLate, "day")} early`,
        color: "bg-green-100 text-green-800",
      };
    }
    return {
      text: `${plural(inv.daysLate, "day")} late`,
      color: inv.daysLate <= 7 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800",
    };
  }
  if (inv.daysOverdue !== null) return { text: `Overdue ${inv.daysOverdue} d`, color: "bg-red-100 text-red-800" };
  if (inv.paymentStatus === "paid") return { text: "Paid", color: "bg-gray-100 text-gray-700" };
  return { text: inv.due ? "Not due yet" : "No due date", color: "bg-gray-100 text-gray-700" };
}

export function MoneyPanel({ leadId }: { leadId: string }) {
  const [money, setMoney] = useState<Money | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllInvoices, setShowAllInvoices] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/money`);
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load the money figures");
      const json = (await res.json()) as { money: Money };
      setMoney(json.money);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the money figures");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-24" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (error || !money) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load the money figures"}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { lifetime, timing, invoices, concessions } = money;

  if (lifetime.issuedCount === 0 && concessions.entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No invoices have been issued to this customer yet.
        </CardContent>
      </Card>
    );
  }

  const visibleInvoices = showAllInvoices ? invoices : invoices.slice(0, INITIAL_INVOICE_ROWS);
  const keptKinds = (Object.keys(CONCESSION_KIND_LABELS) as ConcessionKind[]).filter(
    (k) => k !== "rent_waiver" && concessions.totals[k] > 0
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <ValueStat
          label="Invoiced, before GST"
          value={formatCurrency(lifetime.invoicedExGst)}
          hint={`${plural(lifetime.issuedCount, "invoice")}${
            lifetime.firstInvoiceDate ? ` since ${formatDate(lifetime.firstInvoiceDate)}` : ""
          }`}
        />
        <ValueStat label="Invoiced, with GST" value={formatCurrency(lifetime.invoicedInclGst)} />
        <ValueStat
          label="Received"
          value={formatCurrency(lifetime.cashReceived)}
          hint={[
            lifetime.tdsDeducted > 0 ? `plus ${formatCurrency(lifetime.tdsDeducted)} TDS deducted` : null,
            lifetime.overpaid > 0
              ? `${formatCurrency(lifetime.overpaid)} paid over on ${plural(lifetime.overpaidCount, "invoice")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined}
        />
        <ValueStat
          label="Outstanding"
          value={formatCurrency(lifetime.outstanding)}
          hint={
            timing.overdueNow.count > 0
              ? `${formatCurrency(timing.overdueNow.amount)} overdue`
              : lifetime.outstanding > 0
                ? "Nothing overdue"
                : undefined
          }
        />
        <ValueStat
          label="Average per month"
          value={formatCurrency(Math.round(lifetime.avgMonthlyExGst))}
          hint={`before GST, over ${plural(lifetime.monthsSpan, "month")}`}
        />
        <ValueStat
          label="Concessions given"
          value={formatCurrency(concessions.totals.all)}
          hint={
            concessions.totals.unbilledRent > 0
              ? `excludes ${formatCurrency(concessions.totals.unbilledRent)} of waived months not yet classified`
              : concessions.entries.length === 0
                ? "None recorded"
                : "estimated, see the ledger below"
          }
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">How they pay</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <ValueStat
              label="Paid on time"
              value={timing.onTimePct === null ? "—" : `${Math.round(timing.onTimePct)}%`}
              hint={timing.measuredCount > 0 ? `of ${plural(timing.measuredCount, "paid invoice")}` : undefined}
            />
            <ValueStat label="Average" value={avgDaysText(timing.avgDaysLate)} />
            <ValueStat
              label="Slowest payment"
              value={
                timing.worstDaysLate === null
                  ? "—"
                  : timing.worstDaysLate > 0
                    ? `${plural(timing.worstDaysLate, "day")} late`
                    : "Never late"
              }
            />
            <ValueStat
              label="Overdue now"
              value={timing.overdueNow.count === 0 ? "None" : plural(timing.overdueNow.count, "invoice")}
              hint={
                timing.overdueNow.count > 0
                  ? `${formatCurrency(timing.overdueNow.amount)}, up to ${timing.overdueNow.maxDays} days`
                  : undefined
              }
            />
            <ValueStat
              label="Reminders sent"
              value={String(timing.totalReminders)}
              hint={timing.remindedCount > 0 ? `on ${plural(timing.remindedCount, "invoice")}` : undefined}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Timing uses the {timing.measuredCount} paid invoices that have a due date. {timing.issuedCount - timing.withDueDateCount > 0
              ? `${timing.issuedCount - timing.withDueDateCount} of ${timing.issuedCount} invoices have no due date (older invoices predate it) and are left out.`
              : "Every invoice has a due date."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-normal">Invoice</th>
                  <th className="py-2 pr-3 font-normal">Period</th>
                  <th className="py-2 pr-3 text-right font-normal">Amount</th>
                  <th className="py-2 pr-3 font-normal">Due</th>
                  <th className="py-2 pr-3 font-normal">Paid on</th>
                  <th className="py-2 pr-3 font-normal">Timing</th>
                  <th className="py-2 text-right font-normal">Balance</th>
                </tr>
              </thead>
              <tbody>
                {visibleInvoices.map((inv) => {
                  const badge = timingBadge(inv);
                  return (
                    <tr key={inv.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{inv.reference}</span>
                        <span className="block text-xs text-muted-foreground">
                          {inv.type ? (STATEMENT_TYPE_LABELS[inv.type] ?? inv.type) : "—"}
                          {inv.reminders > 0 ? ` · ${plural(inv.reminders, "reminder")}` : ""}
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDate(inv.periodStart)}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(inv.total)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{inv.due ? formatDate(inv.due) : "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{inv.paidOn ? formatDate(inv.paidOn) : "—"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant="secondary" className={badge.color}>
                          {badge.text}
                        </Badge>
                      </td>
                      <td className="py-2 text-right">{inv.balance > 0 ? formatCurrency(inv.balance) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {invoices.length > INITIAL_INVOICE_ROWS && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAllInvoices((v) => !v)}>
              {showAllInvoices ? "Show fewer" : `Show all ${invoices.length} invoices`}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Concessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {concessions.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No waivers, skipped months, refunds or credit notes recorded.</p>
          ) : (
            <>
              {keptKinds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {keptKinds.map((k) => (
                    <Badge key={k} variant="secondary" className="bg-muted text-foreground">
                      {CONCESSION_KIND_LABELS[k]} {formatCurrency(concessions.totals[k])}
                    </Badge>
                  ))}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-normal">Date</th>
                      <th className="py-2 pr-3 font-normal">What</th>
                      <th className="py-2 pr-3 text-right font-normal">Amount</th>
                      <th className="py-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {concessions.entries.map((e, i) => (
                      <tr key={`${e.kind}-${e.date}-${i}`} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{e.date ? formatDate(e.date) : "—"}</td>
                        <td className="py-2 pr-3">
                          {e.label}
                          {e.detail && <span className="block text-xs text-muted-foreground">{e.detail}</span>}
                        </td>
                        <td className="py-2 pr-3 text-right">{e.amount === null ? "—" : formatCurrency(e.amount)}</td>
                        <td className="py-2 text-xs text-muted-foreground">{e.note ?? (e.counted ? "Counted" : "")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {concessions.totals.unbilledRent > 0 && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  About {formatCurrency(concessions.totals.unbilledRent)} of waived rent has not been marked as given to the
                  customer or billed outside the CRM. Some of those months may have been billed elsewhere, so they are
                  listed but not counted as concessions until they are classified.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Waived and skipped months are priced at the contract&apos;s rent for that month, so they are
                estimates. Pending and reversed items are listed but not counted.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
