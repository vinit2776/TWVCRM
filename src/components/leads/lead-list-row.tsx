"use client";

import Link from "next/link";
import { AlertTriangle, CalendarClock, Clock, MapPin } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { LeadQuickActions } from "@/components/leads/lead-quick-actions";
import { NextStepControls } from "@/components/leads/next-step-controls";
import { LeadHandlerChip } from "@/components/leads/lead-handler-chip";
import { LeadPinButton } from "@/components/leads/lead-pin-button";
import { LEAD_SOURCE_LABELS, WORKSPACE_TYPE_LABELS, ACTIVITY_TYPE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate, formatSmartDate } from "@/lib/utils";
import type { Lead } from "@/types";

/** A lead in these statuses has nothing left to do, so a missing next step is not a problem. */
const CLOSED_STATUSES = ["won", "lost", "junk"];

/** What the person wants: "Dedicated Desk · 4 seats · ₹9,000/seat". A form lead keeps this on its
 *  enquiry, so that fills in what the lead itself lacks; a WhatsApp lead has only what they wrote. */
function wantLine(lead: Lead): string | null {
  const enq = lead._enquiry;
  const type = lead.workspace_type ?? enq?.workspace_type;
  const seats = lead.seat_capacity ?? enq?.seat_capacity;
  const budget = lead.budget_per_seat ?? enq?.budget_per_seat;
  const parts: string[] = [];
  if (type) parts.push(WORKSPACE_TYPE_LABELS[type] ?? type.replace(/_/g, " "));
  if (seats) parts.push(`${seats} seat${seats === 1 ? "" : "s"}`);
  if (budget) parts.push(`${formatCurrency(budget)}/seat`);
  if (parts.length > 0) return parts.join(" · ");
  return enq?.message ? `“${enq.message.length > 90 ? `${enq.message.slice(0, 90)}…` : enq.message}”` : null;
}

/** The pending follow-up, worded as the next action it is. */
function NextAction({ lead }: { lead: Lead }) {
  const next = lead._followup?.next;
  if (!next) {
    if (CLOSED_STATUSES.includes(lead.status)) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="inline-flex items-center gap-1 text-amber-700">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" />
        No next step set
      </span>
    );
  }
  const overdue = next.days_overdue > 0;
  const today = !overdue && lead._followup?.due_today;
  const when = overdue
    ? `${next.days_overdue} day${next.days_overdue === 1 ? "" : "s"} overdue`
    : today
      ? "today"
      : formatDate(next.due_at);
  const what = next.notes || next.subject || ACTIVITY_TYPE_LABELS[next.type] || "Follow up";
  const Icon = overdue ? AlertTriangle : Clock;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${
        overdue ? "text-red-600" : today ? "text-amber-700" : "text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{when}</span>
      <span className="truncate text-muted-foreground">· {what}</span>
    </span>
  );
}

/**
 * One lead in three lines: who and where it stands, what they want and where, and what happens
 * next. Replaces the table whose columns were mostly hidden below wide screens.
 * `unread` marks a lead with a fresh enquiry; `reEnquiry` one who came back.
 */
export function LeadListRow({
  lead,
  unread,
  reEnquiry,
  onOpen,
  users,
  onChanged,
}: {
  lead: Lead;
  unread: boolean;
  reEnquiry: boolean;
  onOpen: () => void;
  /** People a lead can be handed to. */
  users: { id: string; full_name: string; role: string }[];
  /** Called after a one-tap action saves, so the list can reload. */
  onChanged: () => void;
}) {
  const want = wantLine(lead);
  const place = lead.location?.name ?? lead._enquiry?.preferred_location ?? null;
  const name = `${lead.first_name} ${lead.last_name}`.trim();

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={`cursor-pointer space-y-1 px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        lead.pinned_at
          ? "border-l-4 border-l-amber-500 bg-amber-50/70 hover:bg-amber-50 dark:bg-amber-950/20"
          : unread
          ? "bg-emerald-50/40 hover:bg-emerald-50 dark:bg-emerald-950/10"
          : reEnquiry
            ? "bg-amber-50/40 hover:bg-amber-50 dark:bg-amber-950/10"
            : "hover:bg-muted/30"
      }${lead.archived_at ? " opacity-60" : ""}`}
    >
      {/* Line 1: who, and where the lead stands */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {(unread || reEnquiry) && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${unread ? "bg-emerald-400" : "bg-amber-400"}`} />
              <span className={`relative inline-flex h-2 w-2 rounded-full ${unread ? "bg-emerald-500" : "bg-amber-500"}`} />
            </span>
          )}
          <Link
            href={`/leads/${lead.id}/activity`}
            onClick={(e) => e.stopPropagation()}
            className="truncate font-medium text-primary hover:underline"
          >
            {name}
          </Link>
          {lead.company && <span className="hidden truncate text-sm text-muted-foreground sm:inline">{lead.company}</span>}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{lead.lead_number}</span>
          {reEnquiry && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">Re-Enq</span>
          )}
          {lead.archived_at && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">Disabled</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {lead._stale && (
            <span
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600"
              title="Nothing has happened on this lead for a while. It is archived automatically once it has been quiet for 15 days, unless a follow-up is booked or it is pinned."
            >
              {lead._stale.state === "stale"
                ? "Stale"
                : `Stale in ${lead._stale.daysLeft} day${lead._stale.daysLeft === 1 ? "" : "s"}`}
            </span>
          )}
          <LeadPinButton lead={lead} onChanged={onChanged} />
          <StatusBadge type="lead_status" value={lead.status} />
        </div>
      </div>

      {/* Line 2: what they want, and where */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
        <span className={want ? "text-foreground" : ""}>{want ?? "No requirement recorded"}</span>
        {place && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            {place}
          </span>
        )}
      </div>

      {/* Line 3: what happens next, and how it came in */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 text-sm">
        <div className="min-w-0 max-w-full"><NextAction lead={lead} /></div>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>
            {LEAD_SOURCE_LABELS[lead.source] ?? lead.source} · {lead._enquiry ? "asked" : "added"} {formatSmartDate(lead._enquiry?.received_at ?? lead.created_at)}
          </span>
          <LeadHandlerChip lead={lead} users={users} onChanged={onChanged} />
        </span>
      </div>

      {/* Line 4: log what just happened, without opening the lead */}
      {!CLOSED_STATUSES.includes(lead.status) && !lead.archived_at && (
        <div className="space-y-1.5 pt-1">
          {lead._followup?.next?.activity_id && (
            <NextStepControls
              activityId={lead._followup.next.activity_id}
              hasNote={!!lead._followup.next.notes?.trim()}
              onChanged={onChanged}
            />
          )}
          <LeadQuickActions lead={lead} onChanged={onChanged} users={users} />
        </div>
      )}
    </div>
  );
}
