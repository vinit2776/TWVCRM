"use client";

import { CheckCircle2, Circle, XCircle, Clock } from "lucide-react";
import type { Lead, LeadStatus } from "@/types";

interface Props {
  lead: Lead;
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

const STATUS_ORDER: Record<LeadStatus, number> = {
  new: 0,
  contacted: 1,
  tour_scheduled: 2,
  tour_completed: 3,
  proposal_sent: 4,
  negotiating: 5,
  won: 6,
  lost: 6,
  junk: -1,
};

/** Badge text shown on the single active step — reflects actual current status */
const ACTIVE_BADGE: Partial<Record<LeadStatus, string>> = {
  new: "Awaiting Contact",
  contacted: "Tour Pending",
  tour_scheduled: "Tour Scheduled",
  tour_completed: "Awaiting Proposal",
  proposal_sent: "Awaiting Decision",
  negotiating: "In Negotiation",
};

type StageState = "done" | "active" | "pending" | "rejected";

interface Stage {
  key: string;
  label: string;
  sub?: string;
  date?: string | null;
  state: StageState;
}

export function LeadLifecycle({ lead }: Props) {
  const rank = STATUS_ORDER[lead.status];
  const isWon = lead.status === "won";
  const isLost = lead.status === "lost";

  const stages: Stage[] = [
    // 1. Enquiry Received — always done, dated
    {
      key: "enquiry",
      label: "Enquiry Received",
      date: lead.created_at,
      state: "done",
    },
    // 2. First Contact
    {
      key: "contact",
      label: "First Contact Made",
      state: rank >= 1 ? "done" : "active",
    },
    // 3. Site Tour — active for both "contacted" and "tour_scheduled"
    {
      key: "tour",
      label: "Site Tour",
      sub:
        lead.status === "tour_scheduled"
          ? "Tour is scheduled"
          : lead.status === "tour_completed"
          ? "Tour completed"
          : undefined,
      state:
        rank >= 3 ? "done" : rank >= 1 ? "active" : "pending",
    },
    // 4. Proposal Sent
    {
      key: "proposal",
      label: "Proposal Sent",
      state:
        rank >= 4
          ? "done"
          : rank === 3
          ? "active"
          : "pending",
    },
    // 5. Negotiating
    {
      key: "negotiating",
      label: "Negotiating",
      state:
        isWon || rank >= 5
          ? "done"
          : rank === 4
          ? "active"
          : "pending",
    },
  ];

  // 6. Terminal outcome
  if (isWon) {
    stages.push({
      key: "won",
      label: "Deal Won",
      date: lead.converted_at,
      state: "done",
    });
  } else if (isLost) {
    stages.push({
      key: "lost",
      label: "Deal Lost",
      date: lead.lost_at,
      sub: lead.lost_reason || undefined,
      state: "rejected",
    });
  } else {
    stages.push({
      key: "outcome",
      label: "Outcome",
      state: rank >= 5 ? "active" : "pending",
    });
  }

  const activeBadge = ACTIVE_BADGE[lead.status];

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
                {stage.state === "pending" && (
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
                  {stage.label}
                  {/* "Won" badge */}
                  {stage.key === "won" && (
                    <span className="ml-1.5 text-[10px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full align-middle">
                      Converted
                    </span>
                  )}
                  {/* Current stage badge — shown on the active step */}
                  {stage.state === "active" && activeBadge && (
                    <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full align-middle">
                      {activeBadge}
                    </span>
                  )}
                </p>
                {stage.date && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {fmt(stage.date)}
                  </p>
                )}
                {stage.sub && (
                  <p
                    className={`text-xs mt-0.5 ${
                      stage.state === "rejected"
                        ? "text-destructive/70"
                        : "text-muted-foreground"
                    }`}
                  >
                    {stage.sub}
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
