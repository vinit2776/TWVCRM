"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ExternalLink, Mail, MapPin, Phone } from "lucide-react";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { StatusBadge } from "@/components/shared/status-badge";
import { LeadHandlerChip } from "@/components/leads/lead-handler-chip";
import { HandOverButton } from "@/components/leads/hand-over-button";
import { ParkControl } from "@/components/leads/park-control";
import { KeepInformed } from "@/components/leads/keep-informed";
import { LeadPinButton } from "@/components/leads/lead-pin-button";
import { LeadQuickActions } from "@/components/leads/lead-quick-actions";
import { LeadOpenJobs } from "@/components/leads/lead-open-jobs";
import { NextStepChip, NoNextStepChip, ParkedChip } from "@/components/leads/next-step-chip";
import { useLead, useUsers } from "@/hooks/use-leads";
import { LEAD_SOURCE_LABELS, WORKSPACE_TYPE_LABELS } from "@/lib/constants";
import { dayLabel, istDayKey } from "@/lib/lead-days";
import { formatCurrency } from "@/lib/utils";
import { suggestRequirement } from "@/lib/requirement-hint";
import { toast } from "sonner";
import type { TimelineEvent, TimelineGroup } from "@/lib/lead-timeline";

type Filter = "all" | TimelineGroup;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "calls", label: "Calls & tours" },
  { key: "documents", label: "Documents & quotes" },
  { key: "money", label: "Contract & payments" },
  { key: "system", label: "System" },
];

const DOT: Record<TimelineGroup, string> = {
  calls: "border-blue-500",
  documents: "border-primary",
  money: "border-emerald-600",
  system: "border-slate-300",
};

const CLOSED = ["won", "lost", "junk"];

interface Timeline {
  events: TimelineEvent[];
  stale?: { state: "active" } | { state: "warning"; daysLeft: number } | { state: "stale"; daysQuiet: number };
  requirement: {
    workspace_type: string | null;
    seat_capacity: number | null;
    budget_per_seat: number | null;
    preferred_location: string | null;
  } | null;
  next_step: { activity_id: string; due_at: string; notes: string | null; subject: string | null } | null;
  truncated: boolean;
}

const istTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

function actorText(e: TimelineEvent): string {
  if (e.actorKind === "customer") return e.actor ? `${e.actor} (customer)` : "Customer";
  if (e.actorKind === "system") return e.actor ?? "System";
  return e.actor ?? "Team member";
}

