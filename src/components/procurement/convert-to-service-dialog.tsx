"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { checkConvertToService, cycle1Period, cyclePeriods, suggestConversion } from "@/lib/procurement/convert-to-service";
import { invoiceFitsCycle } from "@/lib/procurement/invoice-fits-cycle";

export interface ConvertBill {
  id: string;
  /** Our internal number. People recognise the vendor's own invoice_number instead. */
  bill_number: string;
  invoice_number?: string | null;
  invoice_date?: string | null;
  total_amount: number;
  base_amount?: number | null;
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
    payment_terms?: string | null;
    notes?: string | null;
  };
  bills: ConvertBill[];
  onDone: () => void;
}

const CYCLES: ServicePoBillingCycle[] = ["monthly", "quarterly", "half_yearly", "yearly"];
const STEPS = ["Contract", "Billing", "Invoice", "Review"] as const;

const billLabel = (b: ConvertBill) => (b.invoice_number ? `Invoice ${b.invoice_number}` : b.bill_number);
const reasonText = {
  invoices: "from the invoices already on this PO",
  payment_terms: "from the PO's payment terms",
  dates: "a starting guess from the contract dates",
} as const;

/**
 * Admin-only guided setup for an AMC that was raised as a goods PO. One question per step,
 * with the PO's own notes and terms shown beside it, and a full cycle table before anything
 * is saved. Nothing is guessed silently: the suggestion says where it came from, and amounts,
 * payments, the advance and every other invoice are left alone.
 */
