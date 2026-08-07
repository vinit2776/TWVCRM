"use client";

import { use, useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ChevronLeft, Lock, Loader2, Download, Pencil, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PAYROLL_RUN_STATUS_COLORS, PAYROLL_RUN_STATUS_LABELS } from "@/lib/constants";
import type { PayrollRun, PayrollSlip } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function PayrollRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [run, setRun] = useState<PayrollRun | null>(null);
  const [slips, setSlips] = useState<PayrollSlip[]>([]);
  const [loading, setLoading] = useState(true);
  const [finalizing, setFinalizing] = useState(false);

  // Override dialog
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideSlip, setOverrideSlip] = useState<PayrollSlip | null>(null);
  const [overrideLTA, setOverrideLTA] = useState(0);
  const [overrideOther, setOverrideOther] = useState(0);
  const [overrideNote, setOverrideNote] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/payroll/runs/${id}`);
      const json = await res.json();
      if (!res.ok) { toast.error("Failed to load run"); return; }
      setRun(json.run);
      setSlips(json.slips ?? []);
    } catch {
      toast.error("Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleFinalize() {
    if (!confirm("Finalize this payroll run? All slips will be locked and cannot be edited.")) return;
    setFinalizing(true);
    try {
      const res = await fetch(`/api/payroll/runs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize" }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Finalize failed"); return; }
      toast.success("Payroll run finalized");
      loadData();
    } finally {
      setFinalizing(false);
    }
  }

  function openOverride(slip: PayrollSlip) {
    setOverrideSlip(slip);
    setOverrideLTA(slip.lta_this_month);
    setOverrideOther(slip.other_deductions);
    setOverrideNote(slip.override_note ?? "");
    setOverrideOpen(true);
  }

  async function handleSaveOverride() {
    if (!overrideSlip) return;
    if (!overrideNote.trim()) { toast.error("Override note is required"); return; }
    setSavingOverride(true);
    try {
      const res = await fetch(`/api/payroll/slips/${overrideSlip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lta_this_month: overrideLTA, other_deductions: overrideOther, override_note: overrideNote }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Save failed"); return; }
      toast.success("Slip updated");
      setOverrideOpen(false);
      loadData();
    } finally {
      setSavingOverride(false);
    }
  }

  function exportCsv() {
    if (!run || slips.length === 0) return;
    const d = new Date(run.run_month);
    const header = [
      "Employee", "Department", "Designation",
      "Working Days", "Present", "CL", "SL", "LOP",
      "Basic", "HRA", "DA", "Special Allowance", "Mobile", "Other Reimb.", "LTA",
      "Gross Payable",
      "LOP Deduction", "PT", "TDS", "PF (Emp)", "ESI (Emp)", "Other Deductions", "Total Deductions",
      "Net Payable",
      "Override Note",
    ];
    const rows = slips.map(s => [
      s.employee_name, s.department ?? "", s.designation ?? "",
      s.working_days, s.days_present, s.cl_days, s.sl_days, s.lop_days,
      s.basic, s.hra, s.da, s.special_allowance, s.mobile_reimbursement, s.other_reimbursements, s.lta_this_month,
      s.gross_payable,
      s.lop_deduction, s.pt_deduction, s.tds_deduction, s.pf_employee, s.esi_employee, s.other_deductions, s.total_deductions,
      s.net_payable,
      s.override_note ?? "",
    ]);
    const esc = (v: string | number) => { const s = String(v); return s.includes(",") ? `"${s}"` : s; };
    const csv = [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `payroll_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}.csv`;
    a.click();
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-muted-foreground p-10 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }
  if (!run) return <div className="p-10 text-center text-muted-foreground">Run not found</div>;

  const d = new Date(run.run_month);
  const monthLabel = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const isDraft = run.status === "draft";

  return (
    <div className="p-6 space-y-5">
      <PageBreadcrumb
        current={{ label: monthLabel }}
        fallbackParent={{ href: "/payroll/runs", label: "Payroll Runs" }}
      />
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/payroll/runs"><ChevronLeft className="h-4 w-4" />Payroll Runs</Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold">{monthLabel}</h1>
            <Badge className={`text-xs ${PAYROLL_RUN_STATUS_COLORS[run.status]}`}>
              {PAYROLL_RUN_STATUS_LABELS[run.status]}
            </Badge>
          </div>
          {run.finalized_at && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Finalized on {formatDate(run.finalized_at)}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {(run as any).finalizer?.full_name ? ` by ${(run as any).finalizer.full_name}` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
          {isDraft && (
            <Button onClick={handleFinalize} disabled={finalizing}>
              {finalizing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
              Finalize Run
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Employees", value: run.employee_count },
          { label: "Total Gross", value: formatCurrency(run.total_gross) },
          { label: "Total Deductions", value: formatCurrency(run.total_deductions) },
          { label: "Net Payable", value: formatCurrency(run.total_net) },
        ].map(s => (
          <Card key={s.label} className="py-3">
            <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">{s.label}</CardTitle></CardHeader>
            <CardContent className="px-4 pb-0"><p className="text-xl font-bold">{s.value}</p></CardContent>
          </Card>
        ))}
      </div>

      {isDraft && (
        <div className="flex items-center gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          This run is in draft. Review and adjust slips before finalizing. Finalization locks all slips.
        </div>
      )}

      {/* Slips table */}
      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Employee</th>
              <th className="text-center px-3 py-2.5 font-medium">W.Days</th>
              <th className="text-center px-3 py-2.5 font-medium">Present</th>
              <th className="text-center px-3 py-2.5 font-medium">CL</th>
              <th className="text-center px-3 py-2.5 font-medium">SL</th>
              <th className="text-center px-3 py-2.5 font-medium">LOP</th>
              <th className="text-right px-3 py-2.5 font-medium">Gross</th>
              <th className="text-right px-3 py-2.5 font-medium">PT</th>
              <th className="text-right px-3 py-2.5 font-medium">TDS</th>
              <th className="text-right px-3 py-2.5 font-medium">LOP Ded.</th>
              <th className="text-right px-3 py-2.5 font-medium">Other Ded.</th>
              <th className="text-right px-4 py-2.5 font-medium">Net</th>
              {isDraft && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {slips.map(slip => (
              <tr key={slip.id} className={`border-t hover:bg-muted/20 transition-colors ${slip.override_note ? "bg-blue-50/30" : ""}`}>
                <td className="px-4 py-3">
                  <p className="font-medium">{slip.employee_name}</p>
                  <p className="text-xs text-muted-foreground">{slip.department ?? ""}</p>
                  {slip.override_note && <p className="text-xs text-blue-600 mt-0.5">✏ {slip.override_note}</p>}
                </td>
                <td className="px-3 py-3 text-center font-mono text-xs">{slip.working_days}</td>
                <td className="px-3 py-3 text-center font-mono text-xs">{slip.days_present}</td>
                <td className="px-3 py-3 text-center font-mono text-xs">{slip.cl_days}</td>
                <td className="px-3 py-3 text-center font-mono text-xs">{slip.sl_days}</td>
                <td className={`px-3 py-3 text-center font-mono text-xs ${slip.lop_days > 0 ? "text-red-600 font-semibold" : ""}`}>{slip.lop_days}</td>
                <td className="px-3 py-3 text-right font-mono text-xs">{formatCurrency(slip.gross_payable)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">{formatCurrency(slip.pt_deduction)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">{formatCurrency(slip.tds_deduction)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">{formatCurrency(slip.lop_deduction)}</td>
                <td className="px-3 py-3 text-right font-mono text-xs text-muted-foreground">{formatCurrency(slip.other_deductions + slip.lta_this_month)}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrency(slip.net_payable)}</td>
                {isDraft && (
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="sm" onClick={() => openOverride(slip)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {slips.length === 0 && (
              <tr><td colSpan={13} className="px-4 py-10 text-center text-muted-foreground">No slips generated</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Override dialog */}
      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Override — {overrideSlip?.employee_name}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>LTA This Month</Label>
              <div className="relative">
                <span className="absolute left-2.5 top-2.5 text-muted-foreground text-sm">₹</span>
                <Input type="number" min={0} className="pl-6" value={overrideLTA} onChange={e => setOverrideLTA(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
            <div>
              <Label>Other Deductions</Label>
              <div className="relative">
                <span className="absolute left-2.5 top-2.5 text-muted-foreground text-sm">₹</span>
                <Input type="number" min={0} className="pl-6" value={overrideOther} onChange={e => setOverrideOther(parseFloat(e.target.value) || 0)} />
              </div>
            </div>
            <div>
              <Label>Override Note *</Label>
              <Textarea rows={2} placeholder="Reason for override…" value={overrideNote} onChange={e => setOverrideNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveOverride} disabled={savingOverride}>
              {savingOverride ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
