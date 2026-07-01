"use client";

/**
 * Universal lifecycle artifacts for a billing statement.
 *
 * Renders a status badge + a row of quick actions (View PI, View GST,
 * Open in Tally Inbox) for any statement, from any surface in the CRM.
 *
 * Designed to be embedded:
 *   - inside <ViewStatementDialog> in /billing
 *   - on /contracts/[id] in the billing section
 *   - as a column on /billing master list
 *
 * Fetches lifecycle data from /api/accounting/inbox?id=<statement_id> when
 * a row prop is not provided. Uses a 30s stale-while-revalidate window so
 * surfaces don't spam the API.
 *
 * Re-uses the existing inbox row shape — there's only one canonical source
 * of truth for statement lifecycle in this codebase.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDown, FileCheck, ExternalLink, AlertCircle } from "lucide-react";
import {
  HANDOFF_STATE_LABELS,
  type InboxResponse,
  type InboxRow,
} from "@/lib/tally-handoff";

// ─── Module-scoped 30s SWR cache, keyed by statement_id ─────────────────────
// Multiple components on the same page asking for the same statement share
// one in-flight promise and one cached row. Stale window: 30s.
const CACHE_TTL_MS = 30_000;
type CacheEntry = { row: InboxRow | null; fetchedAt: number; inflight?: Promise<InboxRow | null> };
const cache = new Map<string, CacheEntry>();

async function fetchLifecycleRow(statementId: string, force = false): Promise<InboxRow | null> {
  const now = Date.now();
  const cached = cache.get(statementId);
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.row;
  }
  if (cached?.inflight) {
    return cached.inflight;
  }
  const promise = (async () => {
    const res = await fetch(`/api/accounting/inbox?id=${encodeURIComponent(statementId)}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as InboxResponse;
    const row = json.rows[0] ?? null;
    cache.set(statementId, { row, fetchedAt: Date.now() });
    return row;
  })();
  cache.set(statementId, { row: cached?.row ?? null, fetchedAt: cached?.fetchedAt ?? 0, inflight: promise });
  try {
    return await promise;
  } finally {
    const e = cache.get(statementId);
    if (e) e.inflight = undefined;
  }
}

/** Manually invalidate cache for a statement (e.g. after a successful action). */
export function invalidateLifecycleCache(statementId: string) {
  cache.delete(statementId);
}

// ─── useLifecycle hook ─────────────────────────────────────────────────────
// Components can either pass a `row` prop (when the parent already has the
// data) or pass only `statementId` and let the hook fetch.

function useLifecycle(statementId: string | null, presetRow?: InboxRow | null) {
  const [row, setRow] = useState<InboxRow | null | undefined>(presetRow);
  const [loading, setLoading] = useState(!presetRow && !!statementId);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (!statementId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchLifecycleRow(statementId, force);
      setRow(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load lifecycle");
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    if (presetRow !== undefined) {
      setRow(presetRow);
      setLoading(false);
      return;
    }
    void load();
  }, [statementId, presetRow, load]);

  return { row, loading, error, refresh: () => load(true) };
}

// ─── StatementLifecycleBadge ───────────────────────────────────────────────

