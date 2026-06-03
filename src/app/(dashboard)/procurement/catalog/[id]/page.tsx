"use client";

import { use, useState, useEffect } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, TrendingUp, TrendingDown, Minus, Package,
  BarChart3, Tag, History, MapPin, ShoppingCart, ExternalLink,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
  ITEM_TYPE_LABELS, PO_STATUS_LABELS, PO_STATUS_COLORS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ItemInsights {
  item: {
    id: string; name: string; department: string; unit: string;
    item_type: string; standard_price: number | null; gst_rate: number;
    description: string | null; is_active: boolean;
  };
  consumptionByMonth: { label: string; qty: number }[];
  consumptionTotal: number;
  consumptionThisMonth: number;
  consumptionLastMonth: number;
  consumptionTrend: "up" | "down" | "stable";
  topLocations: { name: string; qty: number }[];
  priceHistory: Array<{
    id: string; old_price: number | null; new_price: number | null;
    changed_at: string; notes: string | null;
    changer: { id: string; full_name?: string; email?: string } | null;
  }>;
  vendorPrices: Array<{
    id: string; vendor_id: string; price: number; gst_rate: number;
    last_po_number?: string; last_po_id?: string; updated_at: string;
    procurement_vendors: { id: string; name: string } | null;
  }>;
  avgPoPrice: number | null;
  minPoPrice: number | null;
  maxPoPrice: number | null;
  priceTrend: "up" | "down" | "stable";
  poHistory: Array<{
    id: string; quantity_ordered: number; unit_price: number | null;
    total_amount: number | null; created_at: string;
    purchase_orders: {
      id: string; po_number: string; status: string; created_at: string;
      procurement_vendors: { id: string; name: string } | null;
    } | null;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function TrendIcon({ trend, size = "sm" }: { trend: "up" | "down" | "stable"; size?: "sm" | "lg" }) {
  const cls = size === "lg" ? "h-5 w-5" : "h-4 w-4";
  if (trend === "up") return <TrendingUp className={`${cls} text-red-500`} />;
  if (trend === "down") return <TrendingDown className={`${cls} text-green-600`} />;
  return <Minus className={`${cls} text-muted-foreground`} />;
}

function TrendLabel({ trend }: { trend: "up" | "down" | "stable" }) {
  if (trend === "up") return <span className="text-red-500 font-medium">Rising</span>;
  if (trend === "down") return <span className="text-green-600 font-medium">Falling</span>;
  return <span className="text-muted-foreground">Stable</span>;
}

function Shimmer({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className ?? ""}`} />;
}

function MiniBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex-1 bg-muted rounded-full h-2">
      <div className={`h-2 rounded-full transition-all ${className ?? "bg-primary"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ItemInsightsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user } = useCurrentUser();
  const userRole = user?.role ?? "";
  const [data, setData] = useState<ItemInsights | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/procurement/items/${id}/insights`)
      .then((r) => r.json())
      .then((j) => { if (j.data) setData(j.data); })
      .finally(() => setLoading(false));
  }, [id]);

  const canSeePrices = ["admin", "manager"].includes(userRole);

  if (loading) {
    return (
      <div className="space-y-4">
        <Shimmer className="h-8 w-48" />
        <Shimmer className="h-32 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1,2,3].map((i) => <Shimmer key={i} className="h-28 w-full" />)}
        </div>
      </div>
    );
  }

  if (!data) return (
    <div className="text-center py-16">
      <p className="text-muted-foreground">Item not found.</p>
      <Button variant="ghost" onClick={() => router.push("/procurement/catalog")} className="mt-4">
        Back to Catalog
      </Button>
    </div>
  );

  const { item } = data;
  const maxConsumption = Math.max(...data.consumptionByMonth.map((m) => m.qty), 1);
  const maxVendorPrice = data.vendorPrices.length ? data.vendorPrices[data.vendorPrices.length - 1]?.price : 1;
  const maxLocation = data.topLocations[0]?.qty ?? 1;

  return (
    <div className="space-y-6">
      {/* Back */}
      <div className="flex items-center gap-3">
        <Link href="/procurement/catalog">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Item Catalog
          </Button>
        </Link>
      </div>

      {/* Item header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{item.name}</h1>
            <Badge className={PROCUREMENT_DEPARTMENT_COLORS[item.department] ?? ""}>
              {PROCUREMENT_DEPARTMENT_LABELS[item.department] ?? item.department}
            </Badge>
            <Badge className={item.item_type === "service" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"}>
              {ITEM_TYPE_LABELS[item.item_type ?? "goods"]}
            </Badge>
            <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
              {item.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {item.description && <p className="text-sm text-muted-foreground mt-1">{item.description}</p>}
          <p className="text-sm text-muted-foreground mt-1">Unit: <span className="font-medium uppercase">{item.unit}</span></p>
        </div>
        {canSeePrices && item.standard_price != null && (
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground">Catalog Price</p>
            <p className="text-2xl font-bold">{formatCurrency(item.standard_price)}</p>
            {item.gst_rate > 0 && <p className="text-xs text-muted-foreground">+ {item.gst_rate}% GST</p>}
          </div>
        )}
      </div>

      {/* ── KPI row ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Consumption this month */}
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Consumed This Month</p>
            <p className="text-2xl font-bold">{data.consumptionThisMonth.toLocaleString("en-IN")}</p>
            <div className="flex items-center gap-1 mt-1">
              <TrendIcon trend={data.consumptionTrend} />
              <span className="text-xs text-muted-foreground">{item.unit}</span>
            </div>
          </CardContent>
        </Card>

        {/* Total consumption */}
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Total Consumed (All Time)</p>
            <p className="text-2xl font-bold">{data.consumptionTotal.toLocaleString("en-IN")}</p>
            <p className="text-xs text-muted-foreground mt-1">{item.unit}</p>
          </CardContent>
        </Card>

        {/* POs placed */}
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Purchase Orders</p>
            <p className="text-2xl font-bold">{data.poHistory.length}</p>
            <p className="text-xs text-muted-foreground mt-1">orders recorded</p>
          </CardContent>
        </Card>

        {/* Vendor count */}
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Vendors Sourced From</p>
            <p className="text-2xl font-bold">{data.vendorPrices.length}</p>
            <p className="text-xs text-muted-foreground mt-1">with known prices</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Consumption trend + location breakdown ────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* 6-month consumption chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              Consumption — Last 6 Months
              <div className="ml-auto flex items-center gap-1">
                <TrendIcon trend={data.consumptionTrend} />
                <TrendLabel trend={data.consumptionTrend} />
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.consumptionByMonth.every((m) => m.qty === 0) ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No consumption recorded in the last 6 months.</p>
            ) : (
              <div className="space-y-2">
                {data.consumptionByMonth.map((m, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-12 shrink-0">{m.label}</span>
                    <MiniBar
                      value={m.qty}
                      max={maxConsumption}
                      className={i === 5 ? "bg-primary" : "bg-primary/40"}
                    />
                    <span className="text-xs font-medium w-16 text-right shrink-0">
                      {m.qty > 0 ? `${m.qty.toLocaleString("en-IN")} ${item.unit}` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {data.consumptionLastMonth > 0 && (
              <p className="text-xs text-muted-foreground mt-3 border-t pt-3">
                Last month: <span className="font-medium text-foreground">{data.consumptionLastMonth.toLocaleString("en-IN")} {item.unit}</span>
                {data.consumptionTrend !== "stable" && data.consumptionLastMonth > 0 && (
                  <span className={`ml-2 ${data.consumptionTrend === "up" ? "text-red-500" : "text-green-600"}`}>
                    {data.consumptionTrend === "up" ? "↑" : "↓"}{" "}
                    {Math.abs(Math.round(((data.consumptionThisMonth - data.consumptionLastMonth) / data.consumptionLastMonth) * 100))}% vs this month
                  </span>
                )}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Top consuming locations */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              Top Locations by Consumption
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.topLocations.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No location data available.</p>
            ) : (
              <div className="space-y-2">
                {data.topLocations.map((loc, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}</span>
                    <span className="text-sm font-medium w-32 truncate shrink-0">{loc.name}</span>
                    <MiniBar value={loc.qty} max={maxLocation} />
                    <span className="text-xs font-medium w-20 text-right shrink-0">
                      {loc.qty.toLocaleString("en-IN")} {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Price performance ────────────────────────────────────────────────── */}
      {canSeePrices && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Vendor price comparison */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                Vendor Price Comparison
                {data.vendorPrices.length > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground font-normal">
                    Range: {formatCurrency(data.minPoPrice ?? 0)} – {formatCurrency(data.maxPoPrice ?? 0)}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.vendorPrices.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No vendor prices on record yet. Prices are captured automatically when a PO is confirmed.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.vendorPrices.map((vp, i) => (
                    <div key={vp.id} className="flex items-center gap-3">
                      {i === 0 && (
                        <Badge className="bg-green-100 text-green-700 text-xs shrink-0">Cheapest</Badge>
                      )}
                      {i !== 0 && <span className="w-14 shrink-0" />}
                      <Link
                        href={`/procurement/vendors/${vp.vendor_id}`}
                        className="text-sm font-medium w-32 truncate shrink-0 text-primary hover:underline"
                      >
                        {vp.procurement_vendors?.name ?? "—"}
                      </Link>
                      <MiniBar
                        value={vp.price}
                        max={maxVendorPrice ?? 1}
                        className={i === 0 ? "bg-green-500" : "bg-primary/50"}
                      />
                      <span className="text-xs font-semibold w-20 text-right shrink-0">
                        {formatCurrency(vp.price)}
                      </span>
                    </div>
                  ))}
                  {data.avgPoPrice != null && (
                    <div className="border-t pt-2 mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Average across all POs</span>
                      <span className="font-medium text-foreground">{formatCurrency(data.avgPoPrice)}</span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Price history timeline */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                Catalog Price History
                <div className="ml-auto flex items-center gap-1">
                  <TrendIcon trend={data.priceTrend} />
                  <TrendLabel trend={data.priceTrend} />
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.priceHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No price changes recorded.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {data.priceHistory.map((entry) => {
                    const isUp = entry.new_price != null && entry.old_price != null && entry.new_price > entry.old_price;
                    const isDown = entry.new_price != null && entry.old_price != null && entry.new_price < entry.old_price;
                    return (
                      <div key={entry.id} className="flex items-start gap-3 text-sm py-1.5 border-b last:border-0">
                        <div className="mt-0.5 shrink-0">
                          {isUp ? <TrendingUp className="h-3.5 w-3.5 text-red-500" /> :
                           isDown ? <TrendingDown className="h-3.5 w-3.5 text-green-600" /> :
                           <Minus className="h-3.5 w-3.5 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-muted-foreground line-through text-xs">
                            {entry.old_price != null ? formatCurrency(entry.old_price) : "—"}
                          </span>
                          <span className="mx-1.5 text-xs text-muted-foreground">→</span>
                          <span className={`font-medium text-xs ${isUp ? "text-red-600" : isDown ? "text-green-700" : ""}`}>
                            {entry.new_price != null ? formatCurrency(entry.new_price) : "—"}
                          </span>
                          {entry.notes && <p className="text-xs text-muted-foreground italic mt-0.5">{entry.notes}</p>}
                        </div>
                        <div className="text-right text-xs text-muted-foreground shrink-0">
                          <p>{formatDate(entry.changed_at)}</p>
                          <p className="truncate max-w-[80px]">{entry.changer?.full_name ?? entry.changer?.email ?? "—"}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── PO History ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            Purchase Order History
            <span className="ml-auto text-xs text-muted-foreground font-normal">{data.poHistory.length} orders</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.poHistory.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">This item has not been ordered yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-4 py-2.5 text-left font-medium">PO #</th>
                    <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
                    <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                    {canSeePrices && <th className="px-4 py-2.5 text-right font-medium hidden sm:table-cell">Unit Price</th>}
                    {canSeePrices && <th className="px-4 py-2.5 text-right font-medium hidden md:table-cell">Total</th>}
                    <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium hidden lg:table-cell">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {data.poHistory.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => row.purchase_orders?.id && window.open(`/procurement/orders/${row.purchase_orders.id}`, "_self")}
                    >
                      <td className="px-4 py-2.5">
                        {row.purchase_orders ? (
                          <Link
                            href={`/procurement/orders/${row.purchase_orders.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-mono text-xs font-medium text-primary hover:underline flex items-center gap-1"
                          >
                            {row.purchase_orders.po_number}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-muted-foreground">
                        {row.purchase_orders?.procurement_vendors ? (
                          <Link
                            href={`/procurement/vendors/${row.purchase_orders.procurement_vendors.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-foreground hover:underline"
                          >
                            {row.purchase_orders.procurement_vendors.name}
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">
                        {row.quantity_ordered} {item.unit}
                      </td>
                      {canSeePrices && (
                        <td className="px-4 py-2.5 text-right hidden sm:table-cell font-medium">
                          {row.unit_price != null ? formatCurrency(row.unit_price) : "—"}
                        </td>
                      )}
                      {canSeePrices && (
                        <td className="px-4 py-2.5 text-right hidden md:table-cell text-muted-foreground">
                          {row.total_amount != null ? formatCurrency(row.total_amount) : "—"}
                        </td>
                      )}
                      <td className="px-4 py-2.5 hidden md:table-cell">
                        {row.purchase_orders?.status && (
                          <Badge variant="secondary" className={`text-xs ${PO_STATUS_COLORS[row.purchase_orders.status] ?? ""}`}>
                            {PO_STATUS_LABELS[row.purchase_orders.status] ?? row.purchase_orders.status}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 hidden lg:table-cell text-muted-foreground text-xs">
                        {row.purchase_orders?.created_at ? formatDate(row.purchase_orders.created_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
