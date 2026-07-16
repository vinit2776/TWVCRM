"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Save, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { ContractRatePhase } from "@/types";

interface PhaseRow {
  id?: string;
  phase_order: number;
  duration_months: number;
  monthly_rate: number;
}

interface Props {
  contractId: string;
  tenureMonths: number;
  baseMonthlyRate: number;
  phases: ContractRatePhase[];
  canEdit: boolean;
  onPhasesUpdated: () => void;
}

export function ContractRatePhasesSection({ contractId, tenureMonths, baseMonthlyRate, phases, canEdit, onPhasesUpdated }: Props) {
  const sorted = [...phases].sort((a, b) => a.phase_order - b.phase_order);
  const [rows, setRows] = useState<PhaseRow[]>(
    sorted.map((p) => ({ id: p.id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate }))
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const totalFilled = rows.reduce((s, r) => s + (r.duration_months || 0), 0);
  const remaining = tenureMonths - totalFilled;
  const isFull = totalFilled === tenureMonths;

  function addRow() {
    if (remaining <= 0) return;
    const nextOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.phase_order)) + 1 : 1;
    setRows((prev) => [...prev, { phase_order: nextOrder, duration_months: remaining, monthly_rate: 0 }]);
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, phase_order: i + 1 })));
  }

  function updateRow(idx: number, field: "duration_months" | "monthly_rate", value: number) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }

  const invalidRateRows = rows.map((r) => r.monthly_rate < baseMonthlyRate);
  const hasInvalidRate = invalidRateRows.some(Boolean);

  async function save() {
    if (!isFull) {
      toast.error(`Phases must cover all ${tenureMonths} months. Currently ${totalFilled} months filled.`);
      return;
    }
    if (hasInvalidRate) {
      toast.error(`Phase rates cannot be lower than the contracted monthly fee of ${formatCurrency(baseMonthlyRate)}`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/rate-phases`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phases: rows.map((r, i) => ({
            phase_order: i + 1,
            duration_months: r.duration_months,
            monthly_rate: r.monthly_rate,
          })),
        }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        toast.error(error || "Failed to save phases");
        return;
      }
      toast.success("Rate phases saved");
      setEditing(false);
      onPhasesUpdated();
    } finally {
      setSaving(false);
    }
  }

  async function clearPhases() {
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/rate-phases`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phases: [] }),
      });
      if (!res.ok) {
        const { error } = await res.json();
        toast.error(error || "Failed to clear phases");
        return;
      }
      toast.success("Reverted to flat rate");
      setRows([]);
      setEditing(false);
      onPhasesUpdated();
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setRows(sorted.map((p) => ({ id: p.id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate })));
    setEditing(false);
  }

  // Build display rows with month ranges
  function buildRanges(r: PhaseRow[]) {
    let cursor = 1;
    return r.map((row) => {
      const start = cursor;
      const end = cursor + row.duration_months - 1;
      cursor = end + 1;
      return { ...row, start, end };
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">
          Tiered Rate Schedule
          {sorted.length === 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">(flat rate — no phases)</span>
          )}
        </CardTitle>
        {canEdit && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {sorted.length === 0 ? "Add Phases" : "Edit Phases"}
          </Button>
        )}
        {editing && (
          <div className="flex gap-2">
            {rows.length > 0 && (
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={clearPhases} disabled={saving}>
                Clear all
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving || !isFull || hasInvalidRate}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
              Save
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {sorted.length === 0 && !editing && (
          <p className="text-sm text-muted-foreground">
            Contract uses a flat monthly rate.{canEdit && " Click \"Add Phases\" to configure tiered pricing."}
          </p>
        )}

        {editing ? (
          <div className="space-y-3">
            {/* Progress indicator */}
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">Months covered</span>
              <span className={isFull ? "text-green-600 font-medium" : remaining < 0 ? "text-destructive font-medium" : "text-amber-600 font-medium"}>
                {totalFilled} / {tenureMonths} months
                {!isFull && remaining > 0 && ` — ${remaining} remaining`}
                {remaining < 0 && ` — ${Math.abs(remaining)} over`}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-1.5 mb-3">
              <div
                className={`h-1.5 rounded-full transition-all ${remaining < 0 ? "bg-destructive" : isFull ? "bg-green-500" : "bg-amber-400"}`}
                style={{ width: `${Math.min(100, (totalFilled / tenureMonths) * 100)}%` }}
              />
            </div>

            {rows.length > 0 && (
              <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 text-xs text-muted-foreground px-1 mb-1">
                <span className="w-6 text-center">#</span>
                <span>Duration (months)</span>
                <span>Monthly Rate (₹ excl. GST)</span>
                <span />
              </div>
            )}

            {rows.map((row, idx) => (
              <div key={idx} className="space-y-1">
                <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 items-center">
                  <span className="w-6 text-sm text-muted-foreground text-center">{idx + 1}</span>
                  <Input
                    type="number"
                    min={1}
                    max={tenureMonths}
                    value={row.duration_months}
                    onChange={(e) => updateRow(idx, "duration_months", parseInt(e.target.value) || 0)}
                    className="h-8 text-sm"
                  />
                  <Input
                    type="number"
                    min={baseMonthlyRate}
                    step={100}
                    value={row.monthly_rate}
                    onChange={(e) => updateRow(idx, "monthly_rate", parseFloat(e.target.value) || 0)}
                    className={`h-8 text-sm ${invalidRateRows[idx] ? "border-destructive focus-visible:ring-destructive" : ""}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive"
                    onClick={() => removeRow(idx)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {invalidRateRows[idx] && (
                  <p className="text-xs text-destructive col-span-4 pl-8">
                    Min rate is {formatCurrency(baseMonthlyRate)} (contracted monthly fee)
                  </p>
                )}
              </div>
            ))}

            {remaining > 0 && (
              <Button variant="outline" size="sm" className="w-full mt-1" onClick={addRow}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Phase
                {remaining > 0 && <span className="ml-1 text-muted-foreground">({remaining} months left)</span>}
              </Button>
            )}

            {!isFull && rows.length > 0 && (
              <p className="text-xs text-amber-600 mt-1">
                Phases must total exactly {tenureMonths} months before you can save.
              </p>
            )}
          </div>
        ) : sorted.length > 0 ? (
          <div className="space-y-0">
            {buildRanges(sorted).map((row, idx) => (
              <div key={idx} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                <Badge variant="outline" className="text-xs shrink-0 min-w-[60px] justify-center">
                  Phase {idx + 1}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  Month {row.start}–{row.end} ({row.duration_months} mo)
                </span>
                <span className="font-medium ml-auto">
                  {formatCurrency(row.monthly_rate)}
                  <span className="text-xs text-muted-foreground font-normal">/mo</span>
                </span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-2">
              After month {tenureMonths}: flat at {formatCurrency(sorted[sorted.length - 1]?.monthly_rate ?? 0)}/mo until renewed.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
