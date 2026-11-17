"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Megaphone, MessageCircle } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { formatSmartDate } from "@/lib/utils";
import {
  INBOUND_GROUPS,
  INBOUND_GROUP_LABEL,
  inboundOutcomeDetail,
  type InboundGroup,
} from "@/lib/whatsapp-inbound-log";

type LogRow = {
  id: string;
  at: string;
  number_last10: string | null;
  name: string | null;
  message: string | null;
  message_type: string | null;
  is_ad_reply: boolean;
  ad_headline: string | null;
  outcome: string | null;
  group: InboundGroup;
  reference: string | null;
  lead_id: string | null;
};

const GROUP_TONE: Record<InboundGroup, string> = {
  new: "bg-emerald-100 text-emerald-800",
  re_enquiry: "bg-amber-100 text-amber-800",
  follow_up: "bg-blue-100 text-blue-800",
  junk: "bg-red-50 text-red-700",
  held: "bg-violet-100 text-violet-800",
  ignored: "bg-slate-100 text-slate-700",
  other: "bg-slate-100 text-slate-700",
  untracked: "bg-slate-50 text-slate-500 border border-dashed border-slate-300",
};

const WINDOWS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

/**
 * Every inbound WhatsApp message and what the CRM did with it, so "did it arrive, and where did it
 * go" can be answered without asking an engineer. Read-only; the cards stay the place to act.
 */
export function InboundWhatsAppLog() {
  const router = useRouter();
  const [group, setGroup] = useState<InboundGroup | "all">("all");
  const [source, setSource] = useState<"any" | "ad" | "direct">("any");
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [counts, setCounts] = useState<Record<InboundGroup, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ days: String(days) });
    if (group !== "all") params.set("group", group);
    if (source !== "any") params.set("source", source);
    try {
      const res = await fetch(`/api/whatsapp/inbound-log?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load the log");
      setRows(json.data);
      setCounts(json.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the log");
    } finally {
      setLoading(false);
    }
  }, [group, source, days]);

  useEffect(() => {
    load();
  }, [load]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"
    }`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={chip(group === "all")} onClick={() => setGroup("all")}>
          All {counts ? total : ""}
        </button>
        {INBOUND_GROUPS.filter((g) => g !== "untracked" || (counts?.untracked ?? 0) > 0).map((g) => (
          <button key={g} className={chip(group === g)} onClick={() => setGroup(g)}>
            {INBOUND_GROUP_LABEL[g]} {counts ? counts[g] : ""}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Source:
        {(
          [
            ["any", "Any"],
            ["ad", "Ad reply"],
            ["direct", "Direct message"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={chip(source === key)} onClick={() => setSource(key)}>
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button key={w.days} className={chip(days === w.days)} onClick={() => setDays(w.days)}>
              {w.label}
            </button>
          ))}
        </span>
      </div>

      {loading ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No messages in this view"
          description="Nothing matches these filters. Widen the window or pick All."
        />
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((r) => {
            const canOpen = !!r.lead_id;
            return (
              <div
                key={r.id}
                role={canOpen ? "link" : undefined}
                tabIndex={canOpen ? 0 : undefined}
                onClick={canOpen ? () => router.push(`/leads/${r.lead_id}`) : undefined}
                onKeyDown={canOpen ? (e) => e.key === "Enter" && router.push(`/leads/${r.lead_id}`) : undefined}
                className={`grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[110px_1fr_220px] sm:gap-4 ${canOpen ? "cursor-pointer hover:bg-muted/30" : ""}`}
              >
                <span className="text-xs text-muted-foreground">{formatSmartDate(r.at)}</span>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className="font-medium">{r.name ?? (r.number_last10 ? `+91 …${r.number_last10.slice(-4)}` : "Unknown number")}</span>
                    {r.name && r.number_last10 && <span className="text-xs text-muted-foreground">…{r.number_last10.slice(-4)}</span>}
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      {r.is_ad_reply ? <Megaphone className="h-3 w-3" /> : <MessageCircle className="h-3 w-3" />}
                      {r.is_ad_reply ? "Ad reply" : "Direct message"}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground" title={r.message ?? undefined}>
                    {r.message ? `“${r.message}”` : `[${r.message_type ?? "message"}]`}
                  </p>
                </div>
                <div className="space-y-0.5 sm:text-right">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${GROUP_TONE[r.group]}`}>
                    {INBOUND_GROUP_LABEL[r.group]}
                  </span>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground sm:justify-end">
                    {inboundOutcomeDetail(r.outcome, r.reference)}
                    {canOpen && <ArrowRight className="h-3 w-3 shrink-0" />}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
