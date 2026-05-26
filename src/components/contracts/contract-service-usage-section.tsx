"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Printer, ChevronDown, ChevronRight } from "lucide-react";

interface UsageRecord {
  id: string;
  period_year: number;
  period_month: number;
  quantity_used: number;
  quota_snapshot: number;
  overage_quantity: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
  total_with_gst: number;
  source: string;
  is_billed: boolean;
  billing_statement_id: string | null;
  notes: string | null;
  service: { name: string; unit_label: string; slug: string } | null;
}

interface PeriodGroup {
  key: string;           // "2026-05"
  label: string;         // "May 2026"
  year: number;
  month: number;
  records: UsageRecord[];
  totalWithGst: number;
  hasOverage: boolean;
  allBilled: boolean;
  anyBilled: boolean;
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(n);
}

/** "per page" → "pages", "per hour" → "hours", else return as-is */
function unitPlural(label: string): string {
  if (label.startsWith("per ")) return label.slice(4) + "s";
  return label;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "printer_report":   return "Report";
    case "manual":           return "Manual";
    case "meeting_booking":  return "Booking";
    default:                 return source;
  }
}

function BillingBadge({ isBilled }: { isBilled: boolean }) {
  return isBilled
    ? <Badge className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">Billed</Badge>
    : <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">Pending</Badge>;
}

