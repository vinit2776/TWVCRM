"use client";

import { breakdownRows, type DepositBreakdown } from "@/lib/deposit-breakdown";

/** The working behind the balance, in the order the customer will read it. */
export function DepositBreakdownTable({ breakdown }: { breakdown: DepositBreakdown }) {
  const rows = breakdownRows(breakdown);
  return (
    <div className="rounded-md border bg-slate-50/60 text-xs">
      {rows.map((r, i) => (
        <div
          key={i}
          className={`flex items-start justify-between gap-3 px-3 py-1 ${r.bold ? "font-semibold" : "text-muted-foreground"} ${r.indent ? "pl-6" : ""} ${r.bold && r.value ? "border-t" : ""}`}
        >
          <span>{r.label}</span>
          {r.value && <span className="tabular-nums shrink-0">{r.value}</span>}
        </div>
      ))}
    </div>
  );
}
