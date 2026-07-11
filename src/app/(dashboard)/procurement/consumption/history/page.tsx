"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ConsumptionLog, BeverageLog } from "@/types";
import { BEVERAGE_TYPE_LABELS } from "@/lib/constants";
import { ConsumptionCorrectionDialog } from "@/components/procurement/consumption-correction-dialog";
import { ConsumptionLifecycleStatus } from "@/components/procurement/consumption-lifecycle-status";
import Link from "next/link";

interface Location {
  id: string;
  name: string;
}

export default function ConsumptionHistoryPage() {
  const { user } = useCurrentUser();
  const userRole = user?.role ?? "";
  const [activeTab, setActiveTab] = useState<"materials" | "beverages">("materials");
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [logs, setLogs] = useState<ConsumptionLog[]>([]);
  const [beverageLogs, setBeverageLogs] = useState<BeverageLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Correction dialog state
  const [correctionLog, setCorrectionLog] = useState<ConsumptionLog | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);

  // Beverages: photo preview + trend chart state
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState<string | null>(null);
  const [trendRange, setTrendRange] = useState<"week" | "month">("week");
  const [trend, setTrend] = useState<{ date: string; total: number }[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => r.json())
      .then((locData) => {
        const locs = locData.data || [];
        setLocations(locs);
        if (locs.length > 0) setSelectedLocation(locs[0].id);
      })
      .catch(() => toast.error("Failed to load data"));
  }, []);

  const logsRequestId = useRef(0);
  const fetchLogs = useCallback(async () => {
    if (!selectedLocation) return;
    const requestId = ++logsRequestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ location_id: selectedLocation, page: String(page) });
      if (fromDate) params.set("from_date", fromDate);
      if (toDate) params.set("to_date", toDate);

      if (activeTab === "materials") {
        if (statusFilter !== "all") params.set("status", statusFilter);
        const res = await fetch(`/api/procurement/consumption?${params}`);
        const data = await res.json();
        if (requestId !== logsRequestId.current) return;
        setLogs(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
      } else {
        const res = await fetch(`/api/procurement/beverage-logs?${params}`);
        const data = await res.json();
        if (requestId !== logsRequestId.current) return;
        setBeverageLogs(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
      }
    } catch {
      if (requestId === logsRequestId.current) toast.error("Failed to load consumption history");
    } finally {
      if (requestId === logsRequestId.current) setLoading(false);
    }
  }, [selectedLocation, fromDate, toDate, statusFilter, page, activeTab]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const trendRequestId = useRef(0);
  const fetchTrend = useCallback(async () => {
    if (activeTab !== "beverages" || !selectedLocation) return;
    const requestId = ++trendRequestId.current;
    setTrendLoading(true);
    try {
      const params = new URLSearchParams({ location_id: selectedLocation, range: trendRange });
      const res = await fetch(`/api/procurement/beverage-logs/trend?${params}`);
      const data = await res.json();
      // Ignore this response if a newer request (different location/range) has since been made —
      // otherwise a slow, now-stale fetch can overwrite the correct, faster one.
      if (requestId !== trendRequestId.current) return;
      setTrend(data.trend || []);
    } catch {
      if (requestId === trendRequestId.current) toast.error("Failed to load trend");
    } finally {
      if (requestId === trendRequestId.current) setTrendLoading(false);
    }
  }, [activeTab, selectedLocation, trendRange]);

  useEffect(() => {
    fetchTrend();
  }, [fetchTrend]);

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

      <Tabs
        value={activeTab}
        onValueChange={(v) => { setActiveTab(v as "materials" | "beverages"); setPage(1); }}
      >
        <TabsList>
          <TabsTrigger value="materials">Materials</TabsTrigger>
          <TabsTrigger value="beverages">Beverages</TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab === "beverages" && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Drinks trend</p>
              <div className="flex gap-1">
                {(["week", "month"] as const).map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={trendRange === r ? "default" : "outline"}
                    onClick={() => setTrendRange(r)}
                  >
                    {r === "week" ? "Week" : "Month"}
                  </Button>
                ))}
              </div>
            </div>
            {trendLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trend} margin={{ left: 0, right: 10 }}>
                  <defs>
                    <linearGradient id="beverageTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" fontSize={11} tickFormatter={(d) => d.slice(5)} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip formatter={(v) => [`${Number(v) || 0} drinks`, ""]} labelFormatter={(d) => d} />
                  <Area type="monotone" dataKey="total" stroke="#6366f1" fill="url(#beverageTrendFill)" name="Drinks" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      )}

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
        {activeTab === "materials" && (
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
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : activeTab === "materials" ? (
        logs.length === 0 ? (
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
                            <ConsumptionLifecycleStatus log={log} />
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : beverageLogs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No beverage logs found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Date / Time</th>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Drinks</th>
                <th className="text-left p-3 font-medium">Logged By</th>
                <th className="text-left p-3 font-medium">Photo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {beverageLogs.map((log) => (
                <tr key={log.id}>
                  <td className="p-3 text-sm">{formatDate(log.logged_at)}</td>
                  <td className="p-3 text-sm">{log.locations?.name || "—"}</td>
                  <td className="p-3 text-sm">
                    {(log.beverage_log_items ?? [])
                      .map((item) => `${BEVERAGE_TYPE_LABELS[item.drink_type] ?? item.drink_type} ×${item.quantity}`)
                      .join(", ") || "—"}
                  </td>
                  <td className="p-3 text-sm">{log.logger?.full_name || "—"}</td>
                  <td className="p-3 text-sm">
                    {log.photo_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewPhotoUrl(log.photo_url!)}
                        className="h-10 w-10 rounded-md overflow-hidden border bg-muted block"
                        aria-label="View verification photo"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={log.photo_url} alt="Verification" className="h-full w-full object-cover" />
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
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

      {/* Beverage verification photo preview */}
      <Dialog open={!!previewPhotoUrl} onOpenChange={(v) => !v && setPreviewPhotoUrl(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Verification Photo</DialogTitle>
          </DialogHeader>
          {previewPhotoUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={previewPhotoUrl} alt="Verification" className="w-full rounded-md" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
