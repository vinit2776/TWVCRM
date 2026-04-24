"use client";

import { Badge } from "@/components/ui/badge";
import type { SpaceAnalytics, SpaceUnitType } from "@/types";

const TYPE_LABELS: Record<SpaceUnitType, string> = {
  hot_desk:      "Hot Desks",
  dedicated_desk:"Dedicated Desks",
  private_cabin: "Private Cabins",
  managed_office:"Managed Offices",
};

const TYPE_COLORS: Record<SpaceUnitType, string> = {
  hot_desk:      "bg-sky-200",
  dedicated_desk:"bg-blue-300",
  private_cabin: "bg-violet-200",
  managed_office:"bg-pink-200",
};

function pct(val: number) {
  return `${Math.round(val * 100)}%`;
}

function rupees(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n.toLocaleString("en-IN")}`;
}

interface Props {
  analytics: SpaceAnalytics;
}

export function SpaceAnalyticsPanel({ analytics }: Props) {
  const { floors, overall_cuf, occupancy, revenue, idle_units } = analytics;

  const totalContractedRevenue = revenue.reduce((s, r) => s + r.monthly_revenue_contracted, 0);
  const totalPotentialRevenue  = revenue.reduce((s, r) => s + r.monthly_revenue_potential, 0);
  const totalUnits = occupancy.reduce((s, o) => s + o.total_units, 0);
  const totalContracted = occupancy.reduce((s, o) => s + o.contracted_units, 0);

  return (
    <div className="space-y-8">

      {/* ── KPI tiles ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-[#015E65]">{pct(overall_cuf)}</p>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">Overall CUF</p>
          <p className="text-xs text-muted-foreground">Leasable / Built-up</p>
        </div>
        <div className="border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-[#015E65]">
            {totalUnits > 0 ? pct(totalContracted / totalUnits) : "—"}
          </p>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">Occupancy</p>
          <p className="text-xs text-muted-foreground">{totalContracted} / {totalUnits} units</p>
        </div>
        <div className="border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-[#015E65]">{rupees(totalContractedRevenue)}</p>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">MRR (Contracted)</p>
          <p className="text-xs text-muted-foreground">per month</p>
        </div>
        <div className="border rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{rupees(totalPotentialRevenue - totalContractedRevenue)}</p>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">Vacant Revenue</p>
          <p className="text-xs text-muted-foreground">unrealised potential</p>
        </div>
      </div>

      {/* ── CUF per floor ───────────────────────────────────────────── */}
      {floors.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 uppercase tracking-wide text-muted-foreground">Floor Area Efficiency (CUF)</h3>
          <div className="space-y-3">
            {floors.map((f) => (
              <div key={f.floor_id}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium">{f.floor_name}</span>
                  <span className="text-muted-foreground">
                    {f.leasable_area_sqft.toLocaleString()} / {f.total_area_sqft.toLocaleString()} sqft — <strong>{pct(f.cuf)}</strong>
                  </span>
                </div>
                <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#015E65] rounded-full transition-all"
                    style={{ width: `${Math.round(f.cuf * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Occupancy by type ────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold mb-3 uppercase tracking-wide text-muted-foreground">Occupancy by Space Type</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {occupancy.filter((o) => o.total_units > 0).map((o) => (
            <div key={o.type} className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${TYPE_COLORS[o.type]}`} />
                  <span className="text-sm font-medium">{TYPE_LABELS[o.type]}</span>
                </div>
                <Badge variant="secondary">{pct(o.occupancy_rate)}</Badge>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-green-500 rounded-full transition-all"
                  style={{ width: `${Math.round(o.occupancy_rate * 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{o.contracted_units} / {o.total_units} units contracted</span>
                <span>{o.contracted_capacity} / {o.total_capacity} seats</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Revenue table ────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold mb-3 uppercase tracking-wide text-muted-foreground">Revenue by Space Type</h3>
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="px-4 py-2.5 text-left font-medium">Type</th>
                <th className="px-4 py-2.5 text-right font-medium">Units</th>
                <th className="px-4 py-2.5 text-right font-medium">Contracted</th>
                <th className="px-4 py-2.5 text-right font-medium text-green-700">MRR</th>
                <th className="px-4 py-2.5 text-right font-medium text-amber-600">Vacant</th>
              </tr>
            </thead>
            <tbody>
              {revenue.filter((r) => r.total_units > 0).map((r) => (
                <tr key={r.type} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-full ${TYPE_COLORS[r.type]}`} />
                      {TYPE_LABELS[r.type]}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{r.total_units}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{r.contracted_units}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-green-700">{rupees(r.monthly_revenue_contracted)}</td>
                  <td className="px-4 py-2.5 text-right text-amber-600">
                    {r.monthly_revenue_potential - r.monthly_revenue_contracted > 0
                      ? rupees(r.monthly_revenue_potential - r.monthly_revenue_contracted)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/40 font-semibold">
                <td className="px-4 py-2.5">Total</td>
                <td className="px-4 py-2.5 text-right">{totalUnits}</td>
                <td className="px-4 py-2.5 text-right">{totalContracted}</td>
                <td className="px-4 py-2.5 text-right text-green-700">{rupees(totalContractedRevenue)}</td>
                <td className="px-4 py-2.5 text-right text-amber-600">{rupees(totalPotentialRevenue - totalContractedRevenue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── Idle units ───────────────────────────────────────────────── */}
      {idle_units.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 uppercase tracking-wide text-muted-foreground">
            Idle Units ({idle_units.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {idle_units.map((u) => (
              <div key={u.id} className="border rounded-lg p-3 bg-amber-50 border-amber-200">
                <p className="font-mono text-xs font-bold">{u.code}</p>
                <p className="text-xs text-muted-foreground truncate">{u.name}</p>
                <p className="text-xs text-amber-700 mt-1 font-medium">{TYPE_LABELS[u.type]}</p>
                <p className="text-xs text-muted-foreground">{rupees(u.monthly_rate)}/mo</p>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