export function ContractServiceUsageSection({ contractId }: { contractId: string }) {
  const [records,    setRecords]    = useState<UsageRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [openPeriods, setOpenPeriods] = useState<Set<string>>(new Set());
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("service_usage_records")
        .select(`
          id, period_year, period_month,
          quantity_used, quota_snapshot, overage_quantity,
          amount, gst_rate, gst_amount, total_with_gst,
          source, is_billed, billing_statement_id, notes,
          service:service_catalog(name, unit_label, slug)
        `)
        .eq("contract_id", contractId)
        .order("period_year",  { ascending: false })
        .order("period_month", { ascending: false });

      if (!cancelled) {
        setRecords((data ?? []) as unknown as UsageRecord[]);
        setLoading(false);
        // Auto-open most recent period
        if (data && data.length > 0) {
          const r = data[0] as unknown as UsageRecord;
          const key = `${r.period_year}-${String(r.period_month).padStart(2, "0")}`;
          setOpenPeriods(new Set([key]));
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group by billing period, newest first
  const periodGroups = useMemo<PeriodGroup[]>(() => {
    const map = new Map<string, UsageRecord[]>();
    for (const r of records) {
      const key = `${r.period_year}-${String(r.period_month).padStart(2, "0")}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, recs]) => {
        const [yr, mo] = key.split("-").map(Number);
        const label = new Date(yr, mo - 1, 1).toLocaleDateString("en-IN", {
          month: "long", year: "numeric",
        });
        const totalWithGst = recs.reduce((s, r) => s + Number(r.total_with_gst), 0);
        const hasOverage   = recs.some(r => Number(r.overage_quantity) > 0);
        const allBilled    = recs.every(r => r.is_billed);
        const anyBilled    = recs.some(r => r.is_billed);
        return { key, label, year: yr, month: mo, records: recs, totalWithGst, hasOverage, allBilled, anyBilled };
      });
  }, [records]);

  function togglePeriod(key: string) {
    setOpenPeriods(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const totalBillable = useMemo(
    () => records.reduce((s, r) => s + Number(r.total_with_gst), 0),
    [records]
  );
  const totalOverageRecords = records.filter(r => Number(r.overage_quantity) > 0).length;

  if (!loading && records.length === 0) return null; // Hide section entirely if no usage

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Printer className="h-4 w-4 text-muted-foreground" />
            Service Usage History
          </CardTitle>
          {!loading && records.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{periodGroups.length} month{periodGroups.length !== 1 ? "s" : ""}</span>
              {totalOverageRecords > 0 && (
                <>
                  <span>·</span>
                  <span className="text-amber-600 font-medium">{formatCurrency(totalBillable)} billed/pending</span>
                </>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm">Loading usage history…</span>
          </div>
        ) : (
          <div className="space-y-2">
            {periodGroups.map((group) => {
              const isOpen = openPeriods.has(group.key);

              return (
                <div key={group.key} className="border border-border rounded-lg overflow-hidden">
                  {/* Period header row */}
                  <button
                    onClick={() => togglePeriod(group.key)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/70 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      {isOpen
                        ? <ChevronDown  className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      }
                      <span className="font-medium text-sm">{group.label}</span>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{group.records.length} record{group.records.length !== 1 ? "s" : ""}</span>
                      {group.hasOverage && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-foreground">{formatCurrency(group.totalWithGst)}</span>
                        </>
                      )}
                      {!group.hasOverage && (
                        <>
                          <span>·</span>
                          <span className="text-emerald-600 font-medium">Within quota</span>
                        </>
                      )}
                      {group.anyBilled
                        ? <Badge className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">
                            {group.allBilled ? "Billed" : "Part billed"}
                          </Badge>
                        : <Badge className="text-xs bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200">Pending</Badge>
                      }
                    </div>
                  </button>

                  {/* Expanded records */}
                  {isOpen && (
                    <div className="divide-y divide-border">
                      {/* Table header */}
                      <div className="grid grid-cols-[1.8fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_0.7fr_0.7fr] gap-2 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        <span>Service</span>
                        <span className="text-right">Quota</span>
                        <span className="text-right">Used</span>
                        <span className="text-right">Free</span>
                        <span className="text-right">Overage</span>
                        <span className="text-right">Amount (GST incl.)</span>
                        <span className="text-center">Source</span>
                        <span className="text-center">Status</span>
                      </div>

                      {group.records.map((r) => {
                        const unit         = r.service ? unitPlural(r.service.unit_label) : "units";
                        const quota        = Number(r.quota_snapshot);
                        const used         = Number(r.quantity_used);
                        const freeUsed     = quota > 0 ? Math.min(used, quota) : 0;
                        const overage      = Number(r.overage_quantity);
                        const amountGst    = Number(r.total_with_gst);
                        const hasOverage   = overage > 0;

                        return (
                          <div
                            key={r.id}
                            className="grid grid-cols-[1.8fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_0.7fr_0.7fr] gap-2 items-center px-4 py-2.5 text-sm hover:bg-muted/20 transition-colors"
                          >
                            {/* Service name + notes */}
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="font-medium text-sm truncate">
                                {r.service?.name ?? "Unknown service"}
                              </span>
                              {r.notes && (
                                <span className="text-xs text-muted-foreground truncate">{r.notes}</span>
                              )}
                            </div>

                            {/* Quota */}
                            <div className="text-right text-xs text-muted-foreground">
                              {quota > 0 ? `${quota} ${unit}` : <span className="text-slate-400">—</span>}
                            </div>

                            {/* Used */}
                            <div className="text-right text-sm font-medium">
                              {used} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
                            </div>

                            {/* Free (within quota) */}
                            <div className="text-right text-xs">
                              {quota > 0
                                ? <span className="text-emerald-600">{freeUsed} {unit}</span>
                                : <span className="text-muted-foreground">—</span>
                              }
                            </div>

                            {/* Overage */}
                            <div className="text-right text-xs">
                              {hasOverage
                                ? <span className="text-amber-600 font-medium">{overage} {unit}</span>
                                : <span className="text-muted-foreground">—</span>
                              }
                            </div>

                            {/* Amount */}
                            <div className="text-right text-sm">
                              {hasOverage
                                ? <span className="font-semibold">{formatCurrency(amountGst)}</span>
                                : <span className="text-muted-foreground">—</span>
                              }
                            </div>

                            {/* Source */}
                            <div className="flex justify-center">
                              <Badge variant="secondary" className="text-xs">
                                {sourceLabel(r.source)}
                              </Badge>
                            </div>

                            {/* Billing status */}
                            <div className="flex justify-center">
                              <BillingBadge isBilled={r.is_billed} />
                            </div>
                          </div>
                        );
                      })}

                      {/* Period subtotal (only if there's actual billed amount) */}
                      {group.hasOverage && (
                        <div className="grid grid-cols-[1.8fr_0.9fr_0.9fr_0.9fr_0.9fr_1fr_0.7fr_0.7fr] gap-2 px-4 py-2 bg-muted/30 text-xs font-semibold text-muted-foreground">
                          <span className="col-span-5 text-right">Period total</span>
                          <span className="text-right text-foreground">{formatCurrency(group.totalWithGst)}</span>
                          <span /><span />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
