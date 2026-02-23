"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  CASE_STATUS_GROUPS,
  CASE_STATUS_LABELS,
  VO_PURPOSE_LABELS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type { VoCase } from "@/types";
import { cn } from "@/lib/utils";

interface CaseKanbanBoardProps {
  cases: VoCase[];
}

const GROUP_COLORS: Record<string, string> = {
  intake: "border-t-gray-400",
  processing: "border-t-blue-400",
  approval: "border-t-purple-400",
  execution: "border-t-orange-400",
  active: "border-t-green-400",
  closed: "border-t-red-400",
};

const GROUP_ORDER = ["intake", "processing", "approval", "execution", "active", "closed"];

export function CaseKanbanBoard({ cases }: CaseKanbanBoardProps) {
  const router = useRouter();

  // Group cases by status group
  const grouped: Record<string, VoCase[]> = {};
  GROUP_ORDER.forEach((key) => {
    grouped[key] = [];
  });

  cases.forEach((c) => {
    for (const [groupKey, group] of Object.entries(CASE_STATUS_GROUPS)) {
      if (group.statuses.includes(c.status)) {
        if (grouped[groupKey]) {
          grouped[groupKey].push(c);
        }
        break;
      }
    }
  });

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {GROUP_ORDER.map((groupKey) => {
        const group = CASE_STATUS_GROUPS[groupKey];
        if (!group) return null;
        const groupCases = grouped[groupKey] || [];

        return (
          <div key={groupKey} className="min-w-[280px] max-w-[320px] flex-shrink-0">
            {/* Column Header */}
            <div
              className={cn(
                "rounded-t-lg border-t-4 bg-muted/30 px-3 py-2 mb-2",
                GROUP_COLORS[groupKey]
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{group.label}</span>
                <Badge variant="secondary" className="text-xs">
                  {groupCases.length}
                </Badge>
              </div>
            </div>

            {/* Cards */}
            <div className="space-y-2">
              {groupCases.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No cases
                </div>
              ) : (
                groupCases.map((c) => (
                  <Card
                    key={c.id}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                    onClick={() => router.push(`/cases/${c.id}`)}
                  >
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-muted-foreground">
                          {c.case_number}
                        </span>
                        <StatusBadge type="case_status" value={c.status} />
                      </div>
                      <p className="text-sm font-medium line-clamp-1">{c.client_name}</p>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{VO_PURPOSE_LABELS[c.purpose] || c.purpose}</span>
                        {c.rate && <span className="font-medium">{formatCurrency(c.rate)}/mo</span>}
                      </div>
                      {c.aggregator && (
                        <p className="text-xs text-muted-foreground truncate">
                          {(c.aggregator as { name: string }).name}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
