"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PERIOD_PRESETS, rangeForPreset, type PeriodPresetId } from "./period";
import type { DateRange } from "./types";

export function PeriodFilter({
  preset,
  range,
  onChange,
}: {
  preset: PeriodPresetId;
  range: DateRange;
  onChange: (preset: PeriodPresetId, range: DateRange) => void;
}) {
  const [customFrom, setCustomFrom] = useState(range.start);
  const [customTo, setCustomTo] = useState(range.end);
  const [customOpen, setCustomOpen] = useState(preset === "custom");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {PERIOD_PRESETS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={preset === p.id ? "default" : "outline"}
            onClick={() => {
              setCustomOpen(false);
              onChange(p.id, rangeForPreset(p.id));
            }}
          >
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={preset === "custom" ? "default" : "outline"}
          onClick={() => setCustomOpen((v) => !v)}
        >
          Custom…
        </Button>
      </div>

      {customOpen && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
          <div>
            <Label className="mb-1.5 block text-xs">From</Label>
            <Input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">To</Label>
            <Input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="w-40" />
          </div>
          <Button
            size="sm"
            disabled={!customFrom || !customTo || customFrom > customTo}
            onClick={() => onChange("custom", { start: customFrom, end: customTo })}
          >
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}
