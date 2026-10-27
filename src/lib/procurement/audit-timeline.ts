// Presentation-only shaping of the audit_trail rows behind a bill's
// Transaction History: drop bookkeeping noise, keep milestones at full weight,
// and fold runs of small field edits into one collapsible line. Nothing here
// touches the data — "All activity" still shows the raw rows.

import { summarizeAuditEvent, isInternalAuditKey, type AuditSummary } from "@/lib/audit-labels";

export type TimelineRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  created_at: string;
  performer: { id: string; full_name: string; role?: string | null } | null;
};

export type TimelineStage = "request" | "order" | "invoice";
export type TimelineFilter = "key" | "all" | TimelineStage;

export type TimelineEntry = { row: TimelineRow; summary: AuditSummary };

export type TimelineItem =
  | { type: "milestone"; entry: TimelineEntry }
  | { type: "edit"; entry: TimelineEntry }
  | {
      type: "edit_group";
      key: string;
      entity_type: string;
      entries: TimelineEntry[];
      people: string[];
      fields: string[];
      flagged: boolean;
      start: string;
      end: string;
    };

/** Edits by anyone on the same entity this close together fold into one line. */
export const GROUP_WINDOW_MS = 30 * 60 * 1000;

export const STAGE_BY_ENTITY: Record<string, TimelineStage> = {
  purchase_request: "request",
  purchase_order: "order",
  vendor_bill: "invoice",
};

const changedKeys = (row: TimelineRow) =>
  Object.keys(row.changes ?? {}).filter((k) => !isInternalAuditKey(k));

export function entrySummary(row: TimelineRow): TimelineEntry {
  return { row, summary: summarizeAuditEvent(row) };
}

/** A row nobody needs to see: page views, and edits with nothing a person changed. */
export function isNoise(entry: TimelineEntry): boolean {
  const { row, summary } = entry;
  if (row.action === "view") return true;
  if (summary.kind !== "edit") return false;
  return changedKeys(row).length === 0;
}

export function actorName(row: TimelineRow): string {
  return row.performer?.full_name ?? "System";
}

/** "Aruna", "Aruna and Noorul", "Aruna, Noorul and 1 other". */
export function summarizePeople(names: string[]): string {
  const uniq = Array.from(new Set(names));
  if (uniq.length <= 1) return uniq[0] ?? "System";
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
  if (uniq.length === 3) return `${uniq[0]}, ${uniq[1]} and ${uniq[2]}`;
  return `${uniq[0]}, ${uniq[1]} and ${uniq.length - 2} others`;
}

export function prettyRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return role.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function buildTimeline(rows: TimelineRow[], filter: TimelineFilter): TimelineItem[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const entries = sorted.map(entrySummary);

  if (filter === "all") {
    return entries.map((entry) => ({ type: entry.summary.kind === "edit" ? "edit" : "milestone", entry }));
  }

  const scoped = entries.filter(
    (e) => !isNoise(e) && (filter === "key" || STAGE_BY_ENTITY[e.row.entity_type] === filter),
  );

  const items: TimelineItem[] = [];
  let run: TimelineEntry[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ type: "edit", entry: run[0] });
    else if (run.length > 1) {
      const fields = Array.from(new Set(run.flatMap((e) => changedKeys(e.row))));
      items.push({
        type: "edit_group",
        key: run[0].row.id,
        entity_type: run[0].row.entity_type,
        entries: run,
        people: Array.from(new Set(run.map((e) => actorName(e.row)))),
        fields,
        flagged: run.some((e) => e.summary.flag),
        start: run[0].row.created_at,
        end: run[run.length - 1].row.created_at,
      });
    }
    run = [];
  };

  for (const entry of scoped) {
    if (entry.summary.kind !== "edit") {
      flush();
      items.push({ type: "milestone", entry });
      continue;
    }
    const prev = run[run.length - 1];
    const joins =
      prev &&
      prev.row.entity_type === entry.row.entity_type &&
      new Date(entry.row.created_at).getTime() - new Date(prev.row.created_at).getTime() <= GROUP_WINDOW_MS;
    if (prev && !joins) flush();
    run.push(entry);
  }
  flush();
  return items;
}
