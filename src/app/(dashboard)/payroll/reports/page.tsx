"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { TN_PT_SLABS } from "@/lib/constants";
import type { PayrollRun, PayrollSlip } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function PayrollReportsPage() {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [slips, setSlips] = useState<PayrollSlip[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingSlips, setLoadingSlips] = useState(false);

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      const res = await fetch("/api/payroll/runs");
      const { data } = await res.json();
      setRuns(data ?? []);
      if (data?.length > 0) setSelectedRunId(data[0].id);
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  const loadSlips = useCallback(async (runId: string) => {
    if (!runId) return;
    setLoadingSlips(true);
    try {
      const res = await fetch(`/api/payroll/runs/${runId}`);
      const json = await res.json();
      if (!res.ok) { toast.error("Failed to load slips"); return; }
      setSlips(json.slips ?? []);
    } finally {
      setLoadingSlips(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { if (selectedRunId) loadSlips(selectedRunId); }, [selectedRunId, loadSlips]);

  const selectedRun = runs.find(r => r.id === selectedRunId);

  function getRunLabel(run: PayrollRun) {
    const d = new Date(run.run_month);
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function downloadPTRegister() {
    if (slips.length === 0) return;
    const header = ["Employee", "Department", "Monthly Gross", "PT Deducted", "PT Slab"];
    const rows = slips.map(s => {
      const slab = TN_PT_SLABS.find(sl => s.gross_payable <= sl.maxGross)?.label ?? "Above ₹75,000";
      return [s.employee_name, s.department ?? "", s.gross_payable, s.pt_deduction, slab];
    });
    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `pt_register_${selectedRun?.run_month?.slice(0, 7) ?? "unknown"}.csv`;
    a.click();
  }

  function downloadTDSSummary() {
    if (slips.length === 0) return;
    const header = ["Employee", "Department", "PAN", "Monthly Gross", "Annual CTC (est.)", "Monthly TDS", "Annual TDS (est.)"];
    const rows = slips
      .filter(s => s.tds_deduction > 0)
      .map(s => [
        s.employee_name,
        s.department ?? "",
        "—", // PAN not on slip — pulled from salary def separately
        s.gross_payable,
        s.gross_payable * 12,
        s.tds_deduction,
        s.tds_deduction * 12,
      ]);
    const csv = [header, ...rows].map(r => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `tds_summary_${selectedRun?.run_month?.slice(0, 7) ?? "unknown"}.csv`;
    a.click();
  }

  const totalPT = slips.reduce((s, r) => s + r.pt_deduction, 0);
  const totalTDS = slips.reduce((s, r) => s + r.tds_deduction, 0);
  const tdsEmployees = slips.filter(s => s.tds_deduction > 0).length;

  return (
    <div className="p-6 space-y-5">
      <PageBreadcrumb resetTo={{ label: "Payroll Reports" }} />
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">Payroll Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">PT register, TDS summary, and cost analytics</p>
      </div>

      {/* Run selector */}
      <div className="max-w-xs">
        <Label>Select Payroll Month</Label>
        {loadingRuns ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        ) : (
          <Select value={selectedRunId} onValueChange={setSelectedRunId}>
            <SelectTrigger><SelectValue placeholder="Select month" /></SelectTrigger>
            <SelectContent>
              {runs.map(r => <SelectItem key={r.id} value={r.id}>{getRunLabel(r)} ({r.status})</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {loadingSlips ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading slips…
        </div>
      ) : slips.length === 0 && selectedRunId ? (
        <div className="text-center text-muted-foreground py-10">No slips for this run</div>
      ) : slips.length > 0 ? (
        <Tabs defaultValue="pt">
          <TabsList>
            <TabsTrigger value="pt">PT Register</TabsTrigger>
            <TabsTrigger value="tds">TDS Summary</TabsTrigger>
            <TabsTrigger value="cost">Cost Summary</TabsTrigger>
          </TabsList>

          {/* PT Register */}
          <TabsContent value="pt" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex gap-4">
                <div className="text-sm">
                  <span className="text-muted-foreground">Total PT this month: </span>
                  <span className="font-semibold">{formatCurrency(totalPT)}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Remittance due half-yearly to Tamil Nadu Govt
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={downloadPTRegister}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Department</th>
                    <th className="text-right px-4 py-2.5 font-medium">Monthly Gross</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Slab</th>
                    <th className="text-right px-4 py-2.5 font-medium">PT Deducted</th>
                  </tr>
                </thead>
                <tbody>
                  {slips.map(slip => {
                    const slab = TN_PT_SLABS.find(sl => slip.gross_payable <= sl.maxGross)?.label ?? "Above ₹75,000";
                    return (
                      <tr key={slip.id} className="border-t hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium">{slip.employee_name}</td>
                        <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">{slip.department ?? "—"}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatCurrency(slip.gross_payable)}</td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">{slab}</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrency(slip.pt_deduction)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t bg-muted/40 font-semibold">
                    <td className="px-4 py-2.5" colSpan={2}>Total</td>
                    <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(slips.reduce((s, r) => s + r.gross_payable, 0))}</td>
                    <td className="hidden md:table-cell" />
                    <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(totalPT)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* TDS Summary */}
          <TabsContent value="tds" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex gap-4 text-sm">
                <span className="text-muted-foreground">TDS employees: </span>
                <span className="font-semibold">{tdsEmployees}</span>
                <span className="text-muted-foreground ml-2">Monthly TDS: </span>
                <span className="font-semibold">{formatCurrency(totalTDS)}</span>
              </div>
              <Button variant="outline" size="sm" onClick={downloadTDSSummary}>
                <Download className="h-4 w-4 mr-2" /> Export CSV
              </Button>
            </div>
            {tdsEmployees === 0 ? (
              <div className="text-center text-muted-foreground py-8 border rounded-lg">No employees with TDS this month</div>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                      <th className="text-right px-4 py-2.5 font-medium">Monthly Gross</th>
                      <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Annual CTC (est.)</th>
                      <th className="text-right px-4 py-2.5 font-medium">Monthly TDS</th>
                      <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">Annual TDS (est.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slips.filter(s => s.tds_deduction > 0).map(slip => (
                      <tr key={slip.id} className="border-t hover:bg-muted/20">
                        <td className="px-4 py-3 font-medium">{slip.employee_name}</td>
                        <td className="px-4 py-3 text-right font-mono">{formatCurrency(slip.gross_payable)}</td>
                        <td className="px-4 py-3 text-right font-mono hidden sm:table-cell">{formatCurrency(slip.gross_payable * 12)}</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrency(slip.tds_deduction)}</td>
                        <td className="px-4 py-3 text-right font-mono hidden md:table-cell">{formatCurrency(slip.tds_deduction * 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* Cost Summary */}
          <TabsContent value="cost" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: "Total Gross", value: slips.reduce((s, r) => s + r.gross_payable, 0) },
                { label: "Total PT", value: totalPT },
                { label: "Total TDS", value: totalTDS },
                { label: "LOP Deductions", value: slips.reduce((s, r) => s + r.lop_deduction, 0) },
                { label: "Total Deductions", value: slips.reduce((s, r) => s + r.total_deductions, 0) },
                { label: "Net Payable", value: slips.reduce((s, r) => s + r.net_payable, 0) },
              ].map(({ label, value }) => (
                <Card key={label} className="py-3">
                  <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-0"><p className="text-lg font-bold font-mono">{formatCurrency(value)}</p></CardContent>
                </Card>
              ))}
            </div>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                    <th className="text-right px-4 py-2.5 font-medium">Gross</th>
                    <th className="text-right px-4 py-2.5 font-medium">Deductions</th>
                    <th className="text-right px-4 py-2.5 font-medium">Net</th>
                    <th className="text-center px-4 py-2.5 font-medium hidden sm:table-cell">LOP</th>
                  </tr>
                </thead>
                <tbody>
                  {slips.map(slip => (
                    <tr key={slip.id} className="border-t hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <p className="font-medium">{slip.employee_name}</p>
                        <p className="text-xs text-muted-foreground">{slip.department ?? ""}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{formatCurrency(slip.gross_payable)}</td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">{formatCurrency(slip.total_deductions)}</td>
                      <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrency(slip.net_payable)}</td>
                      <td className="px-4 py-3 text-center hidden sm:table-cell">
                        {slip.lop_days > 0
                          ? <span className="text-red-600 font-semibold text-xs">{slip.lop_days}d</span>
                          : <span className="text-muted-foreground text-xs">—</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
