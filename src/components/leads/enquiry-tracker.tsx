"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EnquiryQueueRow } from "@/components/enquiries/enquiry-queue-row";
import { EarlierEnquiries } from "@/components/leads/earlier-enquiries";
import {
  ENQUIRY_SOURCE_LABEL,
  toEnquiryItem,
  type EnquiryItem,
  type RawEnquiryRow,
  type ResolutionOutcome,
} from "@/lib/enquiries";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";

const WINDOW_DAYS = 30;
const SOURCE_KEYS = Object.keys(ENQUIRY_SOURCE_LABEL);
const OUTCOME_LABEL: Record<ResolutionOutcome | "superseded", string> = {
  converted: "Converted",
  not_interested: "Not interested",
  no_response: "No response",
  superseded: "Superseded",
};

type StateTab = "active" | "resolved" | "all";

const TAB_LABEL: Record<StateTab, string> = {
  active: "Active",
  resolved: "Resolved",
  all: "All",
};

export function EnquiryTracker() {
  const { items: liveItems, actionVersion } = useEnquiryNotifications();
  const [rows, setRows] = useState<EnquiryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<StateTab>("active");
  const [sourceTag, setSourceTag] = useState("");
  const [claimedBy, setClaimedBy] = useState(""); // "" = anyone, "none" = unclaimed, else user id
  const [outcome, setOutcome] = useState("");

  // Realtime claim / resolve / new-enquiry changes flow through the shared context;
  // this signature changes whenever one does, so the 30-day record refetches with it.
  const liveSignature = liveItems
    .map((i) => `${i.enquiryId}:${i.claimedBy ?? ""}:${i.resolvedAt ?? ""}`)
    .join("|");

  const load = useCallback(async () => {
    const from = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const res = await fetch(`/api/leads/enquiry-log?from=${encodeURIComponent(from)}&limit=500&include_unresolved=true`);
    if (res.ok) {
      const json = await res.json();
      setRows(
        ((json.data ?? []) as RawEnquiryRow[])
          .map(toEnquiryItem)
          .filter((i): i is EnquiryItem => i !== null)
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load, liveSignature, actionVersion]);

  // Safety net for a dropped realtime connection: other people's claims still show up.
  useEffect(() => {
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => !r.resolvedAt);
    // Superseded rows have no recorded outcome, so they stay out of resolved / conversion.
    const resolved = rows.filter((r) => r.resolvedAt && r.resolutionOutcome !== "superseded");
    const converted = resolved.filter((r) => r.resolutionOutcome === "converted").length;
    return {
      unclaimed: active.filter((r) => !r.claimedBy).length,
      claimed: active.filter((r) => r.claimedBy).length,
      resolved: resolved.length,
      conversion: resolved.length > 0 ? Math.round((converted / resolved.length) * 100) : 0,
    };
  }, [rows]);

  // Claimer options come from the rows themselves, so the filter lists exactly the people
  // who have claimed something in the window.
  const claimers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.claimedBy && r.claimerName) m.set(r.claimedBy, r.claimerName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const visible = useMemo(() => {
    return rows
      .filter((r) => (tab === "active" ? !r.resolvedAt : tab === "resolved" ? !!r.resolvedAt : true))
      .filter((r) => !sourceTag || r.sourceTag === sourceTag)
      .filter((r) => {
        if (!claimedBy) return true;
        if (claimedBy === "none") return !r.claimedBy;
        return r.claimedBy === claimedBy;
      })
      .filter((r) => !outcome || r.resolutionOutcome === outcome)
      .sort((a, b) => {
        const ar = a.resolvedAt ? 1 : 0;
        const br = b.resolvedAt ? 1 : 0;
        if (ar !== br) return ar - br;
        return new Date(b.attentionResetAt).getTime() - new Date(a.attentionResetAt).getTime();
      });
  }, [rows, tab, sourceTag, claimedBy, outcome]);

  const tiles = [
    { label: "Unclaimed", value: stats.unclaimed },
    { label: "Claimed, in progress", value: stats.claimed },
    { label: `Resolved, ${WINDOW_DAYS} days`, value: stats.resolved },
    { label: "Converted of resolved", value: `${stats.conversion}%` },
  ];

  return (
    <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/20 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-100/60 dark:bg-emerald-900/30 border-b border-emerald-300/60">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 uppercase tracking-wider">
            Public-form enquiries · last {WINDOW_DAYS} days
          </span>
        </div>
        <Link
          href="/leads/enquiry-log"
          className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
        >
          Enquiry log →
        </Link>
      </div>

      <div className="p-3 space-y-3">
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => (
            <Card key={t.label} className="p-3 gap-0">
              <p className="text-xl font-semibold tabular-nums">{t.value}</p>
              <p className="text-xs text-muted-foreground">{t.label}</p>
            </Card>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {(Object.keys(TAB_LABEL) as StateTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  tab === t
                    ? "bg-foreground text-background border-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          <Select value={sourceTag || "all"} onValueChange={(v) => setSourceTag(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-[140px] text-xs bg-background">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {SOURCE_KEYS.map((k) => (
                <SelectItem key={k} value={k}>
                  {ENQUIRY_SOURCE_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={claimedBy || "any"} onValueChange={(v) => setClaimedBy(v === "any" ? "" : v)}>
            <SelectTrigger className="h-8 w-[160px] text-xs bg-background">
              <SelectValue placeholder="Claimed by anyone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Claimed by anyone</SelectItem>
              <SelectItem value="none">Unclaimed</SelectItem>
              {claimers.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tab !== "active" && (
            <Select value={outcome || "any"} onValueChange={(v) => setOutcome(v === "any" ? "" : v)}>
              <SelectTrigger className="h-8 w-[150px] text-xs bg-background">
                <SelectValue placeholder="Any outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any outcome</SelectItem>
                {(Object.keys(OUTCOME_LABEL) as (ResolutionOutcome | "superseded")[]).map((o) => (
                  <SelectItem key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading enquiries…</p>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {tab === "active" ? "No open enquiries. Everything's been picked up." : "No enquiries match these filters."}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((item) => (
              <div key={item.enquiryId}>
                <EnquiryQueueRow item={item} />
                {item.isReEnquiry && <EarlierEnquiries leadId={item.leadId} currentId={item.enquiryId} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
