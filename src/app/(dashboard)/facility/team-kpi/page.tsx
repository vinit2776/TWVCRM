"use client";

/**
 * Team KPI — per-technician metrics for IT manager / appraisal use.
 * Includes a CSV export button that hits the API with format=csv.
 */

import { useEffect, useState } from "react";
import { Download, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/facility-ui";
import type { FacilityTechnicianKpi } from "@/types";

const PRESETS: Array<{ label: string; days: number }> = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
];

export default function FacilityTeamKpiPage() {
  const [rows, setRows] = useState<FacilityTechnicianKpi[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  const fromTo = () => {
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - days * 86400000);
    return { dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() };
  };

  const fetchData = async () => {
    setLoading(true);
    const { dateFrom, dateTo } = fromTo();
    const res = await fetch(`/api/facility/team-kpi?date_from=${dateFrom}&date_to=${dateTo}`);
    const json = await res.json();
    setRows(json.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [days]);

  const downloadCsv = () => {
    const { dateFrom, dateTo } = fromTo();
    window.location.href = `/api/facility/team-kpi?date_from=${dateFrom}&date_to=${dateTo}&format=csv`;
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Team KPI</h1>
          <p className="text-xs md:text-sm text-muted-foreground">Per-technician performance — used for appraisal reviews</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md bg-muted/40 p-0.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setDays(p.days)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-sm transition",
                  days === p.days ? "bg-background shadow-sm" : "text-muted-foreground",
                )}
              >{p.label}</button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={downloadCsv}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">
          No IT technicians or managers found. Add them via the Team page first.
        </div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Technician</th>
                <th className="text-right px-3 py-2 font-medium">Assigned</th>
                <th className="text-right px-3 py-2 font-medium">Resolved</th>
                <th className="text-right px-3 py-2 font-medium">Avg Ack</th>
                <th className="text-right px-3 py-2 font-medium">Avg Resolution</th>
                <th className="text-right px-3 py-2 font-medium">SLA Compliance</th>
                <th className="text-right px-3 py-2 font-medium">Reopen Rate</th>
                <th className="text-right px-3 py-2 font-medium">Satisfaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const slaClass = r.sla_compliance_pct >= 95
                  ? "text-emerald-700"
                  : r.sla_compliance_pct >= 80
                    ? "text-amber-700"
                    : "text-red-600";
                return (
                  <tr key={r.technician_id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{r.technician_name}</td>
                    <td className="px-3 py-2 text-right">{r.assigned}</td>
                    <td className="px-3 py-2 text-right">{r.resolved}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(r.avg_ack_minutes)}</td>
                    <td className="px-3 py-2 text-right">{formatDuration(r.avg_resolution_minutes)}</td>
                    <td className={cn("px-3 py-2 text-right font-semibold", slaClass)}>{r.sla_compliance_pct}%</td>
                    <td className="px-3 py-2 text-right">{r.reopen_rate_pct}%</td>
                    <td className="px-3 py-2 text-right">
                      {r.avg_satisfaction == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                          {r.avg_satisfaction.toFixed(1)}
                          <span className="text-xs text-muted-foreground">({r.satisfaction_responses})</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        SLA compliance is the headline KPI: ≥95% green, 80-94% amber, &lt;80% red.
        Avg Ack = time from report → first acknowledgement. Avg Resolution = acknowledged → resolved.
      </div>
    </div>
  );
}
