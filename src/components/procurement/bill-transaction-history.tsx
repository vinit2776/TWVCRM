"use client";

import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AUDIT_TONE_DOT, AUDIT_TONE_TEXT } from "@/lib/audit-labels";
import {
  actorName,
  buildTimeline,
  prettyRole,
  summarizePeople,
  type TimelineEntry,
  type TimelineFilter,
  type TimelineItem,
  type TimelineRow,
} from "@/lib/procurement/audit-timeline";

const ENTITY_TYPE_LABELS: Record<string, string> = {
  vendor_bill: "Invoice",
  purchase_order: "Purchase Order",
  purchase_request: "Material Request",
};

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  payment_status: "Payment",
  approval_status: "Approval",
  amount_paid: "Amount Paid",
};

const FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "key", label: "Key events" },
  { id: "all", label: "All activity" },
  { id: "request", label: "Request" },
  { id: "order", label: "Order" },
  { id: "invoice", label: "Invoice" },
];

const dayKey = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

const itemDate = (item: TimelineItem) =>
  item.type === "edit_group" ? item.start : item.entry.row.created_at;

function ChangeList({ changes }: { changes: NonNullable<TimelineRow["changes"]> }) {
  return (
    <div className="mt-2 space-y-1">
      {Object.entries(changes).map(([field, { old: oldVal, new: newVal }]) => (
        <div key={field} className="text-xs bg-muted/50 rounded px-2 py-1 break-words">
          <span className="font-medium text-muted-foreground">{FIELD_LABELS[field] ?? field}:</span>{" "}
          {oldVal != null ? <span className="line-through text-red-600">{String(oldVal)}</span> : <span className="text-muted-foreground italic">—</span>}
          {" → "}
          <span className="text-green-700 font-medium">{newVal != null ? String(newVal) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

const AuditEntry = memo(function AuditEntry({
  entry, poId, mrId, compact,
}: { entry: TimelineEntry; poId: string | null; mrId: string | null; compact?: boolean }) {
  const { row, summary } = entry;
  const [expanded, setExpanded] = useState(false);
  const changes = row.changes ?? {};
  const hasChanges = Object.keys(changes).length > 0;
  const entityLabel = ENTITY_TYPE_LABELS[row.entity_type] ?? row.entity_type;
  const role = prettyRole(row.performer?.role);
  const minor = summary.kind === "edit";
  const headingColor = minor && !summary.flag ? "text-foreground" : AUDIT_TONE_TEXT[summary.tone];

  let sourceHint: string | null = null;
  if (row.entity_id === poId) sourceHint = "from PO";
  else if (row.entity_id === mrId) sourceHint = "from MR";

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={`rounded-full mt-1.5 shrink-0 ${minor ? "w-1.5 h-1.5 mx-0.5" : "w-2.5 h-2.5"} ${AUDIT_TONE_DOT[summary.tone]}`} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className={`flex-1 min-w-0 ${compact ? "pb-2" : "pb-4"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className={`text-sm ${minor ? "" : "font-medium"} ${headingColor}`}>{summary.label}</span>
            <span className="text-xs text-muted-foreground ml-2 bg-muted px-1.5 py-0.5 rounded whitespace-nowrap">{entityLabel}</span>
            {sourceHint && <span className="text-[10px] text-muted-foreground ml-1.5 italic">{sourceHint}</span>}
          </div>
          <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{timeLabel(row.created_at)}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 break-words">
          {actorName(row)}
          {role && <span className="text-muted-foreground/70"> ({role})</span>}
          {summary.detail && (
            <>
              {" · "}
              <span className={`font-medium ${summary.flag ? "text-amber-700 bg-amber-50 px-1 rounded" : headingColor}`}>{summary.detail}</span>
            </>
          )}
        </p>
        {hasChanges && (
          <button onClick={() => setExpanded(!expanded)} className="mt-1 text-xs text-primary flex items-center gap-1 hover:underline">
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Hide" : "Show"} changes
          </button>
        )}
        {expanded && hasChanges && <ChangeList changes={changes} />}
      </div>
    </div>
  );
});

const EditGroup = memo(function EditGroup({
  item, poId, mrId,
}: { item: Extract<TimelineItem, { type: "edit_group" }>; poId: string | null; mrId: string | null }) {
  const [open, setOpen] = useState(false);
  const entityLabel = ENTITY_TYPE_LABELS[item.entity_type] ?? item.entity_type;
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-1.5 h-1.5 mx-0.5 rounded-full mt-2 shrink-0 bg-gray-400" />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="pb-4 flex-1 min-w-0">
        <button onClick={() => setOpen(!open)} className="w-full text-left flex items-start justify-between gap-2">
          <span className="text-sm text-muted-foreground min-w-0 break-words">
            Edited by {summarizePeople(item.people)} · {item.entries.length} changes
            <span className="text-xs ml-2 bg-muted px-1.5 py-0.5 rounded whitespace-nowrap">{entityLabel}</span>
            {item.flagged && <span className="text-xs ml-1.5 text-amber-700 bg-amber-50 px-1 rounded">amount changed</span>}
          </span>
          <span className="text-xs text-muted-foreground shrink-0 mt-0.5 flex items-center gap-1">
            {timeLabel(item.start)}
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </span>
        </button>
        {!open && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Show the {item.entries.length} changes
          </p>
        )}
        {open && (
          <div className="mt-2 border-l pl-3">
            {item.entries.map((e) => (
              <AuditEntry key={e.row.id} entry={e} poId={poId} mrId={mrId} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export const BillTransactionHistory = memo(function BillTransactionHistory({
  auditTrail, billId: _billId, poId, mrId,
}: {
  auditTrail: TimelineRow[];
  billId: string;
  poId: string | null;
  mrId: string | null;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("key");
  const items = useMemo(
    () =>
      buildTimeline(auditTrail, filter).map((item, i, all) => {
        const day = dayKey(itemDate(item));
        return { item, day, showDay: i === 0 || day !== dayKey(itemDate(all[i - 1])) };
      }),
    [auditTrail, filter],
  );

  if (auditTrail.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Transaction History
        </CardTitle>
        <div className="flex flex-wrap gap-1.5 mt-2" role="tablist" aria-label="History filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                filter === f.id ? "bg-primary text-primary-foreground border-primary" : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 && <p className="text-sm text-muted-foreground py-2">Nothing to show for this filter.</p>}
        <div>
          {items.map(({ item, day, showDay }) => {
            const key = item.type === "edit_group" ? item.key : item.entry.row.id;
            return (
              <div key={key}>
                {showDay && (
                  <div className="flex items-center gap-2 py-2">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{day}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {item.type === "edit_group" ? (
                  <EditGroup item={item} poId={poId} mrId={mrId} />
                ) : (
                  <AuditEntry entry={item.entry} poId={poId} mrId={mrId} />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
});
