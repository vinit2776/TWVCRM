"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PLAN_STAGE_LABELS, type PlanStage } from "@/lib/auto-renewal-plan";

interface Row {
  id: string;
  contractNumber: string;
  customer: string;
  location: string | null;
  endDate: string;
  rollOn: string;
  stage: PlanStage;
  holds: { code: string; label: string }[];
  next: { label: string; on: string } | null;
  nextRent: number;
  nextRentPct: number;
  programmedPct: number;
  nextRentIsDraft: boolean;
}

interface Payload {
  counts: { total: number; held: number; dueNow: number; onAutopilot: number };
  rows: Row[];
}

export default function AutoRenewalsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auto-renewals");
        const json = await res.json().catch(() => null);
        if (!res.ok) setMessage(json?.error || "Could not load auto-renewals");
        else if (!json.data) setMessage(json.unavailable || "Auto-renewal is not available yet");
        else setData(json.data as Payload);
      } catch {
        setMessage("Network error. Please try again.");
      }
      setLoading(false);
    })();
  }, []);

  const tile = (label: string, value: number, hint: string) => (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <PageBreadcrumb current={{ label: "Auto-renewals" }} fallbackParent={{ href: "/contracts", label: "Contracts" }} />
      <div>
        <h1 className="text-2xl font-bold">Auto-renewals</h1>
        <p className="text-sm text-muted-foreground">
          Contracts with auto-renewal switched on. Report only for now: nothing is prepared, sent or rolled automatically yet.
        </p>
      </div>

      {loading ? (
        <TableSkeleton />
      ) : message ? (
        <EmptyState icon={Repeat} title="Auto-renewals unavailable" description={message} />
      ) : data && data.rows.length === 0 ? (
        <EmptyState icon={Repeat} title="No contract has auto-renewal on" description="Turn it on from a contract's page." />
      ) : data ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {tile("On autopilot", data.counts.onAutopilot, "nothing to do")}
            {tile("Needs a person", data.counts.held, "held, see reasons")}
            {tile("Acting now", data.counts.dueNow, "a step is due today")}
          </div>
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Contract</th>
                    <th className="px-4 py-2 font-medium">Customer</th>
                    <th className="px-4 py-2 font-medium">Ends</th>
                    <th className="px-4 py-2 font-medium">Next rent</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/contracts/${r.id}`} className="font-mono text-primary hover:underline">{r.contractNumber}</Link>
                      </td>
                      <td className="px-4 py-2">
                        {r.customer}
                        {r.location && <span className="block text-xs text-muted-foreground">{r.location}</span>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.endDate)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {r.stage === "held" ? "—" : (
                          <>
                            {formatCurrency(r.nextRent)} <span className="text-xs text-muted-foreground">(+{r.nextRentPct}%)</span>
                            {r.nextRentPct !== r.programmedPct && (
                              <Badge variant="outline" className="ml-1 text-[10px]">revised</Badge>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {r.stage === "held" ? (
                          <span className="text-amber-800">Held: {r.holds.map((h) => h.label).join(", ")}</span>
                        ) : (
                          <>
                            {PLAN_STAGE_LABELS[r.stage]}
                            {r.next && <span className="block text-xs text-muted-foreground">{r.next.label} · {formatDate(r.next.on)}</span>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
