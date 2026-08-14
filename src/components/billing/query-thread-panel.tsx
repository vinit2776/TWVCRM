"use client";

import { useEffect, useState, useCallback } from "react";
import { MessageCircleQuestion, CheckCircle2, RotateCcw, Loader2, Bell } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useCurrentUser } from "@/providers/current-user-provider";
import type { BillingQueryThread } from "@/lib/billing-queries";

interface Props {
  statementId: string;
  /** Pass a known query id (Billing Queries page card) to skip the
   *  statement lookup and fetch that thread directly. Omit (Tally Inbox
   *  row) to auto-discover the statement's most recent thread, or show an
   *  "ask a question" composer if none exists yet. */
  initialQueryId?: string | null;
  /** Called after any mutation (created / replied / resolved / reopened)
   *  so the caller can refresh whatever count/badge it's showing. */
  onChanged?: () => void;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function QueryThreadPanel({ statementId, initialQueryId, onChanged }: Props) {
  const { user } = useCurrentUser();
  const [loading, setLoading] = useState(true);
  const [thread, setThread] = useState<BillingQueryThread | null>(null);
  const [checkedForExisting, setCheckedForExisting] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThread = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing-queries/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { thread: BillingQueryThread };
      setThread(json.thread);
    } catch {
      setError("Could not load this query.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialQueryId) {
      void loadThread(initialQueryId);
      return;
    }
    // Auto-discover: does this statement already have a query thread?
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/billing-queries?statement_id=${encodeURIComponent(statementId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { items: Array<{ id: string }> };
        if (json.items.length > 0) {
          await loadThread(json.items[0].id);
        }
      } catch {
        // Silent — falls through to the "ask a question" composer.
      } finally {
        setCheckedForExisting(true);
        setLoading(false);
      }
    })();
  }, [statementId, initialQueryId, loadThread]);

  async function askQuestion() {
    const body = composerText.trim();
    if (!body) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/billing-queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_statement_id: statementId, body }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to send");
      }
      const { id } = (await res.json()) as { id: string };
      setComposerText("");
      await loadThread(id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSubmitting(false);
    }
  }

  async function reply(resolve: boolean) {
    if (!thread) return;
    const body = composerText.trim();
    if (!resolve && !body) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing-queries/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body || undefined, resolve }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Failed to send");
      }
      setComposerText("");
      await loadThread(thread.id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSubmitting(false);
    }
  }

  async function reopen() {
    if (!thread) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing-queries/${thread.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "open" }),
      });
      if (!res.ok) throw new Error("Failed to reopen");
      await loadThread(thread.id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reopen");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  // No thread for this statement yet — offer to start one (Tally Inbox
  // context only; the Billing Queries page always passes initialQueryId).
  if (!thread) {
    if (!checkedForExisting && !initialQueryId) return null;
    return (
      <div className="space-y-2">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder="Ask a question about this statement…"
            className="flex-1 text-xs border rounded p-2 resize-none bg-background"
          />
          <button
            type="button"
            onClick={askQuestion}
            disabled={submitting || !composerText.trim()}
            className="inline-flex items-center gap-1 text-xs px-3 py-2 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50 flex-shrink-0"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageCircleQuestion className="h-3 w-3" />}
            Ask
          </button>
        </div>
      </div>
    );
  }

  const isResolved = thread.status === "resolved";
  const canResolve = user?.id === thread.created_by.id || user?.role === "admin";

  return (
    <div className="space-y-2.5">
      <div className="rounded border bg-muted/40 px-2.5 py-2 text-xs">
        <span className="text-muted-foreground">{thread.statement.context_label}</span>
        {" · "}
        <span className="font-medium">{thread.statement.party_name}</span>
        {" · "}
        <span className="tabular-nums">{formatCurrency(thread.statement.total_amount)}</span>
      </div>

      <div
        className="text-[11px] text-muted-foreground px-0.5"
        title="Admin and office_admin can see and reply to every query, but aren't emailed/WhatsApp-escalated for each one — they're monitoring, not on the hook to respond."
      >
        <Bell className="h-2.5 w-2.5 inline mr-1 -mt-0.5" />
        Alerted by email: Accounts, Manager, Sales Rep — admin can monitor and reply but isn&apos;t alerted
      </div>

      <div className="space-y-2">
        {thread.messages.map((m) => {
          if (m.event_type !== "message") {
            return (
              <div key={m.id} className="text-[11px] text-muted-foreground flex items-center gap-1 pl-1">
                {m.event_type === "resolved" ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <RotateCcw className="h-3 w-3" />}
                {m.event_type === "resolved" ? "Resolved" : "Reopened"} by {m.created_by.full_name} · {timeAgo(m.created_at)}
                {m.body && <span className="italic">— {m.body}</span>}
              </div>
            );
          }
          const isAsker = m.created_by.role === "accounts";
          return (
            <div
              key={m.id}
              className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                isAsker ? "bg-amber-50 border border-amber-200 text-amber-900" : "bg-muted"
              }`}
            >
              <div className="flex items-center justify-between text-[11px] font-semibold mb-0.5 opacity-80">
                <span>{m.created_by.full_name} ({m.created_by.role})</span>
                <span className="font-normal opacity-75">{timeAgo(m.created_at)}</span>
              </div>
              {m.body}
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {isResolved ? (
        <button
          type="button"
          onClick={reopen}
          disabled={submitting}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
          Reopen
        </button>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder={`Reply${canResolve ? " or resolve" : ""}…`}
            className="flex-1 text-xs border rounded p-2 resize-none bg-background"
          />
          <div className="flex flex-col gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => reply(false)}
              disabled={submitting || !composerText.trim()}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              Send
            </button>
            {canResolve && (
              <button
                type="button"
                onClick={() => reply(true)}
                disabled={submitting}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-green-300 text-green-800 hover:bg-green-50 disabled:opacity-50"
                title="Only the person who asked, or an admin, can resolve"
              >
                <CheckCircle2 className="h-3 w-3" /> Resolve
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
