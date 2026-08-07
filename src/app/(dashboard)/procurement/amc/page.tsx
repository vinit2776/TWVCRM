"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ClipboardList, Phone, Mail, AlertTriangle, CheckCircle2,
  XCircle, Clock, Loader2, Search, ChevronRight, RefreshCw,
  CalendarDays, Wrench, IndianRupee, Settings, ChevronDown, ChevronUp,
  Zap, ShieldCheck, Headphones, Star, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { AmcStatus } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

interface ServiceEvent {
  id: string;
  event_number: number;
  event_type: "breakdown" | "preventive" | "remote_support" | "annual_service";
  event_date: string;
  technician_name: string | null;
  issue_description: string;
  resolution_notes: string | null;
  is_confirmed: boolean;
  logger: { id: string; full_name: string } | null;
}

interface AmcRow {
  id: string;
  po_number: string;
  status: string;
  amc_status: AmcStatus;
  amc_start_date: string | null;
  amc_end_date: string | null;
  amc_visits_covered: number | null;
  amc_visits_used: number;
  amc_contact_name: string | null;
  amc_helpline_number: string | null;
  amc_contact_email: string | null;
  total_ordered_amount: number;
  created_at: string;
  procurement_vendors: { id: string; name: string } | null;
  locations: { id: string; name: string } | null;
  purchase_requests: { id: string; pr_number: string; department: string; expenditure_type: string } | null;
  purchase_order_items: Array<{ id: string; item_name: string; unit: string }>;
  linked_asset: { id: string; name: string; asset_code: string } | null;
  amc_scope_covered: string | null;
  amc_scope_exclusions: string | null;
}

const EVENT_TYPE_LABEL: Record<ServiceEvent["event_type"], string> = {
  breakdown:      "Breakdown",
  preventive:     "Preventive",
  remote_support: "Remote Support",
  annual_service: "Annual Service",
};

const EVENT_TYPE_BADGE: Record<ServiceEvent["event_type"], string> = {
  breakdown:      "bg-red-100 text-red-700",
  preventive:     "bg-green-100 text-green-700",
  remote_support: "bg-blue-100 text-blue-700",
  annual_service: "bg-purple-100 text-purple-700",
};

const EVENT_TYPE_ICON: Record<ServiceEvent["event_type"], React.ReactNode> = {
  breakdown:      <Zap className="h-3 w-3" />,
  preventive:     <ShieldCheck className="h-3 w-3" />,
  remote_support: <Headphones className="h-3 w-3" />,
  annual_service: <Star className="h-3 w-3" />,
};

const AMC_STATUS_LABELS: Record<AmcStatus, string> = {
  inactive: "Inactive",
  active:   "Active",
  expiring: "Expiring Soon",
  exhausted:"Exhausted",
  expired:  "Expired",
  terminated:"Terminated",
};

const AMC_STATUS_BADGE: Record<AmcStatus, string> = {
  inactive: "bg-gray-100 text-gray-600",
  active:   "bg-green-100 text-green-700",
  expiring: "bg-amber-100 text-amber-700",
  exhausted:"bg-red-100 text-red-700",
  expired:  "bg-red-100 text-red-600",
  terminated:"bg-rose-100 text-rose-700",
};

