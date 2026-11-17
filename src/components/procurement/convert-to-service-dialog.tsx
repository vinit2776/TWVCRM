"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { checkConvertToService, suggestAssignments, suggestConversion } from "@/lib/procurement/convert-to-service";
import { cycleSchedule } from "@/lib/procurement/amc-running";

export interface ConvertBill {
  id: string;
  bill_number: string;
  invoice_date?: string | null;
  total_amount: number;
  approval_status: string;
  service_report_id?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  po: {
    id: string;
    po_number: string;
    po_type: string;
    status: string;
    total_ordered_amount: number;
    amc_start_date?: string | null;
    amc_end_date?: string | null;
    amc_terminated_at?: string | null;
  };
  bills: ConvertBill[];
  onDone: () => void;
}

const CYCLES = Object.keys(BILLING_CYCLE_LABELS).filter((c) => ["monthly", "quarterly", "half_yearly", "yearly"].includes(c)) as ServicePoBillingCycle[];

/**
 * Admin-only. Turns an AMC that was raised as a goods PO into a service contract so it gets
 * cycle billing. Nothing is guessed silently: the suggested cycle is only a starting point,
 * the preview says exactly what will change, and amounts, payments, the advance and every
 * other invoice are left alone.
 */
export function ConvertToServiceDialog({ open, onOpenChange, po, bills, onDone }: Props) {
  const liveBills = useMemo(() => bills.filter((b) => !["rejected", "withdrawn"].includes(b.approval_status) && !b.service_report_id), [bills]);

  const [cycle, setCycle] = useState<ServicePoBillingCycle>("yearly");
  const [count, setCount] = useState("1");
  /** Bill id -> the cycle it belongs to, or "none" to leave it loose. */
  const [cycleOf, setCycleOf] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const scheduleFor = (c: ServicePoBillingCycle, n: number) => cycleSchedule(po.amc_start_date ?? "", po.amc_end_date ?? "", c, n);

  const seedAssignments = (c: ServicePoBillingCycle, n: number) => {
    const guess = suggestAssignments(
      liveBills.map((b) => ({ id: b.id, sortKey: `${b.invoice_date ?? ""}|${b.bill_number}` })),
      scheduleFor(c, n)
    );
    const next: Record<string, string> = {};
    for (const b of liveBills) next[b.id] = String(guess.find((g) => g.billId === b.id)?.cycle ?? "none");
    setCycleOf(next);
  };

  useEffect(() => {
    if (!open) return;
    const s = suggestConversion({
      total: po.total_ordered_amount,
      amcStart: po.amc_start_date,
      amcEnd: po.amc_end_date,
      liveBillAmounts: bills.filter((b) => !["rejected", "withdrawn"].includes(b.approval_status)).map((b) => Number(b.total_amount)),
    });
    setCycle(s.billingCycle);
    setCount(String(s.cycleCount));
    seedAssignments(s.billingCycle, s.cycleCount);
  // Re-seed only when the dialog opens for a PO, not on every edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, po.id]);

  const changeCycle = (c: ServicePoBillingCycle) => {
    setCycle(c);
    const n = cyclesBetween(po.amc_start_date, po.amc_end_date, c) ?? Number(count);
    setCount(String(n));
    seedAssignments(c, n);
  };

  const schedule = scheduleFor(cycle, Number(count) > 0 ? Number(count) : 1);
  const assignments = liveBills.flatMap((b) => {
    const n = Number(cycleOf[b.id]);
    const period = schedule.find((p) => p.n === n);
    if (!n || !period) return [];
    return [{
      billId: b.id, cycle: n, from: period.from, to: period.to,
      bill: { po_id: po.id, service_report_id: null, approval_status: b.approval_status, total_amount: b.total_amount },
    }];
  });

  const verdict = checkConvertToService({
    role: "admin",
    po: {
      po_type: po.po_type,
      status: po.status,
      total_ordered_amount: po.total_ordered_amount,
      amc_terminated_at: po.amc_terminated_at,
      isAmc: true,
    },
    existingReports: 0,
    billingCycle: cycle,
    cycleCount: Number(count),
    serviceStart: po.amc_start_date ?? null,
    assignments,
    poId: po.id,
  });

  const submit = async () => {
    if (!verdict.ok || !po.amc_start_date) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/procurement/orders/${po.id}/convert-to-service`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billing_cycle: cycle,
          cycle_count: Number(count),
          service_start_date: po.amc_start_date,
          assignments: assignments.map((a) => ({
            bill_id: a.billId, cycle_number: a.cycle, period_from: a.from, period_to: a.to,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(typeof json.error === "string" ? json.error : "Couldn't convert this purchase order"); return; }
      toast.success(`${po.po_number} is now a service contract`);
      onOpenChange(false);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Convert {po.po_number} to a service contract</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            This AMC was raised as a goods PO, so it can&apos;t log service reports or bill by cycle. Converting gives it
            that. Amounts, payments, the advance and your other invoices are not changed.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Billing cycle</Label>
              <Select value={cycle} onValueChange={(v) => changeCycle(v as ServicePoBillingCycle)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CYCLES.map((c) => <SelectItem key={c} value={c}>{BILLING_CYCLE_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Number of cycles</Label>
              <Input type="number" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
          </div>

          {liveBills.length > 0 ? (
            <div className="space-y-2">
              <div>
                <Label>Invoices already on this PO</Label>
                <p className="text-xs text-muted-foreground">
                  Say which cycle each one belongs to. They keep their approval and payment status; nothing new is created for them.
                </p>
              </div>
              <div className="rounded-lg border divide-y">
                {liveBills.map((b) => {
                  const dupAmount = liveBills.some((o) => o.id !== b.id && Math.abs(Number(o.total_amount) - Number(b.total_amount)) < 0.01);
                  return (
                    <div key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-xs">{b.bill_number}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCurrency(b.total_amount)} · {b.approval_status === "approved" ? "approved" : "pending"}
                          {b.invoice_date ? ` · ${formatDate(b.invoice_date)}` : ""}
                          {dupAmount && <span className="text-amber-700"> · same amount as another invoice, check it is not a copy</span>}
                        </p>
                      </div>
                      <Select value={cycleOf[b.id] ?? "none"} onValueChange={(v) => setCycleOf((prev) => ({ ...prev, [b.id]: v }))}>
                        <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Leave out</SelectItem>
                          {schedule.map((p) => (
                            <SelectItem key={p.n} value={String(p.n)}>Cycle {p.n} · {formatDate(p.from)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">There are no invoices on this PO to tie to a cycle.</p>
          )}

          {verdict.ok ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm space-y-1">
              <p className="font-medium">What will change</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                <li>Becomes a service PO: {BILLING_CYCLE_LABELS[cycle]}, {count} × {formatCurrency(verdict.unitCost)}, status Ordered.</li>
                {assignments.length > 0
                  ? <li>{assignments.length} cycle report{assignments.length === 1 ? "" : "s"} backfilled ({[...assignments].sort((x, y) => x.cycle - y.cycle).map((a) => `cycle ${a.cycle}: ${bills.find((x) => x.id === a.billId)?.bill_number}`).join(", ")}). Each invoice keeps its approval and payment status.</li>
                  : <li>No invoice is tied to a cycle. You record reports from the PO page.</li>}
                <li>Everything else stays as it is, and an audit entry is written.</li>
              </ul>
            </div>
          ) : (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{verdict.error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !verdict.ok}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Convert to service contract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
