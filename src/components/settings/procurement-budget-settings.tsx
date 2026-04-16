"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, TrendingUp, AlertTriangle, CheckCircle2, IndianRupee, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const DEPARTMENTS = ["pantry", "maintenance", "administration", "asset"] as const;

const DEPT_LABELS: Record<string, string> = {
  pantry: "Pantry",
  maintenance: "Maintenance",
  administration: "Administration",
  asset: "Asset",
};

const DEPT_ICONS: Record<string, string> = {
  pantry: "🍽️",
  maintenance: "🔧",
  administration: "📋",
  asset: "📦",
};

type BudgetRow = {
  department: string;
  monthly_budget: number | null;
  is_active: boolean;
  notes: string | null;
  id: string | null;
  spent_this_month: number;
  utilisation_pct: number | null;
  is_over_budget: boolean;
  updated_at: string | null;
  updater: { full_name: string } | null;
};

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

export function ProcurementBudgetSettings({ userRole }: { userRole: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Local editable state: keyed by department
  const [edits, setEdits] = useState<Record<string, { monthly_budget: string; is_active: boolean; notes: string }>>({});

  const isCurrentMonth = year === now.getFullYear() && month === (now.getMonth() + 1);
  const isAdmin = userRole === "admin";

  const fetchBudgets = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/budget?year=${year}&month=${month}`);
    if (res.ok) {
      const { data } = await res.json();
      setRows(data);
      // Initialise edits from fetched data
      const initial: Record<string, { monthly_budget: string; is_active: boolean; notes: string }> = {};
      for (const row of data as BudgetRow[]) {
        initial[row.department] = {
          monthly_budget: row.monthly_budget != null ? String(row.monthly_budget) : "",
          is_active: row.is_active,
          notes: row.notes ?? "",
        };
      }
      setEdits(initial);
    }
    setLoading(false);
  }, [year, month]);

  useEffect(() => { fetchBudgets(); }, [fetchBudgets]);

  const handleSave = async () => {
    setSaving(true);
    const budgets = DEPARTMENTS.map((dept) => ({
      department: dept,
      monthly_budget: edits[dept]?.monthly_budget ? parseFloat(edits[dept].monthly_budget) : null,
      is_active: edits[dept]?.is_active ?? false,
      notes: edits[dept]?.notes || null,
    }));

    const res = await fetch("/api/procurement/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budgets }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || "Failed to save budgets");
    } else {
      toast.success("Department budgets saved");
      fetchBudgets();
    }
    setSaving(false);
  };

  const utilColour = (pct: number | null, isOver: boolean) => {
    if (pct == null) return "text-muted-foreground";
    if (isOver) return "text-red-700";
    if (pct >= 80) return "text-amber-700";
    return "text-green-700";
  };

  const barColour = (pct: number | null, isOver: boolean) => {
    if (pct == null) return "bg-muted";
    if (isOver) return "bg-red-500";
    if (pct >= 80) return "bg-amber-400";
    return "bg-green-500";
  };

  return (
    <div className="space-y-6">
      {/* Header controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-base">Department Procurement Budgets</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Set monthly spending limits per department. MRs that exceed the budget require admin approval.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(month)} onValueChange={(v) => setMonth(parseInt(v))}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v))}>
            <SelectTrigger className="w-[90px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={fetchBudgets} className="h-8 w-8 p-0">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!isCurrentMonth && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Viewing historical data for {MONTHS[month - 1]} {year}. To edit budgets, switch to the current month.
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading budgets…
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const edit = edits[row.department] ?? { monthly_budget: "", is_active: false, notes: "" };
            const budgetAmt = parseFloat(edit.monthly_budget) || null;
            const pct = budgetAmt ? Math.min(Math.round((row.spent_this_month / budgetAmt) * 100), 110) : null;
            const isOver = budgetAmt != null && row.spent_this_month > budgetAmt;

            return (
              <Card key={row.department} className={isOver ? "border-red-200 bg-red-50/20" : ""}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex flex-wrap items-start gap-4">
                    {/* Dept name */}
                    <div className="flex items-center gap-2 w-36 shrink-0">
                      <span className="text-xl">{DEPT_ICONS[row.department]}</span>
                      <div>
                        <p className="font-medium text-sm">{DEPT_LABELS[row.department]}</p>
                        {isOver && (
                          <Badge variant="secondary" className="text-[10px] bg-red-100 text-red-700 px-1.5 mt-0.5">
                            Over Budget
                          </Badge>
                        )}
                        {!isOver && edit.is_active && budgetAmt && (
                          <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 px-1.5 mt-0.5">
                            Active
                          </Badge>
                        )}
                        {!edit.is_active && (
                          <Badge variant="secondary" className="text-[10px] bg-gray-100 text-gray-500 px-1.5 mt-0.5">
                            Inactive
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Budget input */}
                    <div className="flex-1 min-w-[140px] space-y-1">
                      <Label className="text-xs text-muted-foreground">Monthly Budget (₹)</Label>
                      <div className="relative">
                        <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          type="number"
                          step="1000"
                          min="0"
                          value={edit.monthly_budget}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], monthly_budget: e.target.value } }))}
                          className="pl-8 h-8 text-sm"
                          placeholder="e.g. 50000"
                          disabled={!isAdmin || !isCurrentMonth}
                        />
                      </div>
                    </div>

                    {/* Spend this month */}
                    <div className="flex-1 min-w-[160px] space-y-1">
                      <p className="text-xs text-muted-foreground">Spent This Month</p>
                      <p className={`text-sm font-semibold ${utilColour(pct, isOver)}`}>
                        {formatCurrency(row.spent_this_month)}
                        {budgetAmt && <span className="text-xs font-normal ml-1">/ {formatCurrency(budgetAmt)}</span>}
                      </p>
                      {budgetAmt ? (
                        <div className="w-full h-1.5 rounded-full bg-muted mt-1">
                          <div
                            className={`h-1.5 rounded-full transition-all ${barColour(pct, isOver)}`}
                            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                          />
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No budget set</p>
                      )}
                      {pct != null && (
                        <p className={`text-xs font-medium ${utilColour(pct, isOver)}`}>
                          {isOver ? `${pct}% — ₹${(row.spent_this_month - (budgetAmt ?? 0)).toLocaleString("en-IN")} over` : `${pct}% used`}
                        </p>
                      )}
                    </div>

                    {/* Active toggle */}
                    {isAdmin && isCurrentMonth && (
                      <div className="flex flex-col items-center gap-1 pt-1">
                        <Label className="text-xs text-muted-foreground">Active</Label>
                        <Switch
                          checked={edit.is_active}
                          onCheckedChange={(checked) =>
                            setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], is_active: checked } }))
                          }
                        />
                      </div>
                    )}
                  </div>

                  {/* Notes */}
                  {isAdmin && isCurrentMonth && (
                    <div className="mt-3">
                      <Input
                        value={edit.notes}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [row.department]: { ...prev[row.department], notes: e.target.value } }))}
                        className="h-7 text-xs text-muted-foreground"
                        placeholder="Optional note for this budget (e.g. approved by board in March)"
                      />
                    </div>
                  )}

                  {/* Meta */}
                  {row.updated_at && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      Last updated {new Date(row.updated_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      {row.updater ? ` by ${row.updater.full_name}` : ""}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {isAdmin && isCurrentMonth && (
            <div className="flex justify-end pt-2">
              <Button onClick={handleSave} disabled={saving} className="gap-2">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? "Saving…" : "Save All Budgets"}
              </Button>
            </div>
          )}

          {!isAdmin && (
            <p className="text-xs text-muted-foreground text-center pt-2">
              Budget configuration is admin-only. You are viewing current utilisation.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
