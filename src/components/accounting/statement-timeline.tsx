"use client";

/**
 * Timeline of milestone events for a statement.
 *
 * Fetches /api/accounting/inbox?id=<statementId>&include=timeline once on
 * mount and renders the events chronologically. Designed to be embedded
 * inside <ViewStatementDialog> or the contract page.
 *
 * Event sources are documented server-side in route.ts buildTimelineEvents().
 */

import { useEffect, useState } from "react";
import {
  FileText, Send, FileCheck, BanknoteArrowDown, AlertCircle, RefreshCw, History, XCircle,
} from "lucide-react";
import type {
  InboxResponse, InboxRow, TimelineEvent, TimelineEventKind,
} from "@/lib/tally-handoff";

function iconFor(kind: TimelineEventKind) {
  switch (kind) {
    case "statement_created": return FileText;
    case "pi_sent": return Send;
    case "payment_received": return BanknoteArrowDown;
    case "gst_uploaded": return FileCheck;
    case "gst_sent": return Send;
    case "state_changed": return RefreshCw;
    case "voided": return XCircle;
  }
}

function colorFor(kind: TimelineEventKind): string {
  switch (kind) {
    case "statement_created": return "text-muted-foreground";
    case "pi_sent": return "text-blue-700";
    case "payment_received": return "text-green-700";
    case "gst_uploaded": return "text-blue-700";
    case "gst_sent": return "text-green-700";
    case "state_changed": return "text-muted-foreground";
    case "voided": return "text-red-700";
  }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export interface StatementTimelineProps {
  statementId: string;
  /** Optional max height with vertical scroll. */
  maxHeight?: string;
}

export function StatementTimeline({ statementId, maxHeight }: StatementTimelineProps) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/accounting/inbox?id=${encodeURIComponent(statementId)}&include=timeline`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as InboxResponse;
        const row: InboxRow | undefined = json.rows[0];
        if (!cancelled) setEvents(row?.timeline_events ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load timeline");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [statementId]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-1 py-2">
        <History className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        Loading timeline…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-1">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
        <span>Timeline unavailable: {error}</span>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        No events recorded yet.
      </div>
    );
  }

  return (
    <ol
      className="space-y-2 relative"
      style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
    >
      {events.map((ev, i) => {
        const Icon = iconFor(ev.kind);
        return (
          <li key={`${ev.kind}-${ev.at}-${i}`} className="flex items-start gap-2 pl-1">
            <div className={`flex-shrink-0 mt-0.5 ${colorFor(ev.kind)}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </div>
            <div className="flex-1 min-w-0 text-xs">
              <div className="font-medium truncate" title={ev.label}>{ev.label}</div>
              <div className="text-muted-foreground">{fmtDateTime(ev.at)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
