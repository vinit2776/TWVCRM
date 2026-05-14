"use client";

import {
  FileText,
  AlertCircle,
  Send,
  CreditCard,
  Receipt,
  BookCheck,
  ChevronRight,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface PipelineData {
  counts: Record<string, number>;
  amounts: Record<string, number>;
  total: number;
}

interface Props {
  data: PipelineData;
  /** Called when user clicks a stage — switches the statements tab to that filter */
  onStageClick?: (stage: string) => void;
}

const STAGES = [
  {
    key: "draft",
    label: "Draft",
    hint: "Needs finalizing",
    Icon: FileText,
    bg: "bg-gray-100",
    text: "text-gray-700",
    border: "border-gray-200",
    dot: "bg-gray-400",
    activeBg: "bg-gray-200",
  },
  {
    key: "finalized",
    label: "Finalized",
    hint: "Send proforma",
    Icon: AlertCircle,
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    dot: "bg-amber-400",
    activeBg: "bg-amber-100",
  },
  {
    key: "proforma_sent",
    label: "Proforma Sent",
    hint: "Awaiting payment",
    Icon: Send,
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    dot: "bg-blue-400",
    activeBg: "bg-blue-100",
  },
  {
    key: "partially_paid",
    label: "Part. Paid",
    hint: "Balance pending",
    Icon: CreditCard,
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    dot: "bg-orange-400",
    activeBg: "bg-orange-100",
  },
  {
    key: "paid",
    label: "Paid",
    hint: "Generate GST",
    Icon: CreditCard,
    bg: "bg-violet-50",
    text: "text-violet-700",
    border: "border-violet-200",
    dot: "bg-violet-400",
    activeBg: "bg-violet-100",
  },
  {
    key: "invoiced",
    label: "GST Sent",
    hint: "Mark accounted",
    Icon: Receipt,
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-200",
    dot: "bg-teal-400",
    activeBg: "bg-teal-100",
  },
  {
    key: "complete",
    label: "Complete",
    hint: "Done",
    Icon: BookCheck,
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
    dot: "bg-green-400",
    activeBg: "bg-green-100",
  },
] as const;

export function BillingPipelineBar({ data, onStageClick }: Props) {
  const { counts, amounts, total } = data;

  // How far along is this month? pct complete (voided excluded)
  const completeCount = counts["complete"] ?? 0;
  const pctComplete = total > 0 ? Math.round((completeCount / total) * 100) : 0;

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookCheck className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Billing Pipeline</span>
          <span className="text-xs text-muted-foreground">
            — {total} statement{total !== 1 ? "s" : ""} this month
          </span>
        </div>
        <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
          {pctComplete}% complete
        </span>
      </div>

      {/* Pipeline stages */}
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {STAGES.map((stage, idx) => {
          const count  = counts[stage.key] ?? 0;
          const amount = amounts[stage.key] ?? 0;
          const isLast = idx === STAGES.length - 1;
          const hasItems = count > 0;

          return (
            <div key={stage.key} className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => hasItems && onStageClick?.(stage.key)}
                disabled={!hasItems || !onStageClick}
                className={[
                  "flex flex-col items-center rounded-lg border px-3 py-2 min-w-[88px] transition-colors",
                  stage.bg,
                  stage.border,
                  hasItems && onStageClick
                    ? `cursor-pointer hover:${stage.activeBg}`
                    : "cursor-default opacity-60",
                ].join(" ")}
                title={hasItems ? `${count} statement${count !== 1 ? "s" : ""} — click to filter` : "None in this stage"}
              >
                <div className="flex items-center gap-1 mb-1">
                  <div className={`h-2 w-2 rounded-full ${stage.dot}`} />
                  <stage.Icon className={`h-3 w-3 ${stage.text}`} />
                </div>
                <span className={`text-lg font-bold leading-none ${stage.text}`}>{count}</span>
                <span className={`text-[10px] font-medium mt-0.5 ${stage.text}`}>{stage.label}</span>
                {amount > 0 && (
                  <span className="text-[9px] text-muted-foreground mt-0.5 font-mono">
                    {formatCurrency(amount)}
                  </span>
                )}
                {count > 0 && (
                  <span className="text-[9px] text-muted-foreground mt-0.5">{stage.hint}</span>
                )}
              </button>

              {!isLast && (
                <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden flex">
            {STAGES.map((stage) => {
              const count = counts[stage.key] ?? 0;
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={stage.key}
                  className={`h-full ${stage.dot} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${stage.label}: ${count}`}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Voided notice */}
      {(counts["voided"] ?? 0) > 0 && (
        <p className="text-[11px] text-muted-foreground">
          + {counts["voided"]} voided statement{counts["voided"] !== 1 ? "s" : ""} (excluded from pipeline)
        </p>
      )}
    </div>
  );
}
