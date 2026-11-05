"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LeadListRow } from "@/components/leads/lead-list-row";
import { dayLabel, istDayKey } from "@/lib/lead-days";
import { nextStepChip } from "@/lib/next-step-chip";
import { FOLLOW_UP_GROUPS, type FollowUpGroup } from "@/lib/follow-up-groups";
import type { Lead } from "@/types";

export interface FollowUpFilters {
  search: string;
  status: string;
  sources: string[];
  locationId: string | null;
  assignedTo: string;
  pinned: boolean;
}

interface FollowUpsResponse {
  counts: Record<FollowUpGroup, number>;
  ids: string[];
  due: Record<string, string>;
  dateCounts: Record<string, number>;
  total: number;
}

const PILLS: Record<FollowUpGroup, { label: string; tone: string; count: string }> = {
  overdue: { label: "Overdue", tone: "border-red-200 text-red-700", count: "bg-red-600 text-white" },
  today: { label: "Today", tone: "border-amber-200 text-amber-700", count: "bg-amber-600 text-white" },
  tomorrow: { label: "Tomorrow", tone: "border-emerald-200 text-emerald-700", count: "bg-emerald-600 text-white" },
  week: { label: "This week", tone: "border-emerald-200 text-emerald-700", count: "bg-emerald-600 text-white" },
  later: { label: "Later", tone: "border-slate-200 text-slate-600", count: "bg-slate-600 text-white" },
  none: { label: "No next step", tone: "border-dashed border-amber-600 bg-amber-50 text-amber-700", count: "bg-amber-600 text-white" },
};

const PAGE_SIZE = 50;

/** The header over a date: "Fri 16 Oct · 20 days overdue", "Today · Thu 5 Nov", "Tomorrow · Fri 6 Nov". */
function headerLabel(key: string, group: FollowUpGroup, sampleDue: string): string {
  if (group === "overdue") return `${dayLabel(key).replace(/^.*? · /, "")} · ${nextStepChip(sampleDue).big}`;
  const tomorrow = istDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return key === tomorrow ? `Tomorrow · ${dayLabel(key)}` : dayLabel(key);
}

const HEADER_TONE: Record<FollowUpGroup, string> = {
  overdue: "text-red-700",
  today: "text-amber-700",
  tomorrow: "text-emerald-700",
  week: "text-emerald-700",
  later: "text-slate-600",
  none: "text-amber-700",
};

export function FollowUpsView({
  filters,
  users,
  isUnread,
  isReEnquiry,
  onOpenLead,
}: {
  filters: FollowUpFilters;
  users: { id: string; full_name: string; role: string }[];
  isUnread: (lead: Lead) => boolean;
  isReEnquiry: (lead: Lead) => boolean;
  onOpenLead: (lead: Lead) => void;
}) {
  const [group, setGroup] = useState<FollowUpGroup>("overdue");
  const [data, setData] = useState<FollowUpsResponse | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [due, setDue] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterKey = JSON.stringify(filters);

  // One page of the chosen group: the ids and their order, then the rows themselves.
  const loadPage = useCallback(
    async (page: number) => {
      const f = JSON.parse(filterKey) as FollowUpFilters;
      const params = new URLSearchParams({ group, page: String(page), limit: String(PAGE_SIZE) });
      if (f.search) params.set("search", f.search);
      if (f.status) params.set("status", f.status);
      if (f.sources.length > 0) params.set("source", f.sources.join(","));
      if (f.locationId) params.set("location_id", f.locationId);
      if (f.assignedTo) params.set("assigned_to", f.assignedTo);
      if (f.pinned) params.set("pinned", "true");

      const res = await fetch(`/api/leads/follow-ups?${params}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not load follow-ups");
      const json = (await res.json()) as FollowUpsResponse;

      let rows: Lead[] = [];
      if (json.ids.length > 0) {
        const rowsRes = await fetch(`/api/leads?view=ids&ids=${json.ids.join(",")}&page=1&limit=${json.ids.length}`);
        if (!rowsRes.ok) throw new Error("Could not load the leads");
        rows = ((await rowsRes.json()).data ?? []) as Lead[];
      }
      return { json, rows };
    },
    [group, filterKey]
  );

  const reload = useCallback(async () => {
    try {
      const { json, rows } = await loadPage(1);
      setData(json);
      setLeads(rows);
      setDue(json.due);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [loadPage]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const showMore = async () => {
    setLoadingMore(true);
    try {
      const { json, rows } = await loadPage(Math.floor(leads.length / PAGE_SIZE) + 1);
      setData(json);
      setLeads((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.id === r.id))]);
      setDue((prev) => ({ ...prev, ...json.due }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  };

  // The loaded leads under a header for each date, in the order the server sent them.
  const sections = useMemo(() => {
    if (group === "none") return [{ key: "none", label: "No next step · needs one", sub: "newest first", leads }];
    const out: { key: string; label: string; sub: string; leads: Lead[] }[] = [];
    for (const lead of leads) {
      const iso = due[lead.id];
      const key = iso ? istDayKey(iso) : "x";
      const last = out[out.length - 1];
      if (last && last.key === key) last.leads.push(lead);
      else out.push({ key, label: iso ? headerLabel(key, group, iso) : "", sub: "", leads: [lead] });
    }
    return out;
  }, [leads, due, group]);

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 flex flex-wrap gap-2 border-b bg-background py-3">
        {FOLLOW_UP_GROUPS.map((g) => {
          const p = PILLS[g];
          const on = group === g;
          return (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${p.tone} ${on ? "ring-2 ring-foreground ring-inset" : "hover:bg-muted"}`}
            >
              {p.label}
              <span className={`rounded-full px-1.5 text-[11px] font-bold ${p.count}`}>{data?.counts[g] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {loading && !data ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading follow-ups…</div>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
          {group === "none" ? "Every open lead has a next step." : "Nothing here with the current filters."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {sections.map((s) => (
            <div key={s.key}>
              <div className="flex justify-between border-b border-t bg-muted/40 px-4 py-2 text-[13px] first:border-t-0">
                <b className={HEADER_TONE[group]}>{s.label}</b>
                <span className="text-muted-foreground">
                  {group === "none" ? data?.total ?? s.leads.length : data?.dateCounts[s.key] ?? s.leads.length} lead
                  {(group === "none" ? data?.total ?? s.leads.length : data?.dateCounts[s.key] ?? s.leads.length) === 1 ? "" : "s"}
                  {s.sub ? ` · ${s.sub}` : ""}
                </span>
              </div>
              <div className="divide-y">
                {s.leads.map((lead) => {
                  const unread = isUnread(lead);
                  return (
                    <LeadListRow
                      key={lead.id}
                      lead={lead}
                      unread={unread}
                      reEnquiry={!unread && isReEnquiry(lead)}
                      users={users}
                      onChanged={() => void reload()}
                      onOpen={() => onOpenLead(lead)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          {data && leads.length < data.total && (
            <div className="border-t px-4 py-3 text-center">
              <Button type="button" variant="ghost" size="sm" disabled={loadingMore} onClick={() => void showMore()}>
                {loadingMore && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Show more ({data.total - leads.length} left)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
