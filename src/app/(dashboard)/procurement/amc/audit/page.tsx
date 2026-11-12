"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Loader2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TERMINATION_REASON_MIN } from "@/lib/procurement/amc-terminate";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCurrentUser } from "@/providers/current-user-provider";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { AuditBucket, AuditIssue } from "@/lib/procurement/amc-audit";

interface AuditRow {
  id: string;
  po_number: string;
  pr_number: string | null;
  vendor: string | null;
  location: string | null;
  status: string;
  po_type: string | null;
  terminated: boolean;
  amc_start_date: string | null;
  amc_end_date: string | null;
  billing_cycle: string | null;
  cycle_count: number | null;
  opening_cycles: number;
  po_value: number;
  asset_count: number;
  visits_logged: number;
  live_bills: number;
  billed_total: number;
  paid_total: number;
  tds_total: number;
  tds_deposited: number;
  money_touched: boolean;
  chain_state: string;
  bucket: AuditBucket;
  issues: AuditIssue[];
}

interface AuditData {
  rows: AuditRow[];
  summary: { total: number; byBucket: Record<string, number>; moneyTouched: number; tdsOnChallan: number };
}

interface TerminatePlan {
  preview: boolean;
  results: Array<{ id: string; po_number: string | null; terminated: boolean; skipped_reason: string | null }>;
  summary: { requested: number; eligible: number; terminated: number; skipped: number };
}

