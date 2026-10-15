"use client";

import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { chargeDateForMonth, monthKeyOf, monthLabel, monthNamedIn, pickerOptions, usageMonthHint } from "@/lib/usage-month";

interface Props {
  id: string;
  /** The charge_date (YYYY-MM-DD) this picker edits. */
  value: string;
  onChange: (chargeDate: string) => void;
  /** Used to warn when it names a different month than the one picked. */
  description?: string;
  /** The date the charge was saved with, so Edit keeps it while the month is unchanged. */
  originalDate?: string | null;
}

const today = () => new Date().toISOString().split("T")[0];

// Same for every picker on the page, so fetch once.
let lockedPromise: Promise<Set<string>> | null = null;
function fetchLocked(): Promise<Set<string>> {
  lockedPromise ??= fetch("/api/accounting/periods/locked")
    .then((r) => (r.ok ? r.json() : { locked: [] }))
    .then((j) => new Set<string>(j.locked ?? []))
    .catch(() => new Set<string>());
  return lockedPromise;
}

export function UsageMonthPicker({ id, value, onChange, description, originalDate }: Props) {
  const [locked, setLocked] = useState<Set<string>>(new Set());
  useEffect(() => { fetchLocked().then(setLocked); }, []);

  const now = today();
  const selectedKey = value ? monthKeyOf(value) : monthKeyOf(now);
  const options = useMemo(() => pickerOptions(now, locked, selectedKey), [now, locked, selectedKey]);

  const named = description ? monthNamedIn(description, now) : null;
  const mismatch = named && named !== selectedKey ? named : null;
  const canSwitch = mismatch ? options.some((o) => o.key === mismatch) : false;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        Usage month <span className="text-destructive">*</span>
      </Label>
      <Select value={selectedKey} onValueChange={(key) => onChange(chargeDateForMonth(key, now, originalDate))}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              {o.label}{o.key === monthKeyOf(now) ? " (current month)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{usageMonthHint(selectedKey, now)}</p>
      {mismatch && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The description says {monthLabel(mismatch).split(" ")[0]}, but the usage month is {monthLabel(selectedKey).split(" ")[0]}. This will go on the {monthLabel(selectedKey)} invoice.{" "}
          {canSwitch && (
            <button type="button" className="font-medium underline" onClick={() => onChange(chargeDateForMonth(mismatch, now, originalDate))}>
              Switch to {monthLabel(mismatch).split(" ")[0]}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
