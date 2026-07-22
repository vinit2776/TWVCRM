"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Save, Loader2, CalendarClock, RotateCcw } from "lucide-react";
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
  /** Custom day-precise end date, overriding the default calendar-month boundary. Null = use default. */
  end_date: string | null;
}

interface Props {
  contractId: string;
  tenureMonths: number;
  baseMonthlyRate: number;
  phases: ContractRatePhase[];
  /** Phase-clock anchor (contract.phase_start_date ?? contract.start_date) — same anchor billing.ts uses. */
  phaseStartDate: string;
  canEdit: boolean;
  onPhasesUpdated: () => void;
}

// ── Date math — MUST mirror src/lib/billing.ts's computePhaseBoundaries exactly ──
// (server-side is the source of truth for what actually bills; this is only
// a live preview so the editor can show the same dates before saving.)

function addDaysToYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusiveYmd(startYmd: string, endYmd: string): number {
  const start = new Date(startYmd + "T00:00:00Z").getTime();
  const end = new Date(endYmd + "T00:00:00Z").getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function endOfMonthNMonthsFrom(startYmd: string, durationMonths: number): string {
  const [y, m] = startYmd.split("-").map(Number);
  const zeroIndexed = (m - 1) + (durationMonths - 1);
  const targetYear = y + Math.floor(zeroIndexed / 12);
  const targetMonth = (zeroIndexed % 12) + 1;
  const daysInTargetMonth = new Date(targetYear, targetMonth, 0).getDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(daysInTargetMonth).padStart(2, "0")}`;
}

interface PhaseBoundary { start: string; end: string }

function computePhaseBoundaries(anchorYmd: string, rows: PhaseRow[]): PhaseBoundary[] {
  const boundaries: PhaseBoundary[] = [];
  let cursorStart = anchorYmd;
  for (const row of rows) {
    const end = row.end_date || endOfMonthNMonthsFrom(cursorStart, row.duration_months || 1);
    boundaries.push({ start: cursorStart, end });
    cursorStart = addDaysToYmd(end, 1);
  }
  return boundaries;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatYmdShort(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

function formatDateRange(startYmd: string, endYmd: string): string {
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ey, em, ed] = endYmd.split("-").map(Number);
  if (sy === ey && sm === em) return `${MONTH_ABBR[sm - 1]} ${sd}–${ed}, ${ey}`;
  return `${MONTH_ABBR[sm - 1]} ${sd}${sy !== ey ? `, ${sy}` : ""} – ${MONTH_ABBR[em - 1]} ${ed}, ${ey}`;
}

export function ContractRatePhasesSection({ contractId, tenureMonths, baseMonthlyRate, phases, phaseStartDate, canEdit, onPhasesUpdated }: Props) {
  const sorted = [...phases].sort((a, b) => a.phase_order - b.phase_order);
  const [rows, setRows] = useState<PhaseRow[]>(
    sorted.map((p) => ({ id: p.id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate, end_date: p.end_date ?? null }))
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customizingIdx, setCustomizingIdx] = useState<number | null>(null);

  const totalFilled = rows.reduce((s, r) => s + (r.duration_months || 0), 0);
  const remaining = tenureMonths - totalFilled;
  const isFull = totalFilled === tenureMonths;

  const boundaries = useMemo(() => computePhaseBoundaries(phaseStartDate, rows), [phaseStartDate, rows]);
  const savedBoundaries = useMemo(
    () => computePhaseBoundaries(phaseStartDate, sorted.map((p) => ({ id: p.id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate, end_date: p.end_date ?? null }))),
    [phaseStartDate, sorted]
  );

  function addRow() {
    if (remaining <= 0) return;
    const nextOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.phase_order)) + 1 : 1;
    setRows((prev) => [...prev, { phase_order: nextOrder, duration_months: remaining, monthly_rate: 0, end_date: null }]);
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, phase_order: i + 1 })));
    if (customizingIdx === idx) setCustomizingIdx(null);
  }

  function updateDuration(idx: number, value: number) {
    // Editing duration directly reverts to the default calendar-month boundary —
    // keeps the two controls from silently disagreeing with each other.
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, duration_months: value, end_date: null } : r)));
  }

  function updateRate(idx: number, value: number) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, monthly_rate: value } : r)));
  }

  function updateEndDate(idx: number, value: string) {
    setRows((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const start = boundaries[idx]?.start ?? phaseStartDate;
      // Keep duration_months roughly in sync (progress bar / next-row auto-fill) —
      // end_date is authoritative for billing regardless of this approximation.
      const approxMonths = Math.max(1, Math.round(daysBetweenInclusiveYmd(start, value) / 30.44));
      return { ...r, end_date: value, duration_months: approxMonths };
    }));
  }

  function clearEndDateOverride(idx: number) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, end_date: null } : r)));
    setCustomizingIdx(null);
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
            end_date: r.end_date,
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
      setCustomizingIdx(null);
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
      setCustomizingIdx(null);
      onPhasesUpdated();
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setRows(sorted.map((p) => ({ id: p.id, phase_order: p.phase_order, duration_months: p.duration_months, monthly_rate: p.monthly_rate, end_date: p.end_date ?? null })));
    setEditing(false);
    setCustomizingIdx(null);
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
              <span className="text-muted-foreground">Months covered (approx.)</span>
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

            {rows.map((row, idx) => {
              const b = boundaries[idx];
              const isCustom = !!row.end_date;
              return (
                <div key={idx} className="space-y-1">
                  <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 items-center">
                    <span className="w-6 text-sm text-muted-foreground text-center">{idx + 1}</span>
                    <Input
                      type="number"
                      min={1}
                      max={tenureMonths}
                      value={row.duration_months}
                      onChange={(e) => updateDuration(idx, parseInt(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                    <Input
                      type="number"
                      min={baseMonthlyRate}
                      step={100}
                      value={row.monthly_rate}
                      onChange={(e) => updateRate(idx, parseFloat(e.target.value) || 0)}
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

                  {/* Computed end date + customize control */}
                  {b && (
                    <div className="flex items-center gap-1.5 pl-8 text-xs">
                      <span className={isCustom ? "text-primary font-medium" : "text-muted-foreground"}>
                        {formatYmdShort(b.start)} – {formatYmdShort(b.end)}
                        {isCustom && " (custom)"}
                      </span>
                      {customizingIdx === idx ? (
                        <>
                          <Input
                            type="date"
                            value={row.end_date ?? b.end}
                            min={b.start}
                            onChange={(e) => updateEndDate(idx, e.target.value)}
                            className="h-6 w-36 text-xs"
                          />
                          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setCustomizingIdx(null)}>
                            Done
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setCustomizingIdx(idx)}
                        >
                          <CalendarClock className="h-3 w-3 mr-1" />
                          {isCustom ? "Change date" : "Customize end date"}
                        </Button>
                      )}
                      {isCustom && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => clearEndDateOverride(idx)}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Use default
                        </Button>
                      )}
                    </div>
                  )}

                  {invalidRateRows[idx] && (
                    <p className="text-xs text-destructive pl-8">
                      Min rate is {formatCurrency(baseMonthlyRate)} (contracted monthly fee)
                    </p>
                  )}
                </div>
              );
            })}

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
            {rows.some((r) => r.end_date) && (
              <p className="text-xs text-muted-foreground mt-1">
                A month that a custom end date splits mid-way will bill as two pro-rata line items — one per phase — instead of one flat month.
              </p>
            )}
          </div>
        ) : sorted.length > 0 ? (
          <div className="space-y-0">
            {sorted.map((row, idx) => {
              const b = savedBoundaries[idx];
              return (
                <div key={idx} className="flex items-center gap-3 text-sm py-2 border-b last:border-0">
                  <Badge variant="outline" className="text-xs shrink-0 min-w-[60px] justify-center">
                    Phase {idx + 1}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {b ? formatDateRange(b.start, b.end) : `${row.duration_months} mo`}
                    {row.end_date && <span className="text-primary"> (custom)</span>}
                  </span>
                  <span className="font-medium ml-auto">
                    {formatCurrency(row.monthly_rate)}
                    <span className="text-xs text-muted-foreground font-normal">/mo</span>
                  </span>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground pt-2">
              After {savedBoundaries[savedBoundaries.length - 1] ? formatYmdShort(savedBoundaries[savedBoundaries.length - 1].end) : `month ${tenureMonths}`}: flat at {formatCurrency(sorted[sorted.length - 1]?.monthly_rate ?? 0)}/mo until renewed.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
