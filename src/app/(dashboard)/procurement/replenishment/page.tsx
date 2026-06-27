"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { RefreshCw, PackageCheck, AlertTriangle, ArrowRight, Warehouse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";

interface Suggestion {
  location_id: string;
  location_name: string;
  item_id: string;
  item_name: string;
  department: string;
  unit: string;
  on_hand: number;
  min: number;
  max: number;
  suggest_qty: number;
  hub_available: number;
  fulfillable: boolean;
  short_by: number;
}

interface HubLowStock {
  item_id: string;
  item_name: string;
  department: string;
  unit: string;
  on_hand: number;
  min: number;
  max: number | null;
}

interface ReplenishmentData {
  hub: { id: string; name: string } | null;
  hubConfigured: boolean;
  suggestions: Suggestion[];
  hubLowStock: HubLowStock[];
  summary: {
    locationsAffected: number;
    itemsToRefill: number;
    totalSuggestedUnits: number;
    shortItems: number;
    hubLowStockCount: number;
  };
}

export default function ReplenishmentPage() {
  const [data, setData] = useState<ReplenishmentData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/procurement/replenishment");
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Group suggestions by location so each branch gets one consolidated transfer.
  const byLocation = useMemo(() => {
    const groups = new Map<string, { name: string; items: Suggestion[] }>();
    for (const s of data?.suggestions ?? []) {
      const g = groups.get(s.location_id) ?? { name: s.location_name, items: [] };
      g.items.push(s);
      groups.set(s.location_id, g);
    }
    return Array.from(groups.entries()).map(([location_id, g]) => ({ location_id, ...g }));
  }, [data]);

  const transferLink = (hubId: string, locationId: string, items: Suggestion[]) => {
    const itemsParam = items.map((i) => `${i.item_id}:${i.suggest_qty}`).join(",");
    const params = new URLSearchParams({
      from: hubId,
      to: locationId,
      origin: "replenishment",
      items: itemsParam,
    });
    return `/procurement/transfers/new?${params.toString()}`;
  };

  if (loading) return <TableSkeleton rows={8} />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <RefreshCw className="h-6 w-6" />
            Replenishment
          </h1>
          <p className="text-sm text-muted-foreground">
            Locations at or below their minimum, with a suggested refill transfer from HQ up to each item&apos;s max.
            Suggestions only — nothing moves until you create and approve a transfer.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
      </div>

      {!data?.hubConfigured && (
        <EmptyState
          icon={Warehouse}
          title="HQ hub not set up"
          description="No central hub location exists yet. Once HQ — Central Store is created and stocked, refill suggestions appear here."
        />
      )}

      {data?.hubConfigured && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard label="Locations to refill" value={data.summary.locationsAffected} />
            <SummaryCard label="Items below min" value={data.summary.itemsToRefill} />
            <SummaryCard label="Units to transfer" value={data.summary.totalSuggestedUnits} />
            <SummaryCard
              label="HQ can't cover"
              value={data.summary.shortItems}
              tone={data.summary.shortItems > 0 ? "danger" : "ok"}
            />
          </div>

          {/* Suggestions grouped by location */}
          {byLocation.length === 0 ? (
            <EmptyState
              icon={PackageCheck}
              title="Everything's stocked"
              description="No location is below its minimum. Set Min/Max in Settings → Reorder Settings to drive suggestions."
            />
          ) : (
            <div className="space-y-4">
              {byLocation.map((group) => (
                <div key={group.location_id} className="rounded-lg border overflow-hidden">
                  <div className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-2.5">
                    <h2 className="font-semibold text-sm flex items-center gap-2">
                      {group.name}
                      <Badge variant="secondary" className="text-[10px]">
                        {group.items.length} item{group.items.length > 1 ? "s" : ""}
                      </Badge>
                    </h2>
                    {data.hub && (
                      <Link href={transferLink(data.hub.id, group.location_id, group.items)}>
                        <Button size="sm" className="h-8">
                          Create transfer from HQ
                          <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                        </Button>
                      </Link>
                    )}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="px-4 py-2 text-left font-medium">Item</th>
                        <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">Dept</th>
                        <th className="px-4 py-2 text-right font-medium">On hand</th>
                        <th className="px-4 py-2 text-right font-medium">Min</th>
                        <th className="px-4 py-2 text-right font-medium">Max</th>
                        <th className="px-4 py-2 text-right font-medium">Suggest</th>
                        <th className="px-4 py-2 text-left font-medium">
                          <span className="inline-flex items-center gap-1">
                            HQ
                            <InfoTooltip text="Whether HQ has enough stock to cover this item's total refill across all locations." />
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((s) => (
                        <tr key={s.item_id} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2 font-medium">{s.item_name}</td>
                          <td className="px-4 py-2 hidden sm:table-cell">
                            <Badge variant="secondary" className="text-[10px]">
                              {PROCUREMENT_DEPARTMENT_LABELS[s.department] || s.department}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right text-amber-600 font-medium">
                            {s.on_hand} {s.unit}
                          </td>
                          <td className="px-4 py-2 text-right text-muted-foreground">{s.min}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">{s.max}</td>
                          <td className="px-4 py-2 text-right font-semibold">+{s.suggest_qty}</td>
                          <td className="px-4 py-2">
                            {s.fulfillable ? (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 text-[10px]">
                                ✓ {s.hub_available} avail
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="bg-red-100 text-red-800 text-[10px]">
                                short by {s.short_by}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* HQ low stock */}
          {data.hubLowStock.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-200">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <h2 className="font-semibold text-sm">HQ is running low — restock the hub</h2>
                <InfoTooltip text="HQ items at or below their own minimum. Restock HQ via Procurement → Material Request → PO → Receipt." />
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-amber-200 text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Item</th>
                    <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">Dept</th>
                    <th className="px-4 py-2 text-right font-medium">HQ on hand</th>
                    <th className="px-4 py-2 text-right font-medium">HQ min</th>
                  </tr>
                </thead>
                <tbody>
                  {data.hubLowStock.map((h) => (
                    <tr key={h.item_id} className="border-b border-amber-100 last:border-0">
                      <td className="px-4 py-2 font-medium">{h.item_name}</td>
                      <td className="px-4 py-2 hidden sm:table-cell">
                        <Badge variant="secondary" className="text-[10px]">
                          {PROCUREMENT_DEPARTMENT_LABELS[h.department] || h.department}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right text-red-600 font-medium">{h.on_hand} {h.unit}</td>
                      <td className="px-4 py-2 text-right text-muted-foreground">{h.min}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "danger";
}) {
  const toneClass =
    tone === "danger" && value > 0
      ? "text-red-600"
      : tone === "ok"
      ? "text-green-600"
      : "";
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
}
