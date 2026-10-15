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
import { checkConvertToService, cycle1Period, suggestConversion } from "@/lib/procurement/convert-to-service";

export interface ConvertBill {
  id: string;
  bill_number: string;
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
  const liveBills = useMemo(() => bills.filter((b) => b.approval_status !== "rejected" && !b.service_report_id), [bills]);

  const [cycle, setCycle] = useState<ServicePoBillingCycle>("yearly");
  const [count, setCount] = useState("1");
  const [billId, setBillId] = useState("none");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const s = suggestConversion({
      total: po.total_ordered_amount,
      amcStart: po.amc_start_date,
      amcEnd: po.amc_end_date,
      liveBillAmounts: bills.filter((b) => b.approval_status !== "rejected").map((b) => Number(b.total_amount)),
    });
    setCycle(s.billingCycle);
    setCount(String(s.cycleCount));
    const approved = liveBills.find((b) => b.approval_status === "approved");
    setBillId(approved?.id ?? "none");
    const p = cycle1Period(po.amc_start_date, s.billingCycle);
    setFrom(p?.from ?? "");
    setTo(p?.to ?? "");
  // Re-seed only when the dialog opens for a PO, not on every edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, po.id]);

  const changeCycle = (c: ServicePoBillingCycle) => {
    setCycle(c);
    const n = cyclesBetween(po.amc_start_date, po.amc_end_date, c);
    if (n) setCount(String(n));
    const p = cycle1Period(po.amc_start_date, c);
    if (p) { setFrom(p.from); setTo(p.to); }
  };

  const chosen = billId === "none" ? null : liveBills.find((b) => b.id === billId) ?? null;
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
    bill: chosen ? { po_id: po.id, service_report_id: null, approval_status: chosen.approval_status, total_amount: chosen.total_amount } : null,
    poId: po.id,
    cycle1From: from,
    cycle1To: to,
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
          bill_id: chosen?.id ?? null,
          cycle1_from: chosen ? from : null,
          cycle1_to: chosen ? to : null,
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

          <div className="space-y-1.5">
            <Label>Invoice that belongs to cycle 1</Label>
            <Select value={billId} onValueChange={setBillId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None, convert without one</SelectItem>
                {liveBills.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.bill_number} · {formatCurrency(b.total_amount)} · {b.approval_status === "approved" ? "approved" : "pending"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {chosen && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Cycle 1 from</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Cycle 1 to</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          )}

          {verdict.ok ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm space-y-1">
              <p className="font-medium">What will change</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                <li>Becomes a service PO: {BILLING_CYCLE_LABELS[cycle]}, {count} × {formatCurrency(verdict.unitCost)}, status Ordered.</li>
                {chosen
                  ? <li>Cycle 1 report ({formatDate(from)} – {formatDate(to)}) is created and {chosen.bill_number} is tied to it. It keeps its approval and payment status.</li>
                  : <li>No cycle 1 report is created. You record reports from the PO page.</li>}
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