function badgeClass(row: InboxRow | null | undefined): string {
  if (!row) return "bg-muted text-muted-foreground border-border";
  if (row.is_voided) return "bg-red-50 text-red-900 border-red-200";
  if (row.has_discrepancy) return "bg-red-50 text-red-900 border-red-200";
  if (row.handoff_state === "complete") return "bg-green-50 text-green-900 border-green-200";
  switch (row.bucket) {
    case "gst_to_issue":
      return "bg-blue-50 text-blue-900 border-blue-200";
    case "payment_to_record":
      return "bg-green-50 text-green-900 border-green-200";
    case "in_flight":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "discrepancy":
      return "bg-red-50 text-red-900 border-red-200";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function badgeLabel(row: InboxRow | null | undefined, fallbackStatus?: string): string {
  if (row?.is_voided) return "Voided";
  if (row?.has_discrepancy) return "Discrepancy";
  // When there's no handoff_state (PI First statements never get one until
  // payment is captured), fall back to the statement's own status field.
  if (!row?.handoff_state) {
    if (fallbackStatus === "sent") return "Emailed, Awaiting Payment";
    if (fallbackStatus === "finalized") return "Finalized";
    if (fallbackStatus === "exported") return "Exported";
    if (fallbackStatus === "voided") return "Voided";
    return "Draft";
  }
  return HANDOFF_STATE_LABELS[row.handoff_state];
}

export interface StatementLifecycleBadgeProps {
  statementId: string;
  /** Skip the fetch and use this row directly (when parent has it). */
  row?: InboxRow | null;
  /** Smaller padding for use inside table rows / list rows. */
  compact?: boolean;
  /** Fallback label source when no Tally inbox row exists (e.g. PI First statements). */
  fallbackStatus?: string;
  className?: string;
}

export function StatementLifecycleBadge({
  statementId,
  row: presetRow,
  compact = false,
  fallbackStatus,
  className = "",
}: StatementLifecycleBadgeProps) {
  const { row, loading } = useLifecycle(statementId, presetRow);

  if (loading && !row) {
    return (
      <span
        className={`inline-block ${compact ? "text-[11px] px-1.5 py-0.5" : "text-xs px-2 py-0.5"} rounded-full border bg-muted/30 text-muted-foreground border-muted-foreground/20 ${className}`}
        title="Loading lifecycle…"
      >
        …
      </span>
    );
  }

  return (
    <span
      className={`inline-block ${compact ? "text-[11px] px-1.5 py-0.5" : "text-xs px-2 py-0.5"} rounded-full border ${badgeClass(row)} ${className}`}
      title={row?.void_reason ?? row?.discrepancy_reason ?? badgeLabel(row, fallbackStatus)}
    >
      {badgeLabel(row, fallbackStatus)}
    </span>
  );
}

// ─── StatementQuickActions ─────────────────────────────────────────────────

export interface StatementQuickActionsProps {
  statementId: string;
  /** Skip the fetch and use this row directly. */
  row?: InboxRow | null;
  /** Compact button styling for list rows. */
  compact?: boolean;
  /**
   * Whether the inbox is enabled. If false, "Open in Tally Inbox" is hidden.
   * Defaults to checking client-side from the row's existence in v2 state
   * (presence of handoff_state implies the flag was on when this row was created).
   */
  inboxEnabled?: boolean;
  className?: string;
}

export function StatementQuickActions({
  statementId,
  row: presetRow,
  compact = false,
  inboxEnabled,
  className = "",
}: StatementQuickActionsProps) {
  const { row } = useLifecycle(statementId, presetRow);
  const btnSize = compact ? "text-[11px] px-1.5 py-0.5" : "text-xs px-2 py-1";

  // Open in Tally Inbox is only useful when the row has a v2 state.
  const showInboxLink = inboxEnabled ?? (row?.handoff_state != null);
  const hasUpload = !!row?.latest_upload;

  return (
    <div className={`inline-flex items-center gap-1 ${className}`}>
      <a
        href={`/api/billing-statements/${statementId}/proforma-pdf`}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 ${btnSize} rounded border hover:bg-muted`}
        title="Open the CRM-generated proforma invoice PDF"
      >
        <FileDown className="h-3 w-3" />
        PI
      </a>
      {hasUpload && (
        <a
          href={`/api/billing-statements/${statementId}/gst-invoice-pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 ${btnSize} rounded border hover:bg-muted`}
          title="Open the GST invoice uploaded by accounts"
        >
          <FileCheck className="h-3 w-3" />
          GST
        </a>
      )}
      {showInboxLink && (
        <a
          href={`/accounting/inbox?focus=${encodeURIComponent(statementId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 ${btnSize} rounded border hover:bg-muted`}
          title="Open this statement's row in the Tally Inbox"
        >
          <ExternalLink className="h-3 w-3" />
          Inbox
        </a>
      )}
    </div>
  );
}

// ─── StatementLifecyclePanel — badge + actions + brief context ────────────

export interface StatementLifecyclePanelProps {
  statementId: string;
  row?: InboxRow | null;
}

/**
 * Embeddable panel for use inside <ViewStatementDialog> or contract page.
 * Shows the badge, a one-line state description, and the quick-action row.
 * Pulls timeline events on demand if the user opens the timeline component.
 */
export function StatementLifecyclePanel({ statementId, row: presetRow }: StatementLifecyclePanelProps) {
  const { row, loading, error, refresh } = useLifecycle(statementId, presetRow);

  const summary = useMemo(() => {
    if (!row) return null;
    if (row.is_voided) {
      return `Voided${row.voided_at ? ` on ${row.voided_at.slice(0, 10)}` : ""}${row.void_reason ? ` — ${row.void_reason}` : ""}`;
    }
    if (row.has_discrepancy) {
      return row.discrepancy_reason ?? "Discrepancy between Tally and CRM";
    }
    if (!row.handoff_state) return "Draft statement (no Tally handoff)";
    return HANDOFF_STATE_LABELS[row.handoff_state];
  }, [row]);

  if (error) {
    return (
      <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-1">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
        <span>Lifecycle unavailable: {error}.{" "}
          <button type="button" onClick={() => void refresh()} className="underline">retry</button>
        </span>
      </div>
    );
  }

  return (
    <div className="rounded border bg-muted/30 px-3 py-2 flex items-center gap-2 flex-wrap">
      <StatementLifecycleBadge statementId={statementId} row={row} compact />
      <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
        {loading && !row ? "Loading lifecycle…" : summary}
      </span>
      <StatementQuickActions statementId={statementId} row={row} compact />
    </div>
  );
}
