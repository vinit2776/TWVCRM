"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface CaseSummaryRow {
  id: string;
  case_number: string;
  client_name: string;
  status: string;
}

interface CaseSummaryGroup {
  key: string;
  label: string;
  count: number;
  cases: CaseSummaryRow[];
}

interface AggregatorCaseSummaryProps {
  aggregatorId: string;
}

export function AggregatorCaseSummary({ aggregatorId }: AggregatorCaseSummaryProps) {
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<CaseSummaryGroup[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/aggregators/${aggregatorId}/case-summary`)
      .then((r) => r.json())
      .then((j) => {
        setTotal(j.data?.total ?? 0);
        setGroups(j.data?.groups ?? []);
      })
      .finally(() => setLoading(false));
  }, [aggregatorId]);

  // Everything before "Active" never reaches the Billing tab's
  // BILLABLE_CASE_STATUSES filter — surface that count explicitly so it
  // doesn't read as "0 cases" by omission.
  const incompleteCount = groups
    .filter((g) => ["intake", "review_approval", "execution"].includes(g.key))
    .reduce((sum, g) => sum + g.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cases</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">No cases linked yet.</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold">{total}</span>
              <span className="text-xs text-muted-foreground">total case{total === 1 ? "" : "s"}</span>
            </div>
            {incompleteCount > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                {incompleteCount} case{incompleteCount === 1 ? "" : "s"} not yet Active — won&apos;t appear on the Billing tab until then.
              </p>
            )}
            <div className="divide-y">
              {groups.map((g) => (
                <div key={g.key}>
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === g.key ? null : g.key)}
                    disabled={g.count === 0}
                    className="w-full flex items-center justify-between py-2 text-sm disabled:cursor-default"
                  >
                    <span className="flex items-center gap-1.5">
                      {g.count > 0 ? (
                        expanded === g.key ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <span className={g.count === 0 ? "text-muted-foreground" : ""}>{g.label}</span>
                    </span>
                    <span className="font-medium">{g.count}</span>
                  </button>
                  {expanded === g.key && g.count > 0 && (
                    <div className="pb-2 pl-5 space-y-1.5">
                      {g.cases.map((c) => (
                        <Link
                          key={c.id}
                          href={`/cases/${c.id}`}
                          className="flex items-center justify-between text-xs hover:underline"
                        >
                          <span className="text-muted-foreground">
                            <span className="font-mono">{c.case_number}</span> — {c.client_name}
                          </span>
                          <StatusBadge type="case_status" value={c.status} />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
