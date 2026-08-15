"use client";

import { CheckCircle2, Circle, XCircle, Clock } from "lucide-react";
import Link from "next/link";
import type { Contract } from "@/types";

interface Props {
  contract: Contract;
}

function fmt(dateStr?: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type StageState = "done" | "active" | "pending" | "rejected" | "skipped";

interface Stage {
  key: string;
  label: string;
  sub?: string;
  date?: string | null;
  state: StageState;
  actor?: string | null;
}

/** Badge text for the currently-active step */
const AWAITING_LABEL: Record<string, string> = {
  sent: "Awaiting Send",
  viewed: "Awaiting Client Acknowledgement",
  accepted: "Awaiting Acceptance",
  active: "Pending Activation",
  outcome: "In Effect",
};

export function ContractLifecycle({ contract }: Props) {
  const isRejected = contract.status === "rejected";
  const isTerminal = ["terminated", "expired", "renewed"].includes(
    contract.status
  );

  const stages: Stage[] = [];

  // 0. Proposal Stage — shown when a proposal is linked (new flow)
  //    or absent with a warning when none is linked (legacy / gap)
  const proposal = contract.proposal as (typeof contract.proposal & {
    deposit_payment_status?: string;
    payment_status?: string;
    deposit_payment_received_at?: string;
    payment_received_at?: string;
  }) | undefined;

  if (proposal) {
    const depositRequired = !!(proposal?.security_deposit_months && Number(proposal.security_deposit_months) > 0);
    const depositPaid = proposal.deposit_payment_status === "paid";
    const prorataPaid = proposal.payment_status === "paid";
    const allPaid = (!depositRequired || depositPaid) && prorataPaid;

    // Deposit sub-stage
    if (depositRequired) {
      stages.push({
        key: "proposal_deposit",
        label: "Security Deposit Collected",
        date: proposal.deposit_payment_received_at,
        state: depositPaid ? "done" : "active",
        actor: null,
      });
    }

    // Pro-rata / first invoice sub-stage
    stages.push({
      key: "proposal_prorata",
      label: "Pro-rata Rent Collected",
      sub: proposal.proposal_number
        ? `via ${proposal.proposal_number}`
        : undefined,
      date: proposal.payment_received_at,
      state: prorataPaid ? "done" : (depositPaid || !depositRequired) ? "active" : "pending",
      actor: null,
    });

    // If all payments done but contract not yet active — surface the gap
    if (allPaid && !["active", "terminated", "expired", "renewed"].includes(contract.status)) {
      stages.push({
        key: "activation_pending",
        label: "Awaiting Contract Activation",
        sub: "All payments received — activate the contract to begin billing",
        date: null,
        state: "active",
        actor: null,
      });
    }
  } else if (contract.deposit_carried_from) {
    // Renewals carry the deposit forward from the parent contract and never
    // link a new proposal — this isn't a gap, so don't warn about it (mirrors
    // the isRenewal bypass in the activation gate).
    stages.push({
      key: "deposit_carried",
      label: "Deposit Carried from Parent Contract",
      sub: "Renewal — no new proposal or deposit collection required",
      date: null,
      state: "done",
      actor: null,
    });
  } else if (!["draft"].includes(contract.status)) {
    // No proposal linked — warn unless still a draft
    stages.push({
      key: "no_proposal",
      label: "No Proposal Linked",
      sub: "Link a completed proposal before activating",
      date: null,
      state: "active",
      actor: null,
    });
  }

  // 1. Draft Created — always done
  stages.push({
    key: "draft",
    label: "Agreement Drafted",
    date: contract.created_at,
    state: "done",
    actor: contract.created_by_name,
  });

  // 2. Sent to Client
  stages.push({
    key: "sent",
    label: "Sent to Client",
    date: contract.sent_at,
    state: contract.sent_at
      ? "done"
      : isRejected
      ? "skipped"
      : contract.status === "draft"
      ? "active"
      : "done",
    actor: contract.sent_by_name,
  });

  // 3. Acknowledged by Client — manually updated by staff when client confirms receipt
  if (contract.viewed_at || (!isRejected && contract.sent_at)) {
    stages.push({
      key: "viewed",
      label: "Client Acknowledged",
      date: contract.viewed_at,
      state: contract.viewed_at
        ? "done"
        : isRejected
        ? "skipped"
        : contract.status === "sent"
        ? "active"
        : "pending",
      actor: contract.viewed_by_name,
    });
  }

  // 4. Accepted / Rejected
  if (isRejected) {
    stages.push({
      key: "rejected",
      label: "Agreement Rejected",
      date: contract.rejected_at,
      state: "rejected",
      actor: contract.rejected_by_name,
    });
  } else {
    stages.push({
      key: "accepted",
      label: "Agreement Accepted",
      date: contract.accepted_at,
      state: contract.accepted_at
        ? "done"
        : contract.status === "sent" || contract.status === "viewed"
        ? "active"
        : "pending",
      actor: contract.accepted_by_name,
    });
  }

  // 5. Active (only if not rejected)
  if (!isRejected) {
    stages.push({
      key: "active",
      label: "Contract Active",
      date: contract.activated_at || (contract.status !== "draft" && contract.status !== "sent" && contract.status !== "viewed" && contract.status !== "accepted" ? contract.start_date : null),
      sub:
        contract.start_date && contract.end_date
          ? `${fmt(contract.start_date)} – ${fmt(contract.end_date)}`
          : undefined,
      state:
        contract.activated_at ||
        contract.status === "active" ||
        isTerminal
          ? "done"
          : contract.accepted_at
          ? "active"
          : "pending",
      actor: contract.activated_by_name,
    });
  }

  // 6. Outcome — Renewed / Expired / Terminated
  if (!isRejected) {
    if (contract.status === "renewed" && contract.renewed_at) {
      stages.push({
        key: "renewed",
        label: "Contract Renewed",
        date: contract.renewed_at,
        state: "done",
        actor: contract.renewed_by_name,
      });
    } else if (
      contract.status === "terminated" &&
      contract.terminated_at
    ) {
      stages.push({
        key: "terminated",
        label: "Contract Terminated",
        date: contract.terminated_at,
        sub: contract.termination_reason || undefined,
        state: "rejected",
        actor: contract.terminated_by_name,
      });
    } else if (contract.status === "expired") {
      stages.push({
        key: "expired",
        label: "Contract Expired",
        date: contract.end_date,
        state: "done",
      });
    } else if (contract.status === "active" || contract.accepted_at) {
      // Contract is running — show projected end
      stages.push({
        key: "outcome",
        label: "Completion",
        date: null,
        sub: contract.end_date ? `Ends ${fmt(contract.end_date)}` : undefined,
        state: "pending",
      });
    }
  }

  return (
    <div className="relative">
      {/* Vertical connector line */}
      <div
        className="absolute left-3.5 top-5 bottom-5 w-px bg-border"
        aria-hidden
      />

      <ol className="space-y-0 relative">
        {stages.map((stage, i) => {
          const isLast = i === stages.length - 1;
          const awaitingLabel = AWAITING_LABEL[stage.key];

          return (
            <li key={stage.key} className="flex gap-3 min-h-[40px]">
              {/* Step icon */}
              <div className="relative z-10 flex-shrink-0 flex items-start pt-0.5">
                {stage.state === "done" && (
                  <CheckCircle2 className="h-7 w-7 text-green-600 bg-background rounded-full" />
                )}
                {stage.state === "active" && (
                  <Clock className="h-7 w-7 text-amber-500 bg-background rounded-full" />
                )}
                {(stage.state === "pending" ||
                  stage.state === "skipped") && (
                  <Circle className="h-7 w-7 text-muted-foreground/40 bg-background rounded-full" />
                )}
                {stage.state === "rejected" && (
                  <XCircle className="h-7 w-7 text-destructive bg-background rounded-full" />
                )}
              </div>

              {/* Step content */}
              <div className={`flex-1 min-w-0 ${!isLast ? "pb-4" : ""}`}>
                <p
                  className={`text-sm font-medium leading-tight ${
                    stage.state === "done"
                      ? "text-foreground"
                      : stage.state === "active"
                      ? "text-amber-700"
                      : stage.state === "rejected"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                >
                  {stage.key === "no_proposal" ? (
                    <span className="text-destructive font-semibold">{stage.label}</span>
                  ) : stage.key === "activation_pending" ? (
                    <span className="text-amber-700">{stage.label}</span>
                  ) : stage.label}
                  {stage.state === "active" && awaitingLabel && (
                    <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full align-middle">
                      {awaitingLabel}
                    </span>
                  )}
                  {stage.key === "renewed" && (
                    <span className="ml-1.5 text-[10px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full align-middle">
                      Renewed
                    </span>
                  )}
                </p>
                {(stage.date || stage.actor) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {[fmt(stage.date), stage.actor ? `by ${stage.actor}` : null].filter(Boolean).join(" · ")}
                  </p>
                )}
                {stage.sub && (
                  <p
                    className={`text-xs mt-0.5 ${
                      stage.state === "rejected"
                        ? "text-destructive/70"
                        : stage.key === "activation_pending"
                        ? "text-amber-600"
                        : stage.key === "no_proposal"
                        ? "text-destructive/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {stage.key === "proposal_prorata" && contract.proposal_id ? (
                      <>via{" "}
                        <Link
                          href={`/proposals/${contract.proposal_id}`}
                          className="underline hover:text-foreground transition-colors"
                        >
                          {contract.proposal?.proposal_number ?? "proposal"}
                        </Link>
                      </>
                    ) : stage.sub}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
