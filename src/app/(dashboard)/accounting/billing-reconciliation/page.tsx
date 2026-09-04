"use client";

/**
 * Recurring Contract Billing Reconciliation — monthly billing vs. collection, by center.
 *
 * One row per currently billable contract (plus a recently terminated/renewed
 * contract still carrying an unpaid balance), one column per month for a
 * rolling window starting this month. Data comes from
 * /api/accounting/billing-reconciliation in a single call; the .xlsx export
 * hits a sibling route that shares the exact same data-assembly function, so
 * the download can never disagree with what's on screen.
 */

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Download, ExternalLink, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { EmptyState } from "@/components/shared/empty-state";
import type {
  ReconciliationReport, ReconciliationCell, ReconciliationCellType, ReconciliationContractRow,
} from "@/lib/billing-reconciliation";

const CELL_STYLE: Record<ReconciliationCellType, string> = {
  paid: "bg-green-50 border-green-200 text-green-700",
  partial: "bg-amber-50 border-amber-200 text-amber-700",
  unpaid: "bg-red-50 border-red-200 text-red-700",
  future: "bg-slate-50 border-slate-200 text-slate-500",
  projected: "bg-slate-100 border-slate-300 border-dashed text-slate-400 italic",
  moratorium: "bg-purple-50 border-purple-200 text-purple-700",
  terminated: "bg-slate-50 border-slate-200 text-slate-400",
  not_started: "bg-slate-50 border-slate-200 text-slate-400",
  renewed_out: "bg-blue-50 border-blue-200 text-blue-700",
};

const LEGEND: Array<{ type: ReconciliationCellType; label: string }> = [
  { type: "paid", label: "Collected in full" },
  { type: "partial", label: "Partially collected" },
  { type: "unpaid", label: "Invoiced, uncollected" },
  { type: "future", label: "Not yet due" },
  { type: "projected", label: "Beyond tenure — projected w/ escalation" },
  { type: "moratorium", label: "Moratorium / not billed" },
  { type: "terminated", label: "Terminated / not started — no billing" },
  { type: "renewed_out", label: "Renewed — continues on new contract" },
];