const AMC_STATUS_ICON: Record<AmcStatus, React.ReactNode> = {
  inactive: <Clock className="h-3.5 w-3.5" />,
  active:   <CheckCircle2 className="h-3.5 w-3.5" />,
  expiring: <AlertTriangle className="h-3.5 w-3.5" />,
  exhausted:<XCircle className="h-3.5 w-3.5" />,
  expired:  <XCircle className="h-3.5 w-3.5" />,
  terminated:<XCircle className="h-3.5 w-3.5" />,
};

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null;
  const diff = new Date(endDate).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function VisitsBar({ used, covered }: { used: number; covered: number | null }) {
  if (covered === null) {
    return (
      <span className="text-sm text-muted-foreground">
        {used} used · <span className="text-blue-600 font-medium">∞ unlimited</span>
      </span>
    );
  }
  const pct = Math.min(100, Math.round((used / covered) * 100));
  const barColor =
    pct >= 100 ? "bg-red-500" :
    pct >= 80  ? "bg-amber-500" :
    "bg-green-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{used} / {covered} visits used</span>
        <span className={pct >= 100 ? "text-red-600 font-medium" : "text-muted-foreground"}>{pct}%</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type AmcBudget = {
  financial_year: number;
  annual_budget: number | null;
  is_active: boolean;
  committed: number;
  provisional: number;
  utilisation_pct: number | null;
  is_over_budget: boolean;
};

export default function AmcRegisterPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AmcRow[]>([]);
  const [budget, setBudget] = useState<AmcBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<AmcStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [eventsCache, setEventsCache] = useState<Map<string, ServiceEvent[]>>(new Map());
  const [eventsLoading, setEventsLoading] = useState<Set<string>>(new Set());

  const toggleEvents = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandedIds.has(id)) {
      setExpandedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      return;
    }
    setExpandedIds((prev) => new Set(prev).add(id));
    if (eventsCache.has(id)) return;
    setEventsLoading((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/procurement/amc/${id}/events`);
      const json = await res.json();
      setEventsCache((prev) => new Map(prev).set(id, json.data ?? []));
    } catch {
      toast.error("Failed to load events");
    } finally {
      setEventsLoading((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  }, [expandedIds, eventsCache]);

  const fetchAmc = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("amc_status", statusFilter);
      const res = await fetch(`/api/procurement/amc?${params}`);
      const json = await res.json();
      setRows(json.data ?? []);
      if (json.budget) setBudget(json.budget);
    } catch {
      toast.error("Failed to load AMC contracts");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchAmc(); }, [fetchAmc]);

  const filtered = rows.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.po_number.toLowerCase().includes(q) ||
      r.procurement_vendors?.name.toLowerCase().includes(q) ||
      r.purchase_order_items.some((i) => i.item_name.toLowerCase().includes(q))
    );
  });

  // Counts per status for the tab chips
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.amc_status] = (counts[r.amc_status] ?? 0) + 1;
  }

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "AMC Contracts" }} />
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AMC Contracts</h1>
          <p className="text-muted-foreground text-sm">
            Track all Annual Maintenance Contracts — visits, contact details, and service history
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAmc}>
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* ── AMC Annual Budget Banner ─────────────────────────────────────── */}
      {budget && (
        <div className={`rounded-xl border px-4 py-3 ${budget.is_over_budget ? "border-red-200 bg-red-50" : "border-purple-200 bg-purple-50/50"}`}>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <IndianRupee className="h-4 w-4 text-purple-600 shrink-0" />
              <span className="font-semibold text-sm text-purple-900">
                FY {budget.financial_year}-{String(budget.financial_year + 1).slice(-2)} AMC Budget
              </span>
              {budget.is_over_budget && (
                <span className="text-[10px] font-semibold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">Over Budget</span>
              )}
              {!budget.annual_budget && (
                <span className="text-[10px] text-purple-600 italic">No annual budget set</span>
              )}
            </div>
            <Link
              href="/settings?tab=dept-budgets"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <Settings className="h-3 w-3" /> Configure
            </Link>
          </div>

          {/* Progress bar */}
          {budget.annual_budget && (
            <div className="w-full h-2.5 rounded-full bg-purple-100 overflow-hidden flex mb-2">
              <div
                className={`h-full rounded-full transition-all ${budget.is_over_budget ? "bg-red-500" : (budget.utilisation_pct ?? 0) >= 80 ? "bg-amber-500" : "bg-purple-500"}`}
                style={{ width: `${Math.min(budget.utilisation_pct ?? 0, 100)}%` }}
              />
              {budget.provisional > 0 && (
                <div
                  className="h-full bg-amber-300 opacity-80"
                  style={{ width: `${Math.min((budget.provisional / budget.annual_budget) * 100, 100 - Math.min(budget.utilisation_pct ?? 0, 100))}%` }}
                />
              )}
            </div>
          )}

          {/* Numbers */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-purple-800">
            <span>
              Committed: <span className="font-semibold">{formatCurrency(budget.committed)}</span>
              {budget.annual_budget && (
                <span className="text-purple-600"> / {formatCurrency(budget.annual_budget)}</span>
              )}
            </span>
            {budget.provisional > 0 && (
              <span className="text-amber-700">
                In pipeline: <span className="font-semibold">{formatCurrency(budget.provisional)}</span>
                <span className="text-[10px] ml-1 opacity-80">(submitted, pending approval)</span>
              </span>
            )}
            {budget.annual_budget && !budget.is_over_budget && (
              <span>
                Remaining: <span className="font-semibold">{formatCurrency(Math.max(0, budget.annual_budget - budget.committed))}</span>
              </span>
            )}
            {budget.is_over_budget && budget.annual_budget && (
              <span className="text-red-700 font-semibold">
                ↑ {formatCurrency(budget.committed - budget.annual_budget)} over budget
              </span>
            )}
          </div>
        </div>
      )}

      {/* Status filter chips */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "active", "expiring", "exhausted", "expired", "inactive"] as const).map((s) => {
          const isAll = s === "all";
          const active = statusFilter === s;
          const count = isAll ? rows.length : (counts[s] ?? 0);
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background border-border text-muted-foreground hover:border-foreground/40"
              }`}
            >
              {!isAll && AMC_STATUS_ICON[s]}
              {isAll ? "All" : AMC_STATUS_LABELS[s]}
              <span className={`ml-0.5 ${active ? "opacity-80" : "opacity-60"}`}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by vendor, PO, or item..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Wrench className="h-8 w-8 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No AMC contracts found</p>
            <p className="text-sm mt-1">
              Create a service PO from an approved AMC material request to get started.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => router.push("/procurement/requests?expenditure_type=amc&status=approved")}
            >
              <ClipboardList className="h-4 w-4 mr-1.5" />
              View AMC Requests
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => {
            const days = daysRemaining(row.amc_end_date);
            const itemName = row.purchase_order_items[0]?.item_name ?? "—";
            const missingContact = !row.amc_contact_name && !row.amc_helpline_number;
            const missingDates = !row.amc_start_date;

            return (
              <div
                key={row.id}
                className="border rounded-lg bg-card hover:bg-accent/30 cursor-pointer transition-colors"
                onClick={() => {
                  pushTrailEntry({ href: `/procurement/orders/${row.id}`, label: row.po_number });
                  router.push(`/procurement/orders/${row.id}`);
                }}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    {/* Left: item + vendor */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-semibold text-sm">{itemName}</span>
                        <span
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${AMC_STATUS_BADGE[row.amc_status]}`}
                        >
                          {AMC_STATUS_ICON[row.amc_status]}
                          {AMC_STATUS_LABELS[row.amc_status]}
                        </span>
                        {(missingContact || missingDates) && row.amc_status !== "expired" && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                            <AlertTriangle className="h-3 w-3" />
                            {missingDates ? "No start date" : "No contact info"}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        <span className="font-mono">{row.po_number}</span>
                        <span>·</span>
                        <span>{row.procurement_vendors?.name ?? "—"}</span>
                        {row.locations && (
                          <>
                            <span>·</span>
                            <span>{row.locations.name}</span>
                          </>
                        )}
                        {row.purchase_requests?.department && (
                          <>
                            <span>·</span>
                            <span className="capitalize">{row.purchase_requests.department}</span>
                          </>
                        )}
                        {row.linked_asset && (
                          <>
                            <span>·</span>
                            <Link
                              href={`/facility/assets/${row.linked_asset.id}`}
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="font-mono">{row.linked_asset.asset_code}</span>
                              <span>{row.linked_asset.name}</span>
                            </Link>
                          </>
                        )}
                      </div>

                      {/* Contract period */}
                      {(row.amc_start_date || row.amc_end_date) && (
                        <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                          <CalendarDays className="h-3.5 w-3.5" />
                          <span>
                            {row.amc_start_date ? formatDate(row.amc_start_date) : "?"}
                            {" – "}
                            {row.amc_end_date ? formatDate(row.amc_end_date) : "Open"}
                          </span>
                          {days !== null && days > 0 && (
                            <span className={`ml-1 font-medium ${days <= 60 ? "text-amber-600" : "text-muted-foreground"}`}>
                              ({days}d remaining)
                            </span>
                          )}
                          {days !== null && days <= 0 && (
                            <span className="ml-1 font-medium text-red-600">(expired)</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right: visits + amount */}
                    <div className="shrink-0 text-right space-y-2 min-w-[140px]">
                      <div className="text-sm font-semibold">
                        {formatCurrency(row.total_ordered_amount)}
                      </div>
                      <VisitsBar used={row.amc_visits_used} covered={row.amc_visits_covered} />
                    </div>
                  </div>

                  {/* Scope: what's covered / not covered */}
                  {(row.amc_scope_covered || row.amc_scope_exclusions) && (
                    <div className="mt-3 pt-3 border-t grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      {row.amc_scope_covered && (
                        <div>
                          <p className="font-semibold text-emerald-700 mb-1">✓ Covered</p>
                          <p className="text-muted-foreground whitespace-pre-line">{row.amc_scope_covered}</p>
                        </div>
                      )}
                      {row.amc_scope_exclusions && (
                        <div>
                          <p className="font-semibold text-red-600 mb-1">✗ Not covered</p>
                          <p className="text-muted-foreground whitespace-pre-line">{row.amc_scope_exclusions}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* AMC Contact */}
                  {(row.amc_contact_name || row.amc_helpline_number || row.amc_contact_email) && (
                    <div className="mt-3 pt-3 border-t flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
                      {row.amc_contact_name && (
                        <span className="font-medium text-foreground">{row.amc_contact_name}</span>
                      )}
                      {row.amc_helpline_number && (
                        <a
                          href={`tel:${row.amc_helpline_number}`}
                          className="flex items-center gap-1 hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Phone className="h-3 w-3" />
                          {row.amc_helpline_number}
                        </a>
                      )}
                      {row.amc_contact_email && (
                        <a
                          href={`mailto:${row.amc_contact_email}`}
                          className="flex items-center gap-1 hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Mail className="h-3 w-3" />
                          {row.amc_contact_email}
                        </a>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer: toggle events + view detail link */}
                <div className="border-t px-4 py-2 flex items-center justify-between text-xs text-muted-foreground">
                  <button
                    className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                    onClick={(e) => toggleEvents(row.id, e)}
                  >
                    {eventsLoading.has(row.id) ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : expandedIds.has(row.id) ? (
                      <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" />
                    )}
                    {row.amc_visits_used > 0
                      ? `${row.amc_visits_used} event${row.amc_visits_used !== 1 ? "s" : ""} logged`
                      : "No events yet"}
                  </button>
                  <Link
                    href={`/procurement/orders/${row.id}`}
                    className="flex items-center gap-1 text-primary font-medium hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      pushTrailEntry({ href: `/procurement/orders/${row.id}`, label: row.po_number });
                    }}
                  >
                    View & Log Events <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                </div>

                {/* Expandable events panel */}
                {expandedIds.has(row.id) && (
                  <div className="border-t bg-muted/30 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {eventsLoading.has(row.id) ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (eventsCache.get(row.id) ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-3">
                        No events logged for this AMC yet.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {(eventsCache.get(row.id) ?? []).map((ev) => (
                          <div key={ev.id} className="flex items-start gap-3 text-xs">
                            {/* type badge */}
                            <span className={`inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded font-medium ${EVENT_TYPE_BADGE[ev.event_type]}`}>
                              {EVENT_TYPE_ICON[ev.event_type]}
                              {EVENT_TYPE_LABEL[ev.event_type]}
                            </span>
                            {/* date */}
                            <span className="shrink-0 text-muted-foreground pt-0.5">{formatDate(ev.event_date)}</span>
                            {/* description */}
                            <div className="flex-1 min-w-0">
                              <p className="text-foreground line-clamp-1">{ev.issue_description}</p>
                              {ev.resolution_notes && (
                                <p className="text-muted-foreground line-clamp-1 mt-0.5">↳ {ev.resolution_notes}</p>
                              )}
                            </div>
                            {/* technician / logger */}
                            <span className="shrink-0 flex items-center gap-1 text-muted-foreground pt-0.5">
                              <User className="h-3 w-3" />
                              {ev.technician_name ?? ev.logger?.full_name ?? "—"}
                            </span>
                            {/* confirmed badge */}
                            {ev.is_confirmed && (
                              <span className="shrink-0 inline-flex items-center gap-0.5 text-green-600 pt-0.5">
                                <CheckCircle2 className="h-3 w-3" />
                                Confirmed
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Help note */}
      <p className="text-xs text-muted-foreground">
        AMC contracts are service POs linked to an{" "}
        <Link href="/procurement/requests" className="underline">AMC Material Request</Link>.
        Open any contract to log service events or update contact details.
      </p>
    </div>
  );
}
