"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/shared/status-badge";
import { VO_PURPOSE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Loader2, ExternalLink } from "lucide-react";

const GROUP_ORDER = ["intake", "review_approval", "execution", "active", "closed"];

interface CaseRow {
  id: string;
  case_number: string;
  client_name: string;
  client_company_name: string | null;
  purpose: string;
  status: string;
  rate: number | null;
  created_at: string;
}

interface CaseGroup {
  key: string;
  label: string;
  count: number;
  cases: CaseRow[];
}

interface AggregatorCasesTabProps {
  aggregatorId: string;
}

export function AggregatorCasesTab({ aggregatorId }: AggregatorCasesTabProps) {
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [groups, setGroups] = useState<CaseGroup[]>([]);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/aggregators/${aggregatorId}/case-summary`)
      .then((r) => r.json())
      .then((j) => {
        setTotal(j.data?.total ?? 0);
        setGroups(j.data?.groups ?? []);
      })
      .finally(() => setLoading(false));
  }, [aggregatorId]);

  const incompleteCount = groups
    .filter((g) => ["intake", "review_approval", "execution"].includes(g.key))
    .reduce((sum, g) => sum + g.count, 0);

  const allCases = useMemo(
    () => GROUP_ORDER.flatMap((key) => groups.find((g) => g.key === key)?.cases ?? []),
    [groups],
  );

  const visibleCases = activeFilter ? groups.find((g) => g.key === activeFilter)?.cases ?? [] : allCases;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-12">No cases linked to this aggregator yet.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold">{total}</span>
        <span className="text-xs text-muted-foreground">total case{total === 1 ? "" : "s"}</span>
      </div>

      {incompleteCount > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
          {incompleteCount} case{incompleteCount === 1 ? "" : "s"} not yet Active — won&apos;t appear on the Billing tab until then.
        </p>
      )}

      {/* Stage filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setActiveFilter(null)}
          className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
            activeFilter === null
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:bg-muted/40"
          }`}
        >
          All ({total})
        </button>
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => setActiveFilter(g.key)}
            disabled={g.count === 0}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-default ${
              activeFilter === g.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted/40"
            }`}
          >
            {g.label} ({g.count})
          </button>
        ))}
      </div>

      {/* Case table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium">Case #</th>
              <th className="px-4 py-2 text-left font-medium">Client</th>
              <th className="px-4 py-2 text-left font-medium hidden md:table-cell">Purpose</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium hidden sm:table-cell">Rate</th>
              <th className="px-4 py-2 text-left font-medium hidden lg:table-cell">Created</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visibleCases.map((c) => (
              <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-4 py-2 font-mono text-xs">{c.case_number}</td>
                <td className="px-4 py-2">
                  <span className="font-medium">{c.client_company_name || c.client_name}</span>
                  {c.client_company_name && (
                    <p className="text-xs text-muted-foreground">{c.client_name}</p>
                  )}
                </td>
                <td className="px-4 py-2 text-muted-foreground hidden md:table-cell">
                  {VO_PURPOSE_LABELS[c.purpose] ?? c.purpose}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge type="case_status" value={c.status} />
                </td>
                <td className="px-4 py-2 text-right hidden sm:table-cell">
                  {c.rate ? formatCurrency(c.rate) : "-"}
                </td>
                <td className="px-4 py-2 text-muted-foreground hidden lg:table-cell">
                  {formatDate(c.created_at)}
                </td>
                <td className="px-4 py-2 text-right">
                  <Link
                    href={`/cases/${c.id}`}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Stages mirror the case detail page&apos;s status pipeline — a case only becomes billable
        (and appears on the Billing tab) once it reaches Active.
      </p>
    </div>
  );
}
