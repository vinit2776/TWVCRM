"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ConsumptionLog } from "@/types";
import { ConsumptionCorrectionDialog } from "@/components/procurement/consumption-correction-dialog";
import Link from "next/link";

interface Location {
  id: string;
  name: string;
}

export default function ConsumptionHistoryPage() {
  const { user } = useCurrentUser();
  const userRole = user?.role ?? "";
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [logs, setLogs] = useState<ConsumptionLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Correction dialog state
  const [correctionLog, setCorrectionLog] = useState<ConsumptionLog | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => r.json())
      .then((locData) => {
        const locs = locData.locations || locData || [];
        setLocations(locs);
        if (locs.length > 0) setSelectedLocation(locs[0].id);
      })
      .catch(() => toast.error("Failed to load data"));
  }, []);

  const fetchLogs = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ location_id: selectedLocation, page: String(page) });
      if (fromDate) params.set("from_date", fromDate);
      if (toDate) params.set("to_date", toDate);
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`/api/procurement/consumption?${params}`);
      const data = await res.json();
      setLogs(data.logs || data || []);
      setTotalPages(data.total_pages || 1);
    } catch {
      toast.error("Failed to load consumption history");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation, fromDate, toDate, statusFilter, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const canCorrect = ["admin", "manager"].includes(userRole);

  const handleCorrectClick = (log: ConsumptionLog) => {
    setCorrectionLog(log);
    setCorrectionOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/procurement/consumption">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Consumption History</h1>
          <p className="text-muted-foreground">View and manage past consumption logs</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-end gap-4 flex-wrap">
        <div className="w-52">
          <Label className="text-sm mb-1.5 block">Location</Label>
          <Select value={selectedLocation} onValueChange={(v) => { setSelectedLocation(v); setPage(1); }}>
            <SelectTrigger>
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-sm mb-1.5 block">From</Label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
            className="w-40"
          />
        </div>
        <div>
          <Label className="text-sm mb-1.5 block">To</Label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => { setToDate(e.target.value); setPage(1); }}
            className="w-40"
          />
        </div>
        <div className="w-36">
          <Label className="text-sm mb-1.5 block">Status</Label>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No consumption logs found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="w-8 p-3" />
                <th className="text-left p-3 font-medium">Date / Time</th>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Logged By</th>
                <th className="text-left p-3 font-medium">Items</th>
                <th className="text-left p-3 font-medium">Status</th>
                {canCorrect && <th className="text-left p-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {logs.map((log) => {
                const isExpanded = expandedId === log.id;
                const isVoided = log.status === "voided";
                return (
                  <tr key={log.id} className="group">
                    <td colSpan={canCorrect ? 7 : 6} className="p-0">
                      {/* Main row */}
                      <div
                        className="flex items-center cursor-pointer hover:bg-muted/30 transition-colors"
                        onClick={() => setExpandedId(isExpanded ? null : log.id)}
                      >
                        <div className="w-8 p-3 flex items-center justify-center">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 p-3 text-sm">
                          {formatDate(log.logged_at)}
                        </div>
                        <div className="flex-1 p-3 text-sm">
                          {log.locations?.name || "—"}
                        </div>
                        <div className="flex-1 p-3 text-sm">
                          {log.logger?.full_name || "—"}
                        </div>
                        <div className="flex-1 p-3 text-sm">
                          {log.consumption_log_items?.length || 0} items
                        </div>
                        <div className="flex-1 p-3">
                          {isVoided ? (
                            <Badge variant="destructive">Voided</Badge>
                          ) : (
                            <Badge variant="secondary">Active</Badge>
                          )}
                        </div>
                        {canCorrect && (
                          <div className="flex-1 p-3">
                            {!isVoided && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCorrectClick(log);
                                }}
                              >
                                Correct
                              </Button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && log.consumption_log_items && (
                        <div className="bg-muted/20 px-8 py-3 border-t">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-muted-foreground">
                                <th className="text-left py-1.5 font-medium">Item</th>
                                <th className="text-left py-1.5 font-medium">Quantity</th>
                                <th className="text-left py-1.5 font-medium">Unit</th>
                                <th className="text-left py-1.5 font-medium">Notes</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-muted">
                              {log.consumption_log_items.map((item) => (
                                <tr key={item.id}>
                                  <td className="py-1.5">{item.item_name}</td>
                                  <td className="py-1.5 font-medium">{item.quantity_consumed}</td>
                                  <td className="py-1.5 text-muted-foreground">{item.unit}</td>
                                  <td className="py-1.5 text-muted-foreground">{item.notes || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {log.notes && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Notes: {log.notes}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {/* Correction Dialog */}
      <ConsumptionCorrectionDialog
        log={correctionLog}
        open={correctionOpen}
        onOpenChange={setCorrectionOpen}
        onSuccess={() => {
          setCorrectionOpen(false);
          setCorrectionLog(null);
          fetchLogs();
        }}
      />
    </div>
  );
}