function monthLabel(month: number, year: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

function Cell({ cell }: { cell: ReconciliationCell }) {
  const base = "rounded-md border px-2 py-1.5 text-right min-w-[130px]";
  if (cell.type === "moratorium") {
    return (
      <div className={`${base} ${CELL_STYLE[cell.type]} text-center`}>
        <div className="text-[10px] uppercase tracking-wide opacity-75">Moratorium</div>
        <div className="text-xs font-medium">{cell.reason}</div>
      </div>
    );
  }
  if (cell.type === "terminated" || cell.type === "not_started") {
    return (
      <div className={`${base} ${CELL_STYLE[cell.type]} flex items-end justify-end gap-1`}>
        <span>—</span>
        <span className="text-[10px]">{cell.type === "terminated" ? "No further billing" : "Not started yet"}</span>
      </div>
    );
  }
  if (cell.type === "renewed_out") {
    return (
      <div className={`${base} ${CELL_STYLE[cell.type]} flex items-end justify-end gap-1`}>
        <span>—</span>
        {cell.refContractId ? (
          <Link href={`/contracts/${cell.refContractId}`} className="text-[10px] font-semibold underline underline-offset-2">
            Renewed &rarr; {cell.refContractNumber}
          </Link>
        ) : (
          <span className="text-[10px] font-semibold">Renewed</span>
        )}
      </div>
    );
  }
  const label =
    cell.type === "paid" ? "Collected in full" :
    cell.type === "partial" ? `Collected ${formatCurrency(cell.collected)}` :
    cell.type === "unpaid" ? "Overdue · uncollected" :
    cell.type === "projected" ? "Proj. · pending renewal" : "Not yet due";
  return (
    <div className={`${base} ${CELL_STYLE[cell.type]}`}>
      <div className="text-sm font-semibold tabular-nums">{formatCurrency(cell.amount)}</div>
      {cell.invoiceNumber ? (
        <Link href={`/billing?statement=${cell.statementId}`} className="block text-[10px] underline underline-offset-2 truncate">
          {cell.invoiceNumber}
        </Link>
      ) : null}
      <div className="text-[10px] opacity-80">{label}</div>
    </div>
  );
}

function TotalCell({ amount, owed }: { amount: number; owed: number }) {
  return (
    <div className="min-w-[130px] px-2 py-1.5 text-right">
      <div className="text-sm font-semibold tabular-nums">{formatCurrency(amount)}</div>
      {owed > 0 ? <div className="text-[10px] font-medium text-red-600">{formatCurrency(owed)} due</div> : null}
    </div>
  );
}

function ContractRow({ row }: { row: ReconciliationContractRow }) {
  return (
    <tr className="border-b hover:bg-slate-50">
      <td className="sticky left-0 z-10 bg-white border-r px-3 py-2 align-top min-w-[128px]">
        <div className="font-mono text-xs font-semibold text-primary">{row.contractNumber}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{row.status}</div>
      </td>
      <td className="sticky left-[128px] z-10 bg-white border-r px-3 py-2 align-top min-w-[210px]">
        <Link href={`/contracts/${row.id}`} className="flex items-center gap-1 font-semibold text-sm hover:text-primary hover:underline">
          {row.companyName}
          <ExternalLink className="h-2.5 w-2.5 opacity-50" />
        </Link>
        {row.isRenewal && row.parentContractNumber ? (
          <Link href={`/contracts/${row.parentContractId}`} className="mt-1 inline-block rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
            &uarr; renewal of {row.parentContractNumber}
          </Link>
        ) : null}
      </td>
      <td className="sticky left-[338px] z-10 bg-white border-r px-1.5 py-1.5 align-top min-w-[140px] shadow-[4px_0_8px_-6px_rgba(0,0,0,0.15)]">
        {row.carriedForward.amount > 0 ? (
          <TotalCell amount={row.carriedForward.amount} owed={row.carriedForward.owed} />
        ) : (
          <div className="px-2 py-1 text-right text-xs text-muted-foreground">—</div>
        )}
      </td>
      {row.cells.map((cell, i) => (
        <td key={i} className="px-1.5 py-1.5 align-top">
          <Cell cell={cell} />
        </td>
      ))}
      <td className="sticky right-0 z-10 bg-white border-l px-1.5 py-1.5 align-top shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.15)]">
        <TotalCell amount={row.rowTotalAmount} owed={row.rowTotalOwed} />
      </td>
    </tr>
  );
}

export default function BillingReconciliationPage() {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch("/api/accounting/billing-reconciliation")
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to load (${res.status})`);
        }
        return res.json();
      })
      .then((data: ReconciliationReport) => setReport(data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/accounting/billing-reconciliation/export");
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+)"/);
      a.download = match?.[1] || "billing-reconciliation.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <PageBreadcrumb resetTo={{ label: "Recurring Contract Billing Reconciliation" }} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Recurring Contract Billing Reconciliation</h1>
          <p className="text-muted-foreground text-sm max-w-2xl">
            One row per contract, one column per month — what should be billed, what was invoiced, and what&apos;s been collected, grouped by center.
            Any unpaid balance older than the 12-month window shows in <strong>Carried Fwd</strong> instead of quietly scrolling out of view.
          </p>
        </div>
        <Button onClick={handleExport} disabled={exporting || !report}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export .xlsx
        </Button>
      </div>

      {loading ? (
        <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</CardContent></Card>
      ) : error ? (
        <Card><CardContent className="p-6 text-sm text-red-600">{error}</CardContent></Card>
      ) : !report || report.groups.length === 0 ? (
        <EmptyState icon={FileSpreadsheet} title="No billable contracts" description="Nothing active, renewal-in-progress, or recently lapsed with an outstanding balance." />
      ) : (
        <>
          <Card>
            <CardContent className="p-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {LEGEND.map((l) => (
                <div key={l.type} className="flex items-center gap-1.5">
                  <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${CELL_STYLE[l.type]}`} />
                  {l.label}
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="rounded-lg border bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="border-collapse w-max min-w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="sticky left-0 z-20 bg-slate-50 border-r px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground min-w-[128px]">Contract</th>
                    <th className="sticky left-[128px] z-20 bg-slate-50 border-r px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground min-w-[210px]">Company</th>
                    <th
                      title="Unpaid/partial balance from before this 12-month window"
                      className="sticky left-[338px] z-20 bg-slate-50 border-r px-1.5 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground min-w-[140px] shadow-[4px_0_8px_-6px_rgba(0,0,0,0.15)]"
                    >
                      Carried Fwd
                    </th>
                    {report.months.map((m, i) => (
                      <th key={i} className="px-1.5 py-2 text-right text-xs font-semibold text-muted-foreground min-w-[130px]">{monthLabel(m.month, m.year)}</th>
                    ))}
                    <th className="sticky right-0 z-20 bg-slate-50 border-l px-1.5 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground min-w-[130px]">12-Mo Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.groups.map((group) => (
                    <Fragment key={group.locationName}>
                      <tr className="bg-blue-50/60 border-y border-blue-100">
                        <td colSpan={3} className="sticky left-0 z-10 bg-blue-50/60 px-3 py-1.5 text-xs font-bold text-blue-800 shadow-[4px_0_8px_-6px_rgba(0,0,0,0.1)]">
                          {group.locationName} <span className="font-normal text-blue-600">&middot; {group.contracts.length} contract{group.contracts.length === 1 ? "" : "s"}</span>
                        </td>
                        <td colSpan={report.months.length} />
                        <td className="sticky right-0 z-10 bg-blue-50/60" />
                      </tr>
                      {group.contracts.map((row) => <ContractRow key={row.id} row={row} />)}
                      <tr className="border-b-2 bg-slate-50/70">
                        <td colSpan={2} className="sticky left-0 z-10 bg-slate-50/70 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                          {group.locationName} total
                        </td>
                        <td className="sticky left-[338px] z-10 bg-slate-50/70 px-1.5 py-1 shadow-[4px_0_8px_-6px_rgba(0,0,0,0.1)]">
                          <TotalCell amount={group.carriedForwardTotal.amount} owed={group.carriedForwardTotal.owed} />
                        </td>
                        {group.monthlyTotals.map((t, i) => (
                          <td key={i} className="px-1.5 py-1"><TotalCell amount={t.amount} owed={t.owed} /></td>
                        ))}
                        <td className="sticky right-0 z-10 bg-slate-50/70 px-1.5 py-1"><TotalCell amount={group.totalAmount} owed={group.totalOwed} /></td>
                      </tr>
                    </Fragment>
                  ))}
                  <tr className="bg-slate-800">
                    <td colSpan={2} className="sticky left-0 z-10 bg-slate-800 px-3 py-2 text-sm font-bold text-white">
                      Overall total &middot; {report.groups.length} center{report.groups.length === 1 ? "" : "s"}
                    </td>
                    <td className="sticky left-[338px] z-10 bg-slate-800 px-1.5 py-1.5 text-white shadow-[4px_0_8px_-6px_rgba(0,0,0,0.3)]">
                      <div className="min-w-[140px] px-2 py-1 text-right">
                        <div className="text-sm font-semibold tabular-nums">{formatCurrency(report.overall.carriedForwardTotal.amount)}</div>
                        {report.overall.carriedForwardTotal.owed > 0 ? <div className="text-[10px] font-medium text-red-300">{formatCurrency(report.overall.carriedForwardTotal.owed)} due</div> : null}
                      </div>
                    </td>
                    {report.overall.monthlyTotals.map((t, i) => (
                      <td key={i} className="px-1.5 py-1.5 text-white">
                        <div className="min-w-[130px] px-2 py-1 text-right">
                          <div className="text-sm font-semibold tabular-nums">{formatCurrency(t.amount)}</div>
                          {t.owed > 0 ? <div className="text-[10px] font-medium text-red-300">{formatCurrency(t.owed)} due</div> : null}
                        </div>
                      </td>
                    ))}
                    <td className="sticky right-0 z-10 bg-slate-800 px-1.5 py-1.5 text-white">
                      <div className="min-w-[130px] px-2 py-1 text-right">
                        <div className="text-sm font-semibold tabular-nums">{formatCurrency(report.overall.totalAmount)}</div>
                        {report.overall.totalOwed > 0 ? <div className="text-[10px] font-medium text-red-300">{formatCurrency(report.overall.totalOwed)} due</div> : null}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
