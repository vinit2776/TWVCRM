"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Play, Eye, Loader2, FileSpreadsheet, Users, IndianRupee } from "lucide-react";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PAYROLL_RUN_STATUS_COLORS, PAYROLL_RUN_STATUS_LABELS } from "@/lib/constants";
import type { PayrollRun } from "@/types";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function PayrollRunsPage() {
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const now = new Date();
  const [genYear, setGenYear] = useState(now.getFullYear());
  const [genMonth, setGenMonth] = useState(now.getMonth() + 1); // 1-indexed

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/payroll/runs");
      const { data } = await res.json();
      setRuns(data ?? []);
    } catch {
      toast.error("Failed to load payroll runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const res = await fetch("/api/payroll/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: genYear, month: genMonth }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Generation failed"); return; }
      const d = json.data;
      toast.success(`Payroll generated: ${d.employee_count} employees${d.skipped?.length ? `, ${d.skipped.length} skipped (no salary definition)` : ""}`);
      setGenerateOpen(false);
      loadRuns();
    } finally {
      setGenerating(false);
    }
  }

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - 2 + i);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payroll Runs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Generate, review, and finalize monthly salary runs</p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Play className="h-4 w-4 mr-2" /> Generate Payroll
        </Button>
      </div>

      {/* Stats */}
      {runs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Runs", value: runs.length },
            { label: "Finalized", value: runs.filter(r => r.status === "finalized").length },
            { label: "Draft", value: runs.filter(r => r.status === "draft").length },
            {
              label: "Last Run Gross",
              value: formatCurrency(runs[0]?.total_gross ?? 0),
            },
          ].map(s => (
            <Card key={s.label} className="py-3">
              <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">{s.label}</CardTitle></CardHeader>
              <CardContent className="px-4 pb-0"><p className="text-xl font-bold">{s.value}</p></CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : runs.length === 0 ? (
        <div className="border rounded-lg p-10 text-center text-muted-foreground">
          <FileSpreadsheet className="h-8 w-8 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No payroll runs yet</p>
          <p className="text-sm mt-1">Click &quot;Generate Payroll&quot; to create the first run</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Month</th>
                <th className="text-center px-4 py-2.5 font-medium hidden sm:table-cell">Employees</th>
                <th className="text-right px-4 py-2.5 font-medium">Total Gross</th>
                <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">Deductions</th>
                <th className="text-right px-4 py-2.5 font-medium">Net Payable</th>
                <th className="text-center px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Finalized</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const d = new Date(run.run_month);
                const label = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
                return (
                  <tr key={run.id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">{label}</td>
                    <td className="px-4 py-3 text-center hidden sm:table-cell">
                      <span className="flex items-center justify-center gap-1">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        {run.employee_count}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{formatCurrency(run.total_gross)}</td>
                    <td className="px-4 py-3 text-right font-mono hidden md:table-cell text-muted-foreground">{formatCurrency(run.total_deductions)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">{formatCurrency(run.total_net)}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge className={`text-xs ${PAYROLL_RUN_STATUS_COLORS[run.status]}`}>
                        {PAYROLL_RUN_STATUS_LABELS[run.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground text-xs">
                      {run.finalized_at
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        ? `${formatDate(run.finalized_at)} by ${(run as any).finalizer?.full_name ?? "—"}`
                        : "—"
                      }
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/payroll/runs/${run.id}`}><Eye className="h-3.5 w-3.5 mr-1" />View</Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Generate Dialog */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><IndianRupee className="h-4 w-4" />Generate Payroll Run</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Month</Label>
                <Select value={String(genMonth)} onValueChange={v => setGenMonth(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Year</Label>
                <Select value={String(genYear)} onValueChange={v => setGenYear(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Attendance will be pulled from COSEC access logs. Leave data from approved requests.
              If a run already exists for this month it will be regenerated in draft state.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
