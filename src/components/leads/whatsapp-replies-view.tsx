"use client";

import { useLeadsHomeV2 } from "@/hooks/use-leads-home-v2";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import type { WaitTone } from "@/lib/whatsapp-replies";

type ReplyRow = {
  id: string;
  reference: string;
  lead_id: string | null;
  name: string | null;
  mobile_last4: string | null;
  claimed_by_name: string | null;
  mine: boolean;
  count: number;
  quiet_count: number;
  waiting_since: string;
  latest_text: string;
  tone: WaitTone;
};

const TONE: Record<WaitTone, string> = {
  ok: "bg-slate-100 text-slate-700",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
};

function waitingFor(since: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Open WhatsApp enquiries where the customer wrote after someone last acted. Replies are typed in
 * the WhatsApp app, so a person taps Replied once they have answered and the row clears until the
 * customer writes again.
 */
export function WhatsAppRepliesView({ onCounts }: { onCounts?: (counts: { mine: number; all: number }) => void }) {
  const v2 = useLeadsHomeV2();
  const router = useRouter();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [rows, setRows] = useState<ReplyRow[]>([]);
  const [counts, setCounts] = useState<{ mine: number; all: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/enquiries/replies${scope === "mine" ? "?mine=true" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load replies");
      setRows(json.data);
      setCounts(json.counts);
      onCounts?.(json.counts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load replies");
    } finally {
      setLoading(false);
    }
  }, [scope, onCounts]);

  useEffect(() => {
    setLoading(true);
    load();
    // Wait times and new messages move on their own; refresh without anyone reloading.
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function markReplied(row: ReplyRow) {
    setBusy(row.id);
    try {
      const res = await fetch(`/api/enquiries/${row.id}/replied`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not log the reply");
      toast.success(`Logged: replied on WhatsApp (${row.reference})`);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not log the reply");
    } finally {
      setBusy(null);
    }
  }

  const chip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      active ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"
    }`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className={chip(scope === "mine")} onClick={() => setScope("mine")}>
          Mine {counts ? counts.mine : ""}
        </button>
        <button className={chip(scope === "all")} onClick={() => setScope("all")}>
          Everyone {counts ? counts.all : ""}
        </button>
        <p className="ml-auto text-xs text-muted-foreground">
          Reply in WhatsApp, then tap Replied. The row comes back if the customer writes again.
        </p>
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title="Nobody is waiting for a reply"
          description={
            scope === "mine"
              ? "Every conversation you have taken on has been answered. Check Everyone for the team's."
              : "Every open WhatsApp conversation has been answered."
          }
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
                onClick={canOpen ? () => router.push(v2 ? `/leads/${r.lead_id}/activity` : `/leads/${r.lead_id}`) : undefined}
                onKeyDown={canOpen ? (e) => e.key === "Enter" && router.push(v2 ? `/leads/${r.lead_id}/activity` : `/leads/${r.lead_id}`) : undefined}
                className={`grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4 ${canOpen ? "cursor-pointer hover:bg-muted/30" : ""}`}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">{r.name ?? (r.mobile_last4 ? `+91 …${r.mobile_last4}` : "Unknown")}</span>
                    {r.name && r.mobile_last4 && <span className="text-xs text-muted-foreground">…{r.mobile_last4}</span>}
                    <span className="text-xs text-muted-foreground">{r.reference}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                      <MessageCircle className="h-3 w-3" />
                      {r.count} new {r.count === 1 ? "message" : "messages"}
                    </span>
                    {r.quiet_count > 0 && (
                      <span className="text-xs text-muted-foreground">
                        + {r.quiet_count} {r.quiet_count === 1 ? "acknowledgement" : "acknowledgements"}
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground" title={r.latest_text}>
                    “{r.latest_text}”
                  </p>
                  {!r.mine && r.claimed_by_name && (
                    <p className="text-xs text-muted-foreground">With {r.claimed_by_name}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 sm:justify-end">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[r.tone]}`}>
                    Waiting {waitingFor(r.waiting_since)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === r.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      markReplied(r);
                    }}
                  >
                    <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                    Replied
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
