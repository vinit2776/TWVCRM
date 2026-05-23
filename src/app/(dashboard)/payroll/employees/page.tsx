"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Search, Plus, Pencil, Loader2, IndianRupee, Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { monthlyGross, calculatePT } from "@/lib/payroll";
import type { Employee, SalaryDefinition } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmployeeWithSalary extends Employee {
  employee_salary_definitions: SalaryDefinition[] | null;
}

const EMPTY_FORM = {
  employee_id: "",
  effective_from: new Date().toISOString().slice(0, 10),
  basic: 0,
  hra: 0,
  da: 0,
  special_allowance: 0,
  lta_annual: 0,
  mobile_reimbursement: 0,
  other_reimbursements: 0,
  tds_applicable: false,
  tds_monthly_amount: 0,
  pan_number: "",
  pf_applicable: false,
  esi_applicable: false,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function PayrollEmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeWithSalary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [selectedEmp, setSelectedEmp] = useState<EmployeeWithSalary | null>(null);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, defRes] = await Promise.all([
        fetch("/api/employees"),
        fetch("/api/payroll/salary-definitions"),
      ]);
      const { data: empData } = await empRes.json();
      const { data: defData } = await defRes.json();

      // Merge salary defs into employee list
      const defMap = new Map<string, SalaryDefinition>();
      if (defData) {
        for (const d of defData) defMap.set(d.employee_id, d);
      }
      const merged: EmployeeWithSalary[] = (empData ?? []).map((e: Employee) => ({
        ...e,
        employee_salary_definitions: defMap.has(e.id) ? [defMap.get(e.id)!] : null,
      }));
      setEmployees(merged);
    } catch {
      toast.error("Failed to load employees");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  function openEdit(emp: EmployeeWithSalary) {
    setSelectedEmp(emp);
    const def = emp.employee_salary_definitions?.[0];
    setForm(def
      ? {
          employee_id: emp.id,
          effective_from: def.effective_from,
          basic: def.basic,
          hra: def.hra,
          da: def.da,
          special_allowance: def.special_allowance,
          lta_annual: def.lta_annual,
          mobile_reimbursement: def.mobile_reimbursement,
          other_reimbursements: def.other_reimbursements,
          tds_applicable: def.tds_applicable,
          tds_monthly_amount: def.tds_monthly_amount,
          pan_number: def.pan_number ?? "",
          pf_applicable: def.pf_applicable,
          esi_applicable: def.esi_applicable,
        }
      : { ...EMPTY_FORM, employee_id: emp.id }
    );
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/payroll/salary-definitions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          pan_number: form.pan_number || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Save failed"); return; }
      toast.success("Salary definition saved");
      setDialogOpen(false);
      loadEmployees();
    } finally {
      setSaving(false);
    }
  }

  const filtered = employees.filter(e =>
    !search ||
    e.full_name.toLowerCase().includes(search.toLowerCase()) ||
    e.department?.toLowerCase().includes(search.toLowerCase())
  );

  const hasDef = (e: EmployeeWithSalary) => (e.employee_salary_definitions?.length ?? 0) > 0;

  const preview = hasDef(selectedEmp ?? ({} as EmployeeWithSalary)) || form.basic > 0
    ? { gross: monthlyGross(form as Parameters<typeof monthlyGross>[0]), pt: calculatePT(monthlyGross(form as Parameters<typeof monthlyGross>[0])) }
    : null;

  const gross = preview?.gross ?? 0;
  const pt = preview?.pt ?? 0;

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Salary Setup</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Define monthly salary components for each employee</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="py-3">
          <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">Total Employees</CardTitle></CardHeader>
          <CardContent className="px-4 pb-0"><p className="text-2xl font-bold">{employees.filter(e => e.is_active).length}</p></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">Salary Defined</CardTitle></CardHeader>
          <CardContent className="px-4 pb-0"><p className="text-2xl font-bold text-green-600">{employees.filter(hasDef).length}</p></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">Pending Setup</CardTitle></CardHeader>
          <CardContent className="px-4 pb-0"><p className="text-2xl font-bold text-amber-600">{employees.filter(e => e.is_active && !hasDef(e)).length}</p></CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="pb-0 pt-0 px-4"><CardTitle className="text-xs text-muted-foreground">Total Monthly Gross</CardTitle></CardHeader>
          <CardContent className="px-4 pb-0">
            <p className="text-2xl font-bold">
              {formatCurrency(employees.filter(hasDef).reduce((s, e) => s + monthlyGross((e.employee_salary_definitions![0]) as Parameters<typeof monthlyGross>[0]), 0))}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search employees…" className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Employee</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Department</th>
                <th className="text-right px-4 py-2.5 font-medium">Basic</th>
                <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">Monthly Gross</th>
                <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">PT</th>
                <th className="text-right px-4 py-2.5 font-medium hidden lg:table-cell">TDS</th>
                <th className="text-center px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(emp => {
                const def = emp.employee_salary_definitions?.[0];
                const gross = def ? monthlyGross(def as Parameters<typeof monthlyGross>[0]) : 0;
                const pt = def ? calculatePT(gross) : 0;
                return (
                  <tr key={emp.id} className="border-t hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium">{emp.full_name}</p>
                      <p className="text-xs text-muted-foreground">{emp.designation ?? "—"}</p>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">{emp.department ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-mono">{def ? formatCurrency(def.basic) : "—"}</td>
                    <td className="px-4 py-3 text-right font-mono hidden md:table-cell">{def ? formatCurrency(gross) : "—"}</td>
                    <td className="px-4 py-3 text-right font-mono hidden md:table-cell text-muted-foreground">{def ? formatCurrency(pt) : "—"}</td>
                    <td className="px-4 py-3 text-right font-mono hidden lg:table-cell text-muted-foreground">
                      {def ? (def.tds_applicable ? formatCurrency(def.tds_monthly_amount) : "—") : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {hasDef(emp)
                        ? <Badge className="bg-green-50 text-green-700 border-green-200 text-xs">Configured</Badge>
                        : <Badge className="bg-amber-50 text-amber-700 border-amber-200 text-xs">Pending</Badge>
                      }
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(emp)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" />
                        {hasDef(emp) ? "Edit" : "Setup"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">No employees found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IndianRupee className="h-4 w-4" />
              Salary Definition — {selectedEmp?.full_name}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Effective from */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Effective From</Label>
                <Input type="date" value={form.effective_from} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} />
              </div>
              <div>
                <Label>PAN Number</Label>
                <Input placeholder="ABCDE1234F" value={form.pan_number} onChange={e => setForm(f => ({ ...f, pan_number: e.target.value.toUpperCase() }))} />
              </div>
            </div>

            {/* Earnings */}
            <div>
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Monthly Earnings</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { key: "basic", label: "Basic" },
                  { key: "hra", label: "HRA" },
                  { key: "da", label: "DA" },
                  { key: "special_allowance", label: "Special Allowance" },
                  { key: "mobile_reimbursement", label: "Mobile Reimbursement" },
                  { key: "other_reimbursements", label: "Other Reimbursements" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <Label>{label}</Label>
                    <div className="relative">
                      <span className="absolute left-2.5 top-2.5 text-muted-foreground text-sm">₹</span>
                      <Input
                        type="number"
                        min={0}
                        className="pl-6"
                        value={form[key as keyof typeof form] as number}
                        onChange={e => setForm(f => ({ ...f, [key]: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* LTA */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>LTA (Annual)</Label>
                <div className="relative">
                  <span className="absolute left-2.5 top-2.5 text-muted-foreground text-sm">₹</span>
                  <Input
                    type="number"
                    min={0}
                    className="pl-6"
                    value={form.lta_annual}
                    onChange={e => setForm(f => ({ ...f, lta_annual: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">Annual figure — not included in monthly gross</p>
              </div>
            </div>

            {/* Deductions */}
            <div>
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Deductions</p>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={form.tds_applicable}
                    onCheckedChange={v => setForm(f => ({ ...f, tds_applicable: v }))}
                  />
                  <span className="text-sm">TDS Applicable (Section 192)</span>
                </div>
                {form.tds_applicable && (
                  <div className="ml-10 max-w-xs">
                    <Label>Monthly TDS Amount</Label>
                    <div className="relative">
                      <span className="absolute left-2.5 top-2.5 text-muted-foreground text-sm">₹</span>
                      <Input
                        type="number"
                        min={0}
                        className="pl-6"
                        value={form.tds_monthly_amount}
                        onChange={e => setForm(f => ({ ...f, tds_monthly_amount: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Manual entry — auto-slab compute in future phase</p>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded p-3">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  PF & ESI will activate automatically once your headcount crosses the statutory threshold. No action needed.
                </div>
              </div>
            </div>

            {/* Live preview */}
            {form.basic > 0 && (
              <div className="bg-muted/40 rounded-lg p-4 text-sm space-y-1.5">
                <p className="font-semibold text-sm mb-2">Computed Preview</p>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Monthly Gross</span>
                  <span className="font-mono font-medium">{formatCurrency(gross)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">TN Professional Tax</span>
                  <span className="font-mono">{formatCurrency(pt)}</span>
                </div>
                {form.tds_applicable && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">TDS (Section 192)</span>
                    <span className="font-mono">{formatCurrency(form.tds_monthly_amount)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1.5 font-semibold">
                  <span>Estimated Net</span>
                  <span className="font-mono">{formatCurrency(gross - pt - (form.tds_applicable ? form.tds_monthly_amount : 0))}</span>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save Salary Definition
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
