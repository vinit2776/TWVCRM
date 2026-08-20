"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, CalendarClock, CheckCircle2, Loader2, MessageCircleQuestion, Paperclip, RotateCcw, Send, Users, XCircle } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { useCurrentUser } from "@/providers/current-user-provider";
import { queryEntityDef } from "@/lib/queries/registry";
import { AudiencePicker } from "@/components/queries/audience-picker";
import { NeededByPicker } from "@/components/queries/needed-by-picker";
import { AttachmentPicker, formatBytes } from "@/components/queries/attachment-picker";
import { PaymentReportCard } from "@/components/queries/payment-report-card";
import { COMPOSER_QUERY_KINDS, QUERY_KIND_LABELS, type QueryKind, type QueryTargeting, type QueryThread } from "@/lib/queries/types";

/**
 * One thread, wherever it's opened from — the /queries page, an inline
 * QueryButton on a Tally Inbox row, or an entity detail page. When no thread
 * exists yet for the transaction it renders the composer instead.
 */

interface Props {
  entityType: string;
  entityId: string;
  /** Skip discovery and open this thread directly (from the /queries list). */
  initialQueryId?: string | null;
  /** Fires after any mutation so callers can refresh their badge/count. */
  onChanged?: () => void;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const DEFAULT_TARGETING: QueryTargeting = { audience: "all", audience_roles: [], audience_user_ids: [] };

export function QueryThreadPanel({ entityType, entityId, initialQueryId, onChanged }: Props) {
  const { user } = useCurrentUser();
  const def = queryEntityDef(entityType);

  const [loading, setLoading] = useState(true);
  const [thread, setThread] = useState<QueryThread | null>(null);
  const [checkedForExisting, setCheckedForExisting] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [kind, setKind] = useState<QueryKind>("question");
  const [targeting, setTargeting] = useState<QueryTargeting>(DEFAULT_TARGETING);
  const [neededBy, setNeededBy] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Send as multipart only when there are files — the JSON path stays the
   * cheap default for the overwhelming majority of messages.
   */
  function requestInit(meta: Record<string, unknown>, attached: File[]): RequestInit {
    if (attached.length === 0) {
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta),
      };
    }
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    for (const f of attached) form.append("file", f);
    // No Content-Type header — the browser sets it with the boundary.
    return { method: "POST", body: form };
  }

  /** Surfaced verbatim: silently dropping an attachment is worse than saying so. */
  function reportFailedAttachments(failed: string[] | undefined) {
    if (failed && failed.length > 0) {
      setError(`Sent, but these attachments failed: ${failed.join(", ")}`);
    }
  }

  const loadThread = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/queries/${id}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { thread: QueryThread };
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
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/queries?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { items: Array<{ id: string }> };
        if (json.items.length > 0) await loadThread(json.items[0].id);
      } catch {
        // Falls through to the composer.
      } finally {
        setCheckedForExisting(true);
        setLoading(false);
      }
    })();
  }, [entityType, entityId, initialQueryId, loadThread]);

  async function ask() {
    const body = composerText.trim();
    if (!body) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/queries",
        requestInit(
          {
            entity_type: entityType,
            entity_id: entityId,
            body,
            kind,
            needed_by: neededBy ?? undefined,
            template_key: templateKey ?? undefined,
            ...targeting,
          },
          files,
        ),
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to send");
      setComposerText("");
      setTargeting(DEFAULT_TARGETING);
      setNeededBy(null);
      setFiles([]);
      setTemplateKey(null);
      await loadThread(json.id as string);
      reportFailedAttachments(json.attachments_failed);
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
    if (!resolve && !body && files.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/queries/${thread.id}/messages`,
        requestInit({ body: body || undefined, resolve }, files),
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to send");
      setComposerText("");
      setFiles([]);
      await loadThread(thread.id);
      reportFailedAttachments(json.attachments_failed);
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
      const res = await fetch(`/api/queries/${thread.id}`, {
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

  if (!def) {
    return <p className="text-xs text-muted-foreground py-2">Queries aren&apos;t available on this record.</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  // ── Composer: no thread on this transaction yet ─────────────────────────
  if (!thread) {
    if (!checkedForExisting && !initialQueryId) return null;
    return (
      <div className="space-y-3">
        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-1.5">
          {COMPOSER_QUERY_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
                kind === k ? "bg-foreground text-background border-foreground" : "hover:bg-muted text-muted-foreground"
              }`}
            >
              {QUERY_KIND_LABELS[k]}
            </button>
          ))}
        </div>

        <textarea
          rows={3}
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          placeholder={`Ask a question about this ${def.label.toLowerCase()}…`}
          className="w-full text-sm border rounded-md p-2.5 resize-none bg-background"
        />

        {def.templates.length > 0 && !composerText && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Common asks
            </div>
            <div className="flex flex-wrap gap-1.5">
              {def.templates.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setComposerText(t.body);
                    // Recorded on the query so "what do accounts keep getting
                    // stuck on?" is answerable later.
                    setTemplateKey(t.key);
                  }}
                  className="text-xs px-2 py-1 rounded border border-dashed text-muted-foreground hover:bg-muted"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <AudiencePicker
          entityRoles={def.roles}
          entityType={entityType}
          value={targeting}
          onChange={setTargeting}
          disabled={submitting}
        />

        <NeededByPicker value={neededBy} onChange={setNeededBy} disabled={submitting} />
        <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />

        <div className="flex justify-end">
          <button
            type="button"
            onClick={ask}
            disabled={submitting || !composerText.trim()}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-md bg-foreground text-background hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageCircleQuestion className="h-3 w-3" />}
            Send query
          </button>
        </div>
      </div>
    );
  }

  // ── Existing thread ─────────────────────────────────────────────────────
  const isResolved = thread.status === "resolved";
  const canResolve = user?.id === thread.created_by.id || user?.role === "admin";
  // Resolved threads are never "overdue" — the clock stopped when it closed.
  const overdueDays =
    thread.needed_by && !isResolved
      ? Math.floor((Date.now() - new Date(`${thread.needed_by}T00:00:00`).getTime()) / 86_400_000)
      : 0;
  const audienceText =
    thread.audience === "users"
      ? thread.audience_users.map((u) => u.full_name).join(", ") || "specific people"
      : thread.audience === "roles"
        ? thread.audience_roles.map((r) => USER_ROLE_LABELS[r] ?? r).join(", ")
        : "Anyone who can help";

  return (
    <div className="space-y-2.5">
      {thread.entity ? (
        <div className="rounded border bg-muted/40 px-2.5 py-2 text-xs">
          <span className="font-medium">{thread.entity.title}</span>
          {thread.entity.subtitle && <span className="text-muted-foreground"> · {thread.entity.subtitle}</span>}
          {thread.entity.amount != null && (
            <span className="tabular-nums"> · {formatCurrency(thread.entity.amount)}</span>
          )}
        </div>
      ) : (
        <div className="rounded border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          This transaction is no longer available.
        </div>
      )}

      {thread.payment_report && (
        <PaymentReportCard
          report={thread.payment_report}
          entityType={thread.entity_type}
          entityId={thread.entity_id}
          entityTitle={thread.entity?.title ?? null}
          entityReference={thread.entity?.reference ?? null}
          entityAmount={thread.entity?.amount ?? null}
          onChanged={() => {
            void loadThread(thread.id);
            onChanged?.();
          }}
        />
      )}

      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        {thread.kind === "action_needed" && (
          <span className="px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800">
            Action needed
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Users className="h-3 w-3" />
          Asked: {audienceText}
        </span>
        {thread.needed_by && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${
              overdueDays > 0
                ? "bg-amber-50 border-amber-200 text-amber-800"
                : "bg-muted border-transparent text-muted-foreground"
            }`}
          >
            <CalendarClock className="h-3 w-3" />
            {overdueDays > 0
              ? `Overdue · ${overdueDays}d`
              : `Needed by ${new Date(`${thread.needed_by}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {thread.messages.map((m) => {
          if (m.event_type !== "message") {
            // A nudge has no human actor — created_by is the thread's asker
            // only because the column is NOT NULL, so don't credit them with
            // having done it.
            if (m.event_type === "nudged") {
              return (
                <div key={m.id} className="text-[11px] text-amber-700 flex items-center gap-1 pl-1 flex-wrap">
                  <BellRing className="h-3 w-3" />
                  Chased automatically · {timeAgo(m.created_at)}
                </div>
              );
            }
            const label =
              m.event_type === "resolved" ? "Resolved"
              : m.event_type === "reopened" ? "Reopened"
              : m.event_type === "payment_verified" ? "Payment verified and recorded"
              : m.event_type === "payment_rejected" ? "Closed — no such payment"
              : "Re-assigned";
            return (
              <div key={m.id} className="text-[11px] text-muted-foreground flex items-center gap-1 pl-1 flex-wrap">
                {m.event_type === "resolved" || m.event_type === "payment_verified" ? (
                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                ) : m.event_type === "payment_rejected" ? (
                  <XCircle className="h-3 w-3 text-red-600" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {label} by {m.created_by.full_name} · {timeAgo(m.created_at)}
                {m.body && <span className="italic">— {m.body}</span>}
              </div>
            );
          }
          const isAsker = m.created_by.id === thread.created_by.id;
          return (
            <div
              key={m.id}
              className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                isAsker ? "bg-amber-50 border border-amber-200 text-amber-900" : "bg-muted"
              }`}
            >
              <div className="flex items-center justify-between text-[11px] font-semibold mb-0.5 opacity-80 gap-2">
                <span>
                  {m.created_by.full_name} ({USER_ROLE_LABELS[m.created_by.role] ?? m.created_by.role})
                </span>
                <span className="font-normal opacity-75 flex-none">{timeAgo(m.created_at)}</span>
              </div>
              {m.body}
              {m.attachments && m.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {m.attachments.map((a) => (
                    <a
                      key={a.id}
                      href={`/api/queries/attachments/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border bg-background/60 hover:bg-background max-w-[240px]"
                      title={a.file_name}
                    >
                      <Paperclip className="h-3 w-3 flex-none" />
                      <span className="truncate">{a.file_name}</span>
                      {a.size_bytes != null && (
                        <span className="text-muted-foreground flex-none">{formatBytes(a.size_bytes)}</span>
                      )}
                    </a>
                  ))}
                </div>
              )}
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
        <div className="space-y-1.5">
          <textarea
            rows={2}
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder="Reply…"
            className="w-full text-xs border rounded p-2 resize-none bg-background"
          />
          <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />
          {canResolve && (
            <p className="text-[11px] text-muted-foreground">
              If you resolve, this note is recorded on the {def.label.toLowerCase()}&apos;s history — write it as the
              outcome.
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => reply(false)}
              disabled={submitting || (!composerText.trim() && files.length === 0)}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border hover:bg-muted disabled:opacity-50"
            >
              <Send className="h-3 w-3" />
              Reply
            </button>
            {canResolve && (
              <button
                type="button"
                onClick={() => reply(true)}
                disabled={submitting}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-green-300 text-green-800 hover:bg-green-50 disabled:opacity-50"
              >
                <CheckCircle2 className="h-3 w-3" />
                Reply &amp; resolve
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
