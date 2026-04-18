"use client";

import { CheckCircle2, Circle, XCircle, Clock } from "lucide-react";
import type { Proposal } from "@/types";

interface Props {
  proposal: Proposal;
}

interface Stage {
  key: string;
  label: string;
  sub?: string;
  date?: string | null;
  state: "done" | "active" | "pending" | "rejected" | "skipped";
  amount?: number;
  isRejected?: boolean;
}

function fmt(dateStr?: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export function ProposalLifecycle({ proposal }: Props) {
  const hasDeposit = Number(proposal.security_deposit_months || 0) > 0;
  const isRejected = proposal.status === "rejected";

  // Determine the current active step index for styling
  const stages: Stage[] = [];

  // 1. Created
  stages.push({
    key: "created",
    label: "Proposal Created",
    date: proposal.created_at,
    state: "done",
  });

  // 2. Sent
  stages.push({
    key: "sent",
    label: "Sent to Customer",
    date: proposal.sent_at,
    state: proposal.sent_at ? "done"
      : isRejected ? "skipped"
      : proposal.status === "draft" ? "active"
      : "done",
  });

  // 3. Viewed (optional — show as done or skipped gracefully)
  if (proposal.viewed_at || (!isRejected && proposal.sent_at)) {
    stages.push({
      key: "viewed",
      label: "Viewed by Customer",
      date: proposal.viewed_at,
      state: proposal.viewed_at ? "done"
        : isRejected ? "skipped"
        : proposal.status === "sent" ? "active"
        : "pending",
    });
  }

  // 4. Accepted / Rejected
  if (isRejected) {
    stages.push({
      key: "rejected",
      label: "Proposal Rejected",
      date: proposal.rejected_at,
      sub: proposal.rejection_reason || undefined,
      state: "rejected",
    });
  } else {
    stages.push({
      key: "accepted",
      label: "Proposal Accepted",
      date: proposal.accepted_at,
      state: proposal.accepted_at ? "done"
        : (proposal.status === "sent" || proposal.status === "viewed") ? "active"
        : "pending",
    });
  }

  // 5. Security Deposit (only if required)
  if (hasDeposit && !isRejected) {
    stages.push({
      key: "deposit",
      label: "Security Deposit Received",
      date: proposal.deposit_payment_received_at,
      sub: proposal.deposit_payment_reference
        ? `Ref: ${proposal.deposit_payment_reference}`
        : undefined,
      amount: proposal.deposit_payment_status === "paid"
        ? Number(proposal.deposit_payment_amount || proposal.security_deposit_amount || 0)
        : Number(proposal.security_deposit_amount || 0),
      state: proposal.deposit_payment_status === "paid" ? "done"
        : proposal.accepted_at ? "active"
        : "pending",
    });
  }

  // 6. GST Invoice / Occupation start
  if (!isRejected) {
    stages.push({
      key: "invoice",
      label: "GST Invoice Issued",
      date: proposal.occupation_start_date,
      sub: proposal.occupation_start_date
        ? `Occupation from ${fmt(proposal.occupation_start_date)}`
        : undefined,
      state: proposal.occupation_start_date ? "done"
        : (!hasDeposit || proposal.deposit_payment_status === "paid") ? "active"
        : "pending",
    });
  }

  // 7. Monthly Charge Paid
  if (!isRejected) {
    stages.push({
      key: "paid",
      label: "Monthly Charge Paid",
      date: proposal.payment_received_at,
      sub: proposal.payment_reference ? `Ref: ${proposal.payment_reference}` : undefined,
      amount: proposal.payment_status === "paid"
        ? Number(proposal.payment_amount || proposal.total_amount || 0)
        : Number(proposal.total_amount || 0),
      state: proposal.payment_status === "paid" ? "done"
        : proposal.occupation_start_date ? "active"
        : "pending",
    });
  }

  const activeIndex = stages.findIndex((s) => s.state === "active");

  return (
    <div className="relative">
      {/* Vertical connector line */}
      <div className="absolute left-3.5 top-5 bottom-5 w-px bg-border" aria-hidden />

      <ol className="space-y-0 relative">
        {stages.map((stage, i) => {
          const isLast = i === stages.length - 1;

          return (
            <li key={stage.key} className="flex gap-3 min-h-[44px]">
              {/* Icon */}
              <div className="relative z-10 flex-shrink-0 flex items-start pt-0.5">
                {stage.state === "done" && (
                  <CheckCircle2 className="h-7 w-7 text-green-600 bg-background rounded-full" />
                )}
                {stage.state === "active" && (
                  <Clock className="h-7 w-7 text-amber-500 bg-background rounded-full" />
                )}
                {stage.state === "pending" && (
                  <Circle className="h-7 w-7 text-muted-foreground/40 bg-background rounded-full" />
                )}
                {stage.state === "rejected" && (
                  <XCircle className="h-7 w-7 text-destructive bg-background rounded-full" />
                )}
                {stage.state === "skipped" && (
                  <Circle className="h-7 w-7 text-muted-foreground/20 bg-background rounded-full" />
                )}
              </div>

              {/* Content */}
              <div className={`pb-${isLast ? "0" : "4"} flex-1 min-w-0`}>
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <p className={`text-sm font-medium leading-tight ${
                    stage.state === "done" ? "text-foreground"
                    : stage.state === "active" ? "text-amber-700"
                    : stage.state === "rejected" ? "text-destructive"
                    : "text-muted-foreground"
                  }`}>
                    {stage.label}
                    {stage.state === "active" && (
                      <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full align-middle">
                        Pending
                      </span>
                    )}
                  </p>
                  {stage.amount !== undefined && (
                    <span className={`text-xs font-semibold shrink-0 ${
                      stage.state === "done" ? "text-green-700" : "text-muted-foreground"
                    }`}>
                      ₹{stage.amount.toLocaleString("en-IN")}
                    </span>
                  )}
                </div>
                {stage.date && (
                  <p className="text-xs text-muted-foreground mt-0.5">{fmt(stage.date)}</p>
                )}
                {stage.sub && (
                  <p className={`text-xs mt-0.5 truncate ${
                    stage.state === "rejected" ? "text-destructive/70" : "text-muted-foreground"
                  }`}>
                    {stage.sub}
                  </p>
                )}
                {!isLast && <div className="pb-3" />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