export function ConvertToServiceDialog({ open, onOpenChange, po, bills, onDone }: Props) {
  const liveBills = useMemo(() => bills.filter((b) => !["rejected", "withdrawn"].includes(b.approval_status) && !b.service_report_id), [bills]);

  const [step, setStep] = useState(0);
  const [cycle, setCycle] = useState<ServicePoBillingCycle>("yearly");
  const [count, setCount] = useState("1");
  const [reason, setReason] = useState<keyof typeof reasonText>("dates");
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
      liveBillAmounts: bills.filter((b) => !["rejected", "withdrawn"].includes(b.approval_status)).map((b) => Number(b.total_amount)),
      paymentTerms: po.payment_terms,
    });
    setStep(0);
    setCycle(s.billingCycle);
    setCount(String(s.cycleCount));
    setReason(s.reason);
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
    setReason("dates");
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
    bill: chosen ? { po_id: po.id, service_report_id: null, approval_status: chosen.approval_status, total_amount: chosen.total_amount, base_amount: chosen.base_amount } : null,
    poId: po.id,
    cycle1From: from,
    cycle1To: to,
  });
  const unitCost = verdict.ok ? verdict.unitCost : null;
  const periods = cyclePeriods(po.amc_start_date, cycle, Number(count));
  const fit = (b: ConvertBill) => (unitCost ? invoiceFitsCycle(b, unitCost) : null);
  const noStartDate = !po.amc_start_date;
  // Steps 1-2 only need a valid cycle plan; the invoice rules are judged on step 3.
  const plan = checkConvertToService({
    role: "admin",
    po: { po_type: po.po_type, status: po.status, total_ordered_amount: po.total_ordered_amount, amc_terminated_at: po.amc_terminated_at, isAmc: true },
    existingReports: 0, billingCycle: cycle, cycleCount: Number(count), serviceStart: po.amc_start_date ?? null, bill: null, poId: po.id,
  });
  const planOk = plan.ok;

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
      if (!res.ok) { toast.error(typeof json.error === "string" ? json.error : "Couldn't set up this AMC"); return; }
      toast.success(`${po.po_number} is now set up as an AMC service contract`);
      onOpenChange(false);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const nextDisabled =
    (step === 0 && noStartDate) ||
    (step === 1 && !planOk) ||
    (step === 2 && !verdict.ok);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {po.po_number} as an AMC</DialogTitle>
        </DialogHeader>

        <ol className="flex items-center gap-1 text-xs">
          {STEPS.map((label, i) => (
            <li key={label} className={`flex items-center gap-1 ${i === step ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
              <span className={`h-5 w-5 rounded-full border grid place-items-center text-[10px] ${i < step ? "bg-primary text-primary-foreground border-primary" : i === step ? "border-primary" : ""}`}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {label}
              {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">›</span>}
            </li>
          ))}
        </ol>

        <div className="space-y-4 py-1 min-h-[260px]">
          {step === 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                This AMC was raised as a goods PO, so it can&apos;t log service reports or bill by cycle. Check what the PO already says,
                then we&apos;ll set up how it is billed. Amounts, payments, the advance and your other invoices are not changed.
              </p>
              <dl className="rounded-lg border divide-y text-sm">
                <Row k="Contract period" v={po.amc_start_date && po.amc_end_date ? `${formatDate(po.amc_start_date)} – ${formatDate(po.amc_end_date)}` : "Not set"} />
                <Row k="PO value (before GST)" v={formatCurrency(po.total_ordered_amount)} />
                <Row k="Payment terms" v={po.payment_terms || "None recorded"} />
                {po.notes && <Row k="PO notes" v={po.notes} />}
              </dl>
              {noStartDate && (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  This PO has no contract start date. Add the AMC period on its request first; billing cycles are counted from it.
                </p>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="space-y-1.5">
                <Label>How often does the vendor bill?</Label>
                <div className="grid grid-cols-4 gap-2">
                  {CYCLES.map((c) => (
                    <Button key={c} type="button" size="sm" variant={cycle === c ? "default" : "outline"} onClick={() => changeCycle(c)}>
                      {BILLING_CYCLE_LABELS[c]}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Suggested {reasonText[reason]}. Change it if that isn&apos;t how this vendor bills.</p>
              </div>
              <div className="space-y-1.5 max-w-[10rem]">
                <Label>Number of cycles</Label>
                <Input type="number" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
              {periods.length > 0 ? (
                <table className="w-full text-xs border rounded-lg overflow-hidden">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr><th className="text-left px-2 py-1.5">Cycle</th><th className="text-left px-2 py-1.5">Period</th><th className="text-right px-2 py-1.5">Before GST</th><th className="text-right px-2 py-1.5">With 18% GST</th></tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => {
                      const per = Number(po.total_ordered_amount) / Math.max(1, periods.length);
                      return (
                        <tr key={p.n} className="border-t">
                          <td className="px-2 py-1.5">{p.n}</td>
                          <td className="px-2 py-1.5">{formatDate(p.from)} – {formatDate(p.to)}</td>
                          <td className="px-2 py-1.5 text-right">{formatCurrency(per)}</td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground">{formatCurrency(per * 1.18)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
              {!plan.ok && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{plan.error}</p>}
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-1.5">
                <Label>Which invoice is for cycle 1?</Label>
                <p className="text-xs text-muted-foreground">
                  Listed by the vendor&apos;s invoice number. An invoice that equals the cycle cost plus GST counts as a match.
                </p>
              </div>
              <div className="space-y-2">
                {liveBills.map((b) => {
                  const f = fit(b);
                  return (
                    <label key={b.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${billId === b.id ? "border-primary bg-primary/5" : ""}`}>
                      <input type="radio" className="mt-1" checked={billId === b.id} onChange={() => setBillId(b.id)} />
                      <span className="flex-1">
                        <span className="font-medium">{billLabel(b)}</span>
                        <span className="text-muted-foreground"> · {b.invoice_date ? formatDate(b.invoice_date) : "no date"} · {formatCurrency(b.total_amount)} · {b.approval_status === "approved" ? "approved" : "pending"}</span>
                        <span className="block text-[11px] text-muted-foreground">Our ref {b.bill_number}</span>
                        {f && (f.fits
                          ? <span className="block text-xs text-green-700">{f.basis === "gst_inclusive" ? `Matches one cycle (${formatCurrency(unitCost ?? 0)}) plus ${f.gstRate}% GST` : "Fits one cycle"}</span>
                          : <span className="block text-xs text-amber-700">Doesn&apos;t match one cycle ({formatCurrency(unitCost ?? 0)}), with or without GST</span>)}
                      </span>
                    </label>
                  );
                })}
                <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${billId === "none" ? "border-primary bg-primary/5" : ""}`}>
                  <input type="radio" checked={billId === "none"} onChange={() => setBillId("none")} />
                  None of these. Set up without tying an invoice
                </label>
              </div>
              {chosen && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label>Cycle 1 from</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                  <div className="space-y-1.5"><Label>Cycle 1 to</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
                </div>
              )}
              {!verdict.ok && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{verdict.error}</p>}
            </>
          )}

          {step === 3 && verdict.ok && (
            <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm space-y-1">
              <p className="font-medium">What will change</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                <li>Becomes a service PO: {BILLING_CYCLE_LABELS[cycle]}, {count} × {formatCurrency(verdict.unitCost)} before GST, status Ordered.</li>
                {chosen
                  ? <li>Cycle 1 report ({formatDate(from)} – {formatDate(to)}) is created and {billLabel(chosen)} is tied to it. It keeps its approval and payment status.</li>
                  : <li>No cycle 1 report is created. You record reports from the PO page.</li>}
                <li>Everything else stays as it is, and an audit entry is written.</li>
              </ul>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}>
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={nextDisabled}>Next</Button>
          ) : (
            <Button onClick={submit} disabled={saving || !verdict.ok}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Set up AMC
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground shrink-0">{k}</dt>
      <dd className="font-medium text-right">{v}</dd>
    </div>
  );
}
