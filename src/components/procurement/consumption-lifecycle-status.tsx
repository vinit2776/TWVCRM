"use client";

import { ClipboardList, XCircle, PencilLine, RefreshCw } from "lucide-react";
import type { ConsumptionLog } from "@/types";

/**
 * ConsumptionLifecycleStatus — a compact audit timeline for a consumption log:
 * when it was logged, and every correction (void / adjust / re-log) applied
 * since, with who did it and why. Mirrors the transfer lifecycle view.
 */

interface TimelineEvent {
  kind: "logged" | "void" | "adjust" | "relog";
  at: string;
  by?: string | null;
  reason?: string | null;
}

const EVENT_META: Record<TimelineEvent["kind"], { label: string; Icon: React.ElementType; dot: string; icon: string }> = {
  logged: { label: "Logged",     Icon: ClipboardList, dot: "bg-green-500",  icon: "text-white" },
  void:   { label: "Voided",     Icon: XCircle,       dot: "bg-red-500",    icon: "text-white" },
  adjust: { label: "Adjusted",   Icon: PencilLine,    dot: "bg-amber-500",  icon: "text-white" },
  relog:  { label: "Re-logged",  Icon: RefreshCw,     dot: "bg-blue-500",   icon: "text-white" },
};

interface CorrectionRow {
  correction_type?: string | null;
  created_at?: string | null;
  reason?: string | null;
  corrector?: { full_name?: string | null } | null;
}

export function ConsumptionLifecycleStatus({ log }: { log: ConsumptionLog }) {
  const corrections = (log.consumption_corrections ?? []) as CorrectionRow[];

  // Corrections are stored one row per item; collapse to one event per action
  // (same type + timestamp + reason).
  const grouped = new Map<string, TimelineEvent>();
  for (const c of corrections) {
    const kind = (c.correction_type as TimelineEvent["kind"]) ?? "adjust";
    if (!EVENT_META[kind]) continue;
    const key = `${kind}|${c.created_at}|${c.reason ?? ""}`;
    if (!grouped.has(key)) {
      grouped.set(key, { kind, at: c.created_at ?? "", by: c.corrector?.full_name, reason: c.reason });
    }
  }

  const loggedEvent: TimelineEvent = { kind: "logged", at: log.logged_at, by: log.logger?.full_name };
  const events: TimelineEvent[] = [loggedEvent, ...Array.from(grouped.values())].sort(
    (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  );

  const fmt = (ts: string) => {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    } catch {
      return ts;
    }
  };

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-muted-foreground mb-2">History</p>
      <ol className="space-y-0">
        {events.map((e, i) => {
          const meta = EVENT_META[e.kind];
          const Icon = meta.Icon;
          const isLast = i === events.length - 1;
          return (
            <li key={i} className="flex gap-3">
              {/* dot + connector */}
              <div className="flex flex-col items-center">
                <span className={`h-5 w-5 rounded-full flex items-center justify-center ${meta.dot}`}>
                  <Icon className={`h-3 w-3 ${meta.icon}`} />
                </span>
                {!isLast && <span className="w-px flex-1 bg-border my-0.5" />}
              </div>
              {/* content */}
              <div className={`pb-3 ${isLast ? "pb-0" : ""} min-w-0`}>
                <p className="text-xs font-medium">
                  {meta.label}
                  {e.by && <span className="text-muted-foreground font-normal"> · {e.by}</span>}
                </p>
                <p className="text-[10px] text-muted-foreground">{fmt(e.at)}</p>
                {e.reason && <p className="text-[11px] text-muted-foreground mt-0.5 italic">“{e.reason}”</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
