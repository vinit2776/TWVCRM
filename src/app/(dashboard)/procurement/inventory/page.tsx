"use client";

import { useState, useEffect, useCallback } from "react";
import { Warehouse, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { IncomingTransfers } from "@/components/procurement/incoming-transfers";
import { InventoryAnalytics } from "@/components/procurement/inventory-analytics";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useScopedLocations } from "@/hooks/use-scoped-locations";
import {
  STOCK_DEPARTMENTS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PROCUREMENT_DEPARTMENT_COLORS,
} from "@/lib/constants";
import type { LocationStock } from "@/types";

// Only physical-stock departments are shown in Inventory.
const DEPARTMENT_TABS = ["all", ...STOCK_DEPARTMENTS] as const;

export default function InventoryPage() {
  const { availableLocations, primaryLocationId, loading: locationsLoading } = useScopedLocations();
  const [stock, setStock] = useState<LocationStock[]>([]);
  const [locationId, setLocationId] = useState("");
  const [department, setDepartment] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Auto-select the user's primary (or first available) location once resolved
  useEffect(() => {
    if (!locationId && primaryLocationId) setLocationId(primaryLocationId);
  }, [primaryLocationId, locationId]);

  const fetchStock = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    const params = new URLSearchParams({ location_id: locationId });
    if (department !== "all") params.set("department", department);
    const res = await fetch(`/api/procurement/inventory?${params}`);
    if (res.ok) {
      const json = await res.json();
      setStock(json.data || []);
    }
    setLoading(false);
  }, [locationId, department]);

  useEffect(() => {
    if (locationId) fetchStock();
  }, [fetchStock, locationId]);

  // Only show physical-stock departments (hide administration / non-stock),
  // then apply the search filter.
  const filtered = stock.filter((s) => {
    const dept = (s.procurement_items as { department?: string } | null)?.department ?? "";
    if (!STOCK_DEPARTMENTS.includes(dept)) return false;
    if (!search.trim()) return true;
    const name = s.procurement_items?.name ?? "";
    return name.toLowerCase().includes(search.toLowerCase());
  });

  const getStatus = (item: LocationStock) => {
    if (item.quantity_on_hand === 0) return "out";
    if (item.reorder_level > 0 && item.quantity_on_hand <= item.reorder_level) return "low";
    return "ok";
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "out":
        return <Badge variant="secondary" className="bg-red-100 text-red-800">Out</Badge>;
      case "low":
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800">Low</Badge>;
      default:
        return <Badge variant="secondary" className="bg-green-100 text-green-800">OK</Badge>;
    }
  };

  if (locationsLoading) return <TableSkeleton rows={8} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            Stock levels across locations — view only. Stock changes through purchase orders, transfers, and consumption.
          </p>
        </div>

        <Select
          value={locationId || "__none__"}
          onValueChange={(val) => setLocationId(val === "__none__" ? "" : val)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Select location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Select location</SelectItem>
            {availableLocations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="inventory" className="space-y-4">
        <TabsList>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="inventory" className="space-y-4">

      {/* Department filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {DEPARTMENT_TABS.map((d) => (
          <button
            key={d}
            onClick={() => setDepartment(d)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              department === d
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {d === "all" ? "All" : PROCUREMENT_DEPARTMENT_LABELS[d]}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by item name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Upcoming inwards — transfers on the way to this location */}
      {locationId && (
        <IncomingTransfers
          locationId={locationId}
          locationName={availableLocations.find((l) => l.id === locationId)?.name}
        />
      )}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No inventory items"
          description={
            search
              ? "No items match your search. Try a different term."
              : "No stock records found for this location and department."
          }
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Item Name</th>
                <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Department</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Unit</th>
                <th className="px-4 py-3 text-right font-medium">Qty on Hand</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Reorder Level</th>
                <th className="px-4 py-3 text-center font-medium">
                  <span className="inline-flex items-center gap-1">
                    Status
                    <InfoTooltip text="OK = healthy stock. Low = at or below the reorder level, plan to reorder. Out = nothing in stock." />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const dept = item.procurement_items?.department ?? "";
                const status = getStatus(item);
                return (
                  <tr key={item.id} className="border-b hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        {item.procurement_items?.name ?? "—"}
                        {(item.procurement_items as { item_type?: string } | null)?.item_type === "service" && (
                          <Badge
                            variant="secondary"
                            className="bg-violet-100 text-violet-700 text-[10px] gap-1"
                            title="Service / contract item (e.g. AMC). Tracked at this location but cannot be transferred or consumed."
                          >
                            Service
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      {dept ? (
                        <Badge variant="secondary" className={PROCUREMENT_DEPARTMENT_COLORS[dept] || ""}>
                          {PROCUREMENT_DEPARTMENT_LABELS[dept] || dept}
                        </Badge>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                      {item.procurement_items?.unit ?? "—"}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${status === "out" ? "text-red-600" : status === "low" ? "text-amber-600" : ""}`}>
                      {item.quantity_on_hand}
                      {item.reorder_level > 0 && (
                        <span className="block md:hidden text-[10px] font-normal text-muted-foreground">
                          reorder at {item.reorder_level}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell text-muted-foreground">
                      {item.reorder_level > 0 ? item.reorder_level : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {statusBadge(status)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </TabsContent>

        <TabsContent value="analytics">
          {locationId ? (
            <InventoryAnalytics
              locationId={locationId}
              locationName={availableLocations.find((l) => l.id === locationId)?.name}
            />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Select a location to view analytics.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