const BUCKETS: Array<{ key: AuditBucket; label: string; hint: string; tone: string }> = [
  { key: "clean", label: "Clean", hint: "Leave alone", tone: "bg-green-100 text-green-800" },
  { key: "fixable", label: "Fix in place", hint: "Edit, convert or link assets", tone: "bg-amber-100 text-amber-800" },
  { key: "broken", label: "Retire & re-create", hint: "Cannot be fixed by editing", tone: "bg-red-100 text-red-800" },
  { key: "retired", label: "Already retired", hint: "Cancelled or terminated", tone: "bg-gray-100 text-gray-700" },
];

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export default function AmcAuditPage() {
  const { user } = useCurrentUser();
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState<AuditBucket | "all">("all");
  const [onlyMoney, setOnlyMoney] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<TerminatePlan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/procurement/amc/audit");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load the report");
      setData(json.data as AuditData);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(
    () => (data?.rows ?? []).filter((r) => (bucket === "all" || r.bucket === bucket) && (!onlyMoney || r.money_touched)),
    [data, bucket, onlyMoney]
  );

  const isAdmin = user?.role === "admin";
  const selectable = shown.filter((r) => !r.terminated && r.bucket !== "retired");
  const allShownSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const selectedRows = (data?.rows ?? []).filter((r) => selected.has(r.id));
  const selectedWithMoney = selectedRows.filter((r) => r.money_touched).length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) selectable.forEach((r) => next.delete(r.id));
      else selectable.forEach((r) => next.add(r.id));
      return next;
    });

  const callTerminate = async (preview: boolean): Promise<TerminatePlan | null> => {
    const res = await fetch("/api/procurement/amc/terminate-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ po_ids: [...selected], reason, preview }),
    });
    const json = await res.json();
    if (!res.ok) {
      const err = typeof json.error === "string" ? json.error : "Could not terminate";
      toast.error(err);
      return null;
    }
    return json.data as TerminatePlan;
  };

  const openDialog = () => {
    setPlan(null);
    setReason("");
    setDialogOpen(true);
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      setPlan(await callTerminate(true));
    } finally {
      setBusy(false);
    }
  };

  const runTerminate = async () => {
    setBusy(true);
    try {
      const done = await callTerminate(false);
      if (!done) return;
      toast.success(`Terminated ${done.summary.terminated} AMC${done.summary.terminated === 1 ? "" : "s"}${done.summary.skipped ? `, skipped ${done.summary.skipped}` : ""}`);
      setDialogOpen(false);
      setSelected(new Set());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    if (!data) return;
    const head = [
      "PO", "Request", "Vendor", "Centre", "Bucket", "Issues", "PO status", "Type", "Start", "End", "Billing", "Bills to bill here",
      "Cycles already done", "PO value", "Assets", "Visits logged", "Live bills", "Billed", "Paid", "TDS", "TDS on challan", "Lock",
    ];
    const lines = data.rows.map((r) =>
      [
        r.po_number, r.pr_number, r.vendor, r.location, r.bucket, r.issues.map((i) => i.label).join("; "), r.status, r.po_type,
        r.amc_start_date, r.amc_end_date, r.billing_cycle, r.cycle_count, r.opening_cycles, r.po_value, r.asset_count, r.visits_logged,
        r.live_bills, r.billed_total, r.paid_total, r.tds_total, r.tds_deposited, r.chain_state,
      ].map(csvCell).join(",")
    );
    const blob = new Blob([[head.map(csvCell).join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `amc-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (user?.role && !["admin", "manager", "accounts"].includes(user.role)) {
    return <div className="p-6 text-sm text-muted-foreground">This report is for admin, manager and accounts.</div>;
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageBreadcrumb current={{ label: "AMC audit" }} fallbackParent={{ href: "/procurement/amc", label: "AMC Contracts" }} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AMC audit</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every AMC checked for setup problems, with the bills, payments and TDS attached to it. Read-only: nothing here changes any record.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={openDialog}>
              <XCircle className="mr-1.5 h-4 w-4" /> Terminate selected ({selected.size})
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button size="sm" onClick={exportCsv} disabled={!data}>
            <Download className="mr-1.5 h-4 w-4" /> Download sheet
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking every AMC…</div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {BUCKETS.map((b) => (
              <button key={b.key} onClick={() => setBucket(bucket === b.key ? "all" : b.key)} className="text-left">
                <Card className={bucket === b.key ? "ring-2 ring-primary" : ""}>
                  <CardContent className="p-4">
                    <div className="text-2xl font-semibold">{data.summary.byBucket[b.key] ?? 0}</div>
                    <div className="text-sm font-medium">{b.label}</div>
                    <div className="text-xs text-muted-foreground">{b.hint}</div>
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyMoney} onChange={(e) => setOnlyMoney(e.target.checked)} />
            Only AMCs with a payment or TDS recorded ({data.summary.moneyTouched}; {data.summary.tdsOnChallan} with TDS on a challan)
          </label>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  {isAdmin && (
                    <th className="w-8 p-2">
                      <input type="checkbox" aria-label="Select all shown" checked={allShownSelected} onChange={toggleAllShown} />
                    </th>
                  )}
                  <th className="p-2">AMC</th>
                  <th className="p-2">Result</th>
                  <th className="p-2">What is wrong</th>
                  <th className="p-2">Term</th>
                  <th className="p-2 text-right">Bills / billed</th>
                  <th className="p-2 text-right">Paid</th>
                  <th className="p-2 text-right">TDS</th>
                  <th className="p-2">Lock</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const b = BUCKETS.find((x) => x.key === r.bucket)!;
                  return (
                    <tr key={r.id} className="border-t align-top">
                      {isAdmin && (
                        <td className="p-2">
                          {r.terminated || r.bucket === "retired" ? null : (
                            <input type="checkbox" aria-label={`Select ${r.po_number}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                          )}
                        </td>
                      )}
                      <td className="p-2">
                        <Link href={`/procurement/orders/${r.id}`} className="font-medium text-primary hover:underline">{r.po_number}</Link>
                        <div className="text-xs text-muted-foreground">{r.vendor ?? "No vendor"} · {r.location ?? "No centre"}</div>
                        <div className="text-xs text-muted-foreground">{r.pr_number ?? "No request"} · {r.po_type ?? "?"} · {r.asset_count} asset{r.asset_count === 1 ? "" : "s"}</div>
                      </td>
                      <td className="p-2"><Badge className={b.tone}>{b.label}</Badge></td>
                      <td className="p-2">
                        {r.issues.length === 0 ? <span className="text-muted-foreground">—</span> : (
                          <ul className="list-disc pl-4 text-xs">{r.issues.map((i) => <li key={i.code}>{i.label}</li>)}</ul>
                        )}
                      </td>
                      <td className="whitespace-nowrap p-2 text-xs">
                        {r.amc_start_date ? formatDate(r.amc_start_date) : "?"} → {r.amc_end_date ? formatDate(r.amc_end_date) : "?"}
                        <div className="text-muted-foreground">{r.billing_cycle ?? "no frequency"}{r.cycle_count ? ` · ${r.cycle_count} to bill here` : ""}{r.opening_cycles ? ` · ${r.opening_cycles} already done` : ""}</div>
                      </td>
                      <td className="whitespace-nowrap p-2 text-right text-xs">{r.live_bills} / {formatCurrency(r.billed_total)}<div className="text-muted-foreground">PO {formatCurrency(r.po_value)}</div></td>
                      <td className="whitespace-nowrap p-2 text-right text-xs">{formatCurrency(r.paid_total)}</td>
                      <td className="whitespace-nowrap p-2 text-right text-xs">{formatCurrency(r.tds_total)}{r.tds_deposited > 0 && <div className="text-muted-foreground">on challan {formatCurrency(r.tds_deposited)}</div>}</td>
                      <td className="p-2 text-xs capitalize">{r.chain_state}</td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">No AMCs match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <Dialog open={dialogOpen} onOpenChange={(o) => !busy && setDialogOpen(o)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Terminate {selected.size} AMC{selected.size === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              Ends each contract going forward. Bills, payments, TDS and visit history stay exactly as they are, and any AMC can be reinstated from its page.
            </DialogDescription>
          </DialogHeader>
          {selectedWithMoney > 0 && (
            <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              {selectedWithMoney} of these have a payment or TDS recorded. If you set the same cover up again, mark the cycles already paid as done, or the running cycle can be billed twice.
            </p>
          )}
          <Textarea
            value={reason}
            onChange={(e) => { setReason(e.target.value); setPlan(null); }}
            placeholder="Reason, kept on every AMC's history (e.g. Set up wrongly; re-creating cleanly)"
            rows={3}
          />
          {plan && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
              <div className="font-medium">{plan.summary.eligible} will be terminated, {plan.summary.skipped} skipped</div>
              {plan.results.filter((r) => r.skipped_reason).map((r) => (
                <div key={r.id} className="text-muted-foreground">{r.po_number ?? r.id}: {r.skipped_reason}</div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            {!plan ? (
              <Button onClick={runPreview} disabled={busy || reason.trim().length < TERMINATION_REASON_MIN}>
                {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Check first
              </Button>
            ) : (
              <Button variant="destructive" onClick={runTerminate} disabled={busy || plan.summary.eligible === 0}>
                {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Terminate {plan.summary.eligible}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
