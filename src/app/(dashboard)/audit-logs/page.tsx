"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Shield,
  ClipboardList,
  ChevronLeft,
  ChevronRight,
  Filter,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  LogIn,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { formatDateTime } from "@/lib/utils";
import type { AuditLog } from "@/types";

const ENTITY_TYPE_LABELS: Record<string, string> = {
  lead: "Lead",
  task: "Task",
  proposal: "Proposal",
  invoice: "Invoice",
  activity: "Activity",
  document: "Document",
  user: "User",
  contract: "Contract",
  voucher: "Voucher",
  usage_charge: "Usage Charge",
  billing_statement: "Billing Statement",
};

const ENTITY_TYPE_COLORS: Record<string, string> = {
  lead: "bg-blue-100 text-blue-800",
  task: "bg-purple-100 text-purple-800",
  proposal: "bg-amber-100 text-amber-800",
  invoice: "bg-green-100 text-green-800",
  activity: "bg-cyan-100 text-cyan-800",
  document: "bg-gray-100 text-gray-800",
  user: "bg-red-100 text-red-800",
  contract: "bg-teal-100 text-teal-800",
  voucher: "bg-indigo-100 text-indigo-800",
  usage_charge: "bg-orange-100 text-orange-800",
  billing_statement: "bg-lime-100 text-lime-800",
};

const ACTION_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  create: { label: "Created", icon: Plus, color: "bg-emerald-100 text-emerald-800" },
  update: { label: "Updated", icon: Pencil, color: "bg-sky-100 text-sky-800" },
  delete: { label: "Deleted", icon: Trash2, color: "bg-red-100 text-red-800" },
  login: { label: "Login", icon: LogIn, color: "bg-violet-100 text-violet-800" },
};

function ChangesDisplay({ changes }: { changes: Record<string, { old: unknown; new: unknown }> }) {
  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-muted-foreground text-xs">No details</span>;
  }

  // For create/delete operations that store the full record
  if (changes.record) {
    return (
      <span className="text-xs text-muted-foreground">
        Full record snapshot stored
      </span>
    );
  }

  return (
    <div className="space-y-1">
      {Object.entries(changes).slice(0, 4).map(([field, { old: oldVal, new: newVal }]) => (
        <div key={field} className="text-xs">
          <span className="font-medium text-foreground">{field.replace(/_/g, " ")}</span>
          {": "}
          <span className="text-red-600 line-through">
            {oldVal === null || oldVal === undefined ? "empty" : String(oldVal)}
          </span>
          {" → "}
          <span className="text-emerald-700 font-medium">
            {newVal === null || newVal === undefined ? "empty" : String(newVal)}
          </span>
        </div>
      ))}
      {Object.keys(changes).length > 4 && (
        <span className="text-xs text-muted-foreground">
          +{Object.keys(changes).length - 4} more changes
        </span>
      )}
    </div>
  );
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Filters
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "30" });
    if (entityTypeFilter && entityTypeFilter !== "all") params.set("entity_type", entityTypeFilter);
    if (actionFilter && actionFilter !== "all") params.set("action", actionFilter);

    const res = await fetch(`/api/audit-logs?${params}`);
    if (res.ok) {
      const json = await res.json();
      setLogs(json.data || []);
      setTotalPages(json.pagination?.totalPages || 1);
      setTotal(json.pagination?.total || 0);
    } else if (res.status === 403) {
      setIsAdmin(false);
    }
    setLoading(false);
  }, [page, entityTypeFilter, actionFilter]);

  useEffect(() => {
    // Check admin role via server-side API (bypasses browser extension blocks)
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => setIsAdmin(json.role === "admin"))
      .catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    if (isAdmin) fetchLogs();
  }, [isAdmin, fetchLogs]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [entityTypeFilter, actionFilter]);

  if (isAdmin === false) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="rounded-full bg-red-100 p-4 mb-4">
          <Shield className="h-8 w-8 text-red-600" />
        </div>
        <h2 className="text-xl font-bold mb-2">Access Denied</h2>
        <p className="text-muted-foreground">
          Only administrators can view audit logs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">
          Track all changes made across the CRM system
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Filter className="h-4 w-4" />
          Filters:
        </div>
        <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Entity type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Entities</SelectItem>
            <SelectItem value="lead">Leads</SelectItem>
            <SelectItem value="task">Tasks</SelectItem>
            <SelectItem value="proposal">Proposals</SelectItem>
            <SelectItem value="invoice">Invoices</SelectItem>
            <SelectItem value="user">Users</SelectItem>
            <SelectItem value="activity">Activities</SelectItem>
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            <SelectItem value="create">Created</SelectItem>
            <SelectItem value="update">Updated</SelectItem>
            <SelectItem value="delete">Deleted</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground ml-auto">
          {total} total events
        </span>
      </div>

      {/* Table */}
      {loading && isAdmin === null ? (
        <TableSkeleton rows={8} />
      ) : loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No audit logs yet"
          description="Actions performed in the CRM will appear here."
        />
      ) : (
        <>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Timestamp</th>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-left font-medium">Action</th>
                  <th className="px-4 py-3 text-left font-medium">Entity</th>
                  <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                    Changes
                  </th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const actionCfg = ACTION_CONFIG[log.action] || ACTION_CONFIG.update;
                  const ActionIcon = actionCfg.icon;
                  return (
                    <tr
                      key={log.id}
                      className="border-b hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {formatDateTime(log.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">
                            {log.performer?.full_name || "System"}
                          </span>
                          <p className="text-xs text-muted-foreground">
                            {log.performer?.email || ""}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={actionCfg.color}
                        >
                          <ActionIcon className="h-3 w-3 mr-1" />
                          {actionCfg.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={
                            ENTITY_TYPE_COLORS[log.entity_type] ||
                            "bg-gray-100 text-gray-800"
                          }
                        >
                          {ENTITY_TYPE_LABELS[log.entity_type] ||
                            log.entity_type}
                        </Badge>
                        <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                          {log.entity_id.substring(0, 8)}...
                        </p>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell max-w-xs">
                        <ChangesDisplay
                          changes={
                            log.changes as Record<
                              string,
                              { old: unknown; new: unknown }
                            >
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
