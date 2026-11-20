"use client";

import { useEffect, useMemo } from "react";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ESCALATION_CYCLE_OPTIONS, buildCycleSchedule } from "@/lib/escalation-cycle";
import { addDaysToYmd } from "@/lib/rate-phase-dates";
import { addMonthsClampedYmd } from "@/lib/escalation-cycle";

interface Props {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Escalation percentage the steps use. */
  percent: number;
  /** Monthly fee before GST. */
  monthlyFee: number;
  /** Real dates (contract) or, on a proposal, a term in months counted from the start. */
  startDate?: string;
  endDate?: string;
  tenureMonths?: number;
  disabled?: boolean;
  /** True when a line is marked fixed, which a combined stepped fee cannot honour. */
  blockedByFixedLine?: boolean;
}

/**
 * Chooses how often the fee steps up inside the term and shows exactly what the
 * customer will pay. The same schedule is written to the contract, the
 * agreement, the addendum and the invoices.
 */
export function EscalationCycleField({
  value, onChange, percent, monthlyFee, startDate, endDate, tenureMonths, disabled, blockedByFixedLine,
}: Props) {
  const rows = useMemo(() => {
    if (!value || !(monthlyFee > 0)) return [];
    // A proposal has no dates yet: count from a placeholder start so the rows read as month numbers.
    const anchor = startDate || "2000-01-01";
    const end = endDate || (tenureMonths ? addDaysToYmd(addMonthsClampedYmd(anchor, tenureMonths), -1) : "");
    if (!end) return [];
    return buildCycleSchedule({ anchorYmd: anchor, endYmd: end, baseRate: monthlyFee, percent, cycleMonths: value });
  }, [value, monthlyFee, percent, startDate, endDate, tenureMonths]);

  // Whole months in the term, when known. A contract of 11 months or more always follows a cycle (the
  // choice is 11 or 12); "No steps" is only offered for shorter terms, or when a fixed line forbids steps.
  const termMonths = useMemo(() => {
    if (startDate && endDate) {
      const exclusiveEnd = addDaysToYmd(endDate, 1);
      const [sy, sm, sd] = startDate.split("-").map(Number);
      const [ey, em, ed] = exclusiveEnd.split("-").map(Number);
      if (![sy, sm, sd, ey, em, ed].every(Number.isFinite)) return undefined;
      return (ey - sy) * 12 + (em - sm) - (ed < sd ? 1 : 0);
    }
    return tenureMonths;
  }, [startDate, endDate, tenureMonths]);
  const cycleRequired = !blockedByFixedLine && termMonths !== undefined && termMonths >= 11;

  // A draft saved before this rule (no cycle) moves onto the default instead of showing nothing selected.
  useEffect(() => {
    if (cycleRequired && value === null && !disabled) onChange(11);
  }, [cycleRequired, value, disabled, onChange]);

  const hasDates = !!startDate && !!endDate;
  const label = (i: number) => {
    const r = rows[i];
    if (hasDates) return `${formatDate(r.start)} – ${formatDate(r.end)}`;
    const from = (value ?? 0) * i + 1;
    const to = i === rows.length - 1 && tenureMonths ? tenureMonths : (value ?? 0) * (i + 1);
    return from === to ? `Month ${from}` : `Months ${from} to ${to}`;
  };

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-2">
      <Label className="text-sm font-semibold">Escalation cycle</Label>
      <div className="flex flex-wrap gap-2">
        {(cycleRequired ? [...ESCALATION_CYCLE_OPTIONS] : [...ESCALATION_CYCLE_OPTIONS, null]).map((opt) => {
          const selected = value === opt;
          return (
            <button
              key={String(opt)}
              type="button"
              disabled={disabled || (opt !== null && !!blockedByFixedLine)}
              onClick={() => onChange(opt)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                selected ? "border-[#015E65] bg-[#015E65]/10 text-[#015E65]" : "bg-background hover:bg-muted"
              }`}
            >
              {opt === null ? "No steps (at renewal only)" : `Every ${opt} months`}
              {opt === 11 && <span className="ml-1 text-[10px] font-normal text-muted-foreground">default</span>}
            </button>
          );
        })}
      </div>
      {blockedByFixedLine ? (
        <p className="text-xs text-amber-700">
          A line is marked fixed (for example maintenance), so the fee can&apos;t step on a cycle. Make every line escalate to use one.
        </p>
      ) : value && !(monthlyFee > 0 && ((startDate && endDate) || tenureMonths)) ? (
        <p className="text-xs text-muted-foreground">Enter the fee and choose the term to see the stepped fees.</p>
      ) : value && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The term is not longer than {value} months, so the fee does not step inside it. It escalates at renewal as usual.
        </p>
      ) : value ? (
        <div className="text-xs">
          <p className="text-muted-foreground mb-1">
            The fee goes up {percent}% every {value} months, each step on the previous fee. Add-ons never escalate.
          </p>
          <table className="w-full">
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.order} className="border-t border-blue-100">
                  <td className="py-1 pr-2">{label(i)}</td>
                  <td className="py-1 text-right font-medium tabular-nums">{formatCurrency(r.rate)} + GST / month</td>
                  <td className="py-1 pl-2 text-right text-muted-foreground w-16">{i === 0 ? "" : `+${percent}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">The fee escalates only when the contract is renewed.</p>
      )}
    </div>
  );
}
