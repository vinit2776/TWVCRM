"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { daysAgoLabel, formatLongDate, formatRecordedOn, todayIst } from "@/lib/payment-dates";

/**
 * The two dates of a payment, side by side so nobody mistakes one for the other.
 *
 *   Date received in bank — editable, the day the credit hit our account.
 *   Recorded in CRM       — locked, today; stamped by the database on save.
 *
 * Shared by every dialog that records a customer payment so the wording and the
 * guard rails cannot drift between screens.
 */
export function PaymentDateFields({
  value,
  onChange,
}: {
  value: string;
  onChange: (ymd: string) => void;
}) {
  const today = todayIst();
  const picked = value || null;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label>Date received in bank</Label>
        <Input
          type="date"
          value={value}
          max={today}
          onChange={(e) => onChange(e.target.value)}
        />
        {picked ? (
          <p className="text-xs">
            <span className="font-medium">{formatLongDate(picked)}</span>
            <span className="text-muted-foreground"> · {daysAgoLabel(picked)}</span>
          </p>
        ) : (
          <p className="text-xs text-amber-700">Pick the date the money reached the bank.</p>
        )}
        <p className="text-[11px] text-muted-foreground leading-snug">
          The day the credit shows on the bank statement, not the day you are entering it.
        </p>
      </div>
      <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Recorded in CRM</span>
        <span className="font-medium">
          {formatRecordedOn(new Date().toISOString())}
          <span className="text-muted-foreground font-normal"> · automatic</span>
        </span>
      </div>
    </div>
  );
}
