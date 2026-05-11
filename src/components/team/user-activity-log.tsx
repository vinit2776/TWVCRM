"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, ChevronLeft, ChevronRight, ChevronDown, Filter, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

interface AuditEntry {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  create: "bg-green-100 text-green-800",
  update: "bg-blue-100 text-blue-800",
  delete: "bg-red-100 text-red-800",
};

const ENTITY_LABELS: Record<string, string> = {
  lead: "Lead",
  contract: "Contract",
  proposal: "Proposal",
  activity: "Activity",
  document: "Document",
  invoice: "Invoice",
  task: "Task",
  billing_statement: "Billing",
  contract_space_allocation: "Space",
  approval_request: "Approval",
  service_po: "Service PO",
  feedback: "Feedback",
  caution: "Caution",
  credit_allocation: "Credit",
  daypass_booking: "Day Pass",
  facility_asset: "Asset",
  facility_issue: "Issue",
  gst_invoice: "GST Invoice",
  voucher: "Voucher",
};

const PAGE_SIZE = 20;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Format a field name for display: snake_case → Title Case */
function formatFieldName(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render a value as a readable string */
function displayValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "object") {
    try {
      const s = JSON.stringify(val);
      return s.length > 120 ? s.slice(0, 117) + "..." : s;
    } catch {
      return String(val);
    }
  }
  const s = String(val);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
}

export function UserActivityLogDialog({ open, onOpenChange, userId, userName }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [entityFilter, setEntityFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (entityFilter !== "all") params.set("entity_type", entityFilter);
      if (actionFilter !== "all") params.set("action", actionFilter);

      const res = await fetch(`/api/users/${userId}/activity-log?${params}`);
      if (res.ok) {
        const json = await res.json();
        setEntries(json.data || []);
        setTotal(json.total ?? 0);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [userId, offset, entityFilter, actionFilter]);

  useEffect(() => {
    if (open) {
      setOffset(0);
      setExpandedId(null);
      fetchLog();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entityFilter, actionFilter]);

  useEffect(() => {
    if (open) fetchLog();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  /** Summarize changes into a human-readable string */
  const summarizeChanges = (entry: AuditEntry): string => {
    const keys = Object.keys(entry.changes || {});
    if (keys.length === 0) return "";
    const shown = keys.slice(0, 3).map((k) => k.replace(/_/g, " "));
    const more = keys.length > 3 ? ` +${keys.length - 3} more` : "";
    return shown.join(", ") + more;
  };

  const hasChanges = (entry: AuditEntry): boolean => {
    return Object.keys(entry.changes || {}).length > 0;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            Activity Log — {userName}
          </DialogTitle>
        </DialogHeader>

        {/* Filters */}
        <div className="flex gap-2 items-center">
          <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Select value={entityFilter} onValueChange={(v) => { setEntityFilter(v); setOffset(0); }}>
            <SelectTrigger className="h-8 text-xs w-[140px]">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.entries(ENTITY_LABELS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setOffset(0); }}>
            <SelectTrigger className="h-8 text-xs w-[120px]">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectItem value="create">Create</SelectItem>
              <SelectItem value="update">Update</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground ml-auto">
            {total} event{total !== 1 ? "s" : ""}
          </span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No activity found.
            </p>
          ) : (
            entries.map((entry) => {
              const summary = summarizeChanges(entry);
              const expanded = expandedId === entry.id;
              const clickable = hasChanges(entry);
              const changeKeys = Object.keys(entry.changes || {});

              return (
                <div key={entry.id} className="rounded-md border bg-muted/10 overflow-hidden">
                  {/* Row header */}
                  <div
                    className={cn(
                      "flex items-start gap-2 px-2 py-2 transition-colors",
                      clickable && "cursor-pointer hover:bg-muted/30",
                      expanded && "bg-muted/20"
                    )}
                    onClick={() => {
                      if (clickable) setExpandedId(expanded ? null : entry.id);
                    }}
                  >
                    {/* Expand chevron */}
                    <div className="pt-0.5 w-3.5 shrink-0">
                      {clickable && (
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 text-muted-foreground transition-transform duration-150",
                            expanded && "rotate-180"
                          )}
                        />
                      )}
                    </div>

                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant="outline"
                          className={`text-[9px] px-1 py-0 h-4 font-semibold uppercase ${
                            ACTION_COLORS[entry.action] || "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {entry.action}
                        </Badge>
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">
                          {ENTITY_LABELS[entry.entity_type] || entry.entity_type}
                        </Badge>
                        {!expanded && summary && (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {summary}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {formatDateTime(entry.created_at)}
                      </p>
                    </div>
                  </div>

                  {/* Expanded detail panel */}
                  {expanded && changeKeys.length > 0 && (
                    <div className="border-t bg-muted/5 px-3 py-2 space-y-1.5">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        {changeKeys.length} field{changeKeys.length !== 1 ? "s" : ""} changed
                      </p>
                      <div className="space-y-1">
                        {changeKeys.map((key) => {
                          const change = entry.changes[key];
                          // For "record" key on deletes, show differently
                          if (key === "record" && entry.action === "delete") {
                            return (
                              <div key={key} className="text-[10px] text-muted-foreground italic">
                                Full record snapshot stored
                              </div>
                            );
                          }
                          return (
                            <div
                              key={key}
                              className="rounded bg-background border px-2 py-1.5 space-y-0.5"
                            >
                              <p className="text-[10px] font-medium text-foreground">
                                {formatFieldName(key)}
                              </p>
                              <div className="flex items-start gap-1.5 text-[10px]">
                                <span className="text-red-600 bg-red-50 rounded px-1 py-0.5 max-w-[45%] break-words">
                                  {displayValue(change.old)}
                                </span>
                                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                                <span className="text-green-700 bg-green-50 rounded px-1 py-0.5 max-w-[45%] break-words">
                                  {displayValue(change.new)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2 border-t">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft className="h-3 w-3 mr-1" />
              Prev
            </Button>
            <span className="text-[10px] text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
