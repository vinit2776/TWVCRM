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

/** Descriptive badge text shown on the active step instead of generic "Pending" */
const AWAITING_LABEL: Record<string, string> = {
  waiver: "OTP Required",
  sent: "Awaiting Send",
  viewed: "Awaiting Email Open",
  accepted: "Awaiting Decision",
  deposit: "Awaiting Payment",
  invoice: "Awaiting Invoice",
  paid: "Awaiting Payment",
};

function fmt(dateStr?: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
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

  // 1b. Deposit Waiver Approval (only for zero-deposit proposals)
  if (!hasDeposit && !isRejected) {
    const waiverVerified = !!proposal.deposit_waiver_verified_at;
    stages.push({
      key: "waiver",
      label: "Admin Deposit Waiver",
      date: proposal.deposit_waiver_verified_at,
      sub: waiverVerified
        ? "Zero-deposit approved via OTP"
        : proposal.deposit_waiver_requested_at
        ? "OTP sent to admin — awaiting entry"
        : "OTP approval required before sending",
      state: waiverVerified ? "done"
        : proposal.status === "draft" ? "active"
        : "done",
    });
  }

  // 2. Sent
  stages.push({
    key: "sent",
    label: "Sent to Customer",
    date: proposal.sent_at,
    state: proposal.sent_at ? "done"
      : isRejected ? "skipped"
      : proposal.status === "draft" ? ((!hasDeposit && !proposal.deposit_waiver_verified_at) ? "pending" : "active")
      : "done",
  });

  // 3. Opened by Customer — auto-tracked when they click "Review Your Proposal" link in email
  if (proposal.viewed_at || (!isRejected && proposal.sent_at)) {
    stages.push({
      key: "viewed",
      label: "Opened by Customer",
      date: proposal.viewed_at,
      sub: proposal.viewed_at
        ? "Auto-tracked via email link"
        : !isRejected && proposal.status === "sent"
        ? "Tracked automatically when customer clicks the email link"
        : undefined,
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

  // 5. Deposit Credit Applied (only if a credit was netted off the required deposit)
  const creditApplied = Number(proposal.deposit_credit_amount || 0);
  if (hasDeposit && !isRejected && creditApplied > 0) {
    stages.push({
      key: "deposit_credit",
      label: "Deposit Credit Applied",
      date: proposal.deposit_credit_applied_at,
      sub: proposal.deposit_credit_reason || undefined,
      amount: creditApplied,
      state: "done",
    });
  }

  // 6. Security Deposit (only if required) — amount shown while pending is the
  // balance actually due (required minus any credit applied above).
  if (hasDeposit && !isRejected) {
    const balanceDue = Math.max(0, Number(proposal.security_deposit_amount || 0) - creditApplied);
    stages.push({
      key: "deposit",
      label: "Security Deposit Received",
      date: proposal.deposit_payment_received_at,
      sub: proposal.deposit_payment_reference
        ? `Ref: ${proposal.deposit_payment_reference}`
        : undefined,
      amount: proposal.deposit_payment_status === "paid"
        ? Number(proposal.deposit_payment_amount || balanceDue || 0)
        : balanceDue,
      state: proposal.deposit_payment_status === "paid" ? "done"
        : proposal.accepted_at ? "active"
        : "pending",
    });
  }

  // 7. GST Invoice / Occupation start
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

  // 8. Monthly Charge Paid
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
                        {AWAITING_LABEL[stage.key] ?? "In Progress"}
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