export default function LeadActivityPage() {
  const { id } = useParams<{ id: string }>();
  const { data: lead, refetch: refetchLead } = useLead(id);
  const { users } = useUsers();
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const loadTimeline = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${id}/timeline`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setTimeline(json.data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  const changed = () => {
    refetchLead();
    void loadTimeline();
  };

  const days = useMemo(() => {
    const shown = (timeline?.events ?? []).filter((e) => filter === "all" || e.group === filter);
    const out: { key: string; events: TimelineEvent[] }[] = [];
    for (const e of shown) {
      const key = istDayKey(e.at);
      const last = out[out.length - 1];
      if (last && last.key === key) last.events.push(e);
      else out.push({ key, events: [e] });
    }
    return out;
  }, [timeline, filter]);

  if (!lead) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  // "-" is the stored placeholder for a customer who gave one name; it is not part of the name.
  const name = `${lead.first_name} ${lead.last_name === "-" ? "" : lead.last_name}`.trim();
  const closed = CLOSED.includes(lead.status) || !!lead.archived_at;
  const req = timeline?.requirement;
  const type = lead.workspace_type ?? req?.workspace_type;
  const seats = lead.seat_capacity ?? req?.seat_capacity;
  const budget = lead.budget_per_seat ?? req?.budget_per_seat;
  const want = [
    type ? (WORKSPACE_TYPE_LABELS[type] ?? type) : null,
    seats ? `${seats} seat${seats === 1 ? "" : "s"}` : null,
    budget ? `${formatCurrency(budget)}/seat` : null,
  ].filter(Boolean);
  const place = lead.location?.name ?? req?.preferred_location ?? null;
  // Nothing recorded yet: offer what the customer's message and the team's notes already say.
  const hint =
    want.length === 0 && !closed
      ? suggestRequirement((timeline?.events ?? []).flatMap((e) => [e.title, e.detail]))
      : null;
  const hintText = hint
    ? [
        hint.workspace_type ? (WORKSPACE_TYPE_LABELS[hint.workspace_type] ?? hint.workspace_type) : null,
        hint.seat_capacity ? `${hint.seat_capacity} seat${hint.seat_capacity === 1 ? "" : "s"}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const applyHint = async () => {
    if (!hint) return;
    const res = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(hint.workspace_type ? { workspace_type: hint.workspace_type } : {}),
        ...(hint.seat_capacity ? { seat_capacity: hint.seat_capacity } : {}),
      }),
    });
    if (res.ok) {
      toast.success("Requirement saved");
      changed();
    } else {
      toast.error("Could not save the requirement");
    }
  };
  const next = timeline?.next_step ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageBreadcrumb current={{ label: name }} fallbackParent={{ href: "/leads", label: "Leads" }} />

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-bold">{name}</h1>
              {lead.company && <span className="text-muted-foreground">· {lead.company}</span>}
              <StatusBadge type="lead_status" value={lead.status} />
              <LeadPinButton lead={lead} onChanged={changed} withLabel />
              {!closed && <HandOverButton leadId={id} leadName={name} onDone={changed} />}
              <ParkControl leadId={id} parkedAt={lead.parked_at} closed={closed} onChanged={changed} />
              <KeepInformed leadId={id} closed={closed} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{LEAD_SOURCE_LABELS[lead.source] ?? lead.source}</span>
              {(lead.mobile || lead.phone) && (
                <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{lead.mobile || lead.phone}</span>
              )}
              {lead.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{lead.email}</span>}
              <LeadHandlerChip lead={lead} users={users} onChanged={changed} />
            </div>
          </div>
          <Link
            href={`/leads/${id}`}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-sm font-medium hover:bg-muted"
          >
            Full lead record <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="text-sm">
          <span className="text-muted-foreground">Wants </span>
          <span className="font-medium">{want.length > 0 ? want.join(" · ") : "no requirement recorded"}</span>
          {hintText && (
            <button
              type="button"
              onClick={() => void applyHint()}
              className="ml-2 rounded-full border border-dashed border-primary px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/5"
              title="Read from the customer's message and your notes. Click to save it on the lead."
            >
              Add: {hintText}
            </button>
          )}
          {place && (
            <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground"><MapPin className="h-3.5 w-3.5" />{place}</span>
          )}
        </div>

        {/* The next step, always on top */}
        {!CLOSED.includes(lead.status) && (
          <div>
            {next ? (
              <NextStepChip leadId={lead.id} next={next} onChanged={changed} />
            ) : lead.parked_at ? (
              <span className="flex flex-wrap items-center gap-2.5 text-sm">
                <ParkedChip />
                <span className="text-muted-foreground">Comes back when someone takes it out of Waiting for space</span>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-2.5 text-sm">
                <NoNextStepChip />
                <span className="text-muted-foreground">Log an action below to set one</span>
              </span>
            )}
          </div>
        )}

        {!closed && <LeadOpenJobs leadId={id} version={timeline} />}

        {timeline?.stale && timeline.stale.state !== "active" && (
          <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {timeline.stale.state === "stale" ? (
              <>
                <b>Stale.</b> Nothing has happened for {timeline.stale.daysQuiet} days. It will be archived automatically.
              </>
            ) : (
              <>
                <b>Stale in {timeline.stale.daysLeft} day{timeline.stale.daysLeft === 1 ? "" : "s"}.</b> Nothing has happened for a while.
              </>
            )}{" "}
            Log a call, book a follow-up or pin it to keep it.
          </div>
        )}

        {!closed && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Log what just happened (each action asks for the next step before saving):</div>
            <LeadQuickActions lead={lead} onChanged={changed} users={users} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-sm ${
              filter === f.key ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border p-4">
        {failed && <p className="text-sm text-red-600">Could not load the activity. Refresh to try again.</p>}
        {!failed && !timeline && <p className="text-sm text-muted-foreground">Loading activity…</p>}
        {timeline && days.length === 0 && <p className="text-sm text-muted-foreground">Nothing here yet.</p>}
        {days.map((day) => (
          <div key={day.key} className="mb-2">
            <div className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">{dayLabel(day.key)}</div>
            <div className="ml-2 border-l-2">
              {day.events.map((e) => (
                <div key={e.id} className="relative pb-4 pl-5">
                  <span className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full border-[3px] bg-background ${DOT[e.group]}`} />
                  <div className="text-xs text-muted-foreground">
                    {istTime(e.at)} · {actorText(e)}
                  </div>
                  <div className="font-medium">{e.title}</div>
                  {e.detail && <div className="whitespace-pre-line text-sm text-muted-foreground">{e.detail}</div>}
                  {e.links.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {e.links.map((l) => (
                        <Link
                          key={l.href + l.label}
                          href={l.href}
                          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          {l.label} <ExternalLink className="h-3 w-3" />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {timeline?.truncated && <p className="text-xs text-muted-foreground">Showing the most recent activity.</p>}
      </div>
    </div>
  );
}
