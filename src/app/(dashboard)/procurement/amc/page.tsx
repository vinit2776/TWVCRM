"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ClipboardList, Phone, Mail, AlertTriangle, CheckCircle2,
  XCircle, Clock, Loader2, Search, ChevronRight, RefreshCw,
  CalendarDays, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { AmcStatus } from "@/types";

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
}

const AMC_STATUS_LABELS: Record<AmcStatus, string> = {
  inactive: "Inactive",
  active:   "Active",
  expiring: "Expiring Soon",
  exhausted:"Exhausted",
  expired:  "Expired",
};

const AMC_STATUS_BADGE: Record<AmcStatus, string> = {
  inactive: "bg-gray-100 text-gray-600",
  active:   "bg-green-100 text-green-700",
  expiring: "bg-amber-100 text-amber-700",
  exhausted:"bg-red-100 text-red-700",
  expired:  "bg-red-100 text-red-600",
};

const AMC_STATUS_ICON: Record<AmcStatus, React.ReactNode> = {
  inactive: <Clock className="h-3.5 w-3.5" />,
  active:   <CheckCircle2 className="h-3.5 w-3.5" />,
  expiring: <AlertTriangle className="h-3.5 w-3.5" />,
  exhausted:<XCircle className="h-3.5 w-3.5" />,
  expired:  <XCircle className="h-3.5 w-3.5" />,
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

export default function AmcRegisterPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AmcRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<AmcStatus | "all">("all");
  const [search, setSearch] = useState("");

  const fetchAmc = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("amc_status", statusFilter);
      const res = await fetch(`/api/procurement/amc?${params}`);
      const data = await res.json();
      setRows(data.data ?? []);
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
                onClick={() => router.push(`/procurement/orders/${row.id}`)}
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

                {/* Footer: view detail link */}
                <div className="border-t px-4 py-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {row.amc_visits_used > 0
                      ? `${row.amc_visits_used} service event${row.amc_visits_used !== 1 ? "s" : ""} logged`
                      : "No service events yet"}
                  </span>
                  <span className="flex items-center gap-1 text-primary font-medium">
                    View & Log Events <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </div>
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
