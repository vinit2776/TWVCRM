"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RENT_WAIVER_KINDS,
  RENT_WAIVER_KIND_HELP,
  RENT_WAIVER_KIND_LABELS,
  type RentWaiverKind,
} from "@/lib/constants";

/**
 * "What kind of waiver is this?" — shared by the single-month and the bulk
 * waive dialogs. Whether the customer was given the month or it was billed
 * outside the CRM decides whether it counts as a concession on the lead's
 * Value tab, so it has to be chosen, never left to a silent default.
 */
export function RentWaiverKindSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: RentWaiverKind | "";
  onChange: (kind: RentWaiverKind) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">What kind of waiver is this?</Label>
      <Select value={value} onValueChange={(v) => onChange(v as RentWaiverKind)}>
        <SelectTrigger id={id} className="h-9">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          {RENT_WAIVER_KINDS.map((k) => (
            <SelectItem key={k} value={k}>{RENT_WAIVER_KIND_LABELS[k]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && <p className="text-xs text-muted-foreground">{RENT_WAIVER_KIND_HELP[value]}</p>}
    </div>
  );
}
