"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ListChecks } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { NextStepItem } from "@/app/api/dashboard/next-steps/route";
import { DueBadge } from "@/components/journey/due-badge";

function daysSince(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  return d === 1 ? "1 day" : `${d} days`;
}

export function NextStepsWidget() {
  const [items, setItems] = useState<NextStepItem[] | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/next-steps")
      .then((r) => r.json())
      .then((json) => setItems(json.data || []))
      .catch(() => setItems([]));
  }, []);

  if (items === null) {
    return (
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" />
          <span className="text-base font-semibold">My next steps</span>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      </Card>
    );
  }

  const doable = items.filter((i) => i.actionable);
  const waiting = items.filter((i) => !i.actionable);

  return (
    <Card className="p-4" data-testid="next-steps-widget">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks className={`h-5 w-5 ${doable.length === 0 ? "text-green-600" : "text-primary"}`} />
        <span className="text-base font-semibold">My next steps</span>
        {doable.length > 0 && <span className="text-xs text-muted-foreground">· {doable.length}</span>}
      </div>

      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing waiting on you right now.</p>
      )}

      <div className="divide-y">
        {doable.map((i) => (
          <Link
            key={`${i.leadId}-${i.stepKey}`}
            href={i.href ?? `/leads/${i.leadId}`}
            className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-muted/40"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{i.customer}</div>
              <div className="truncate text-xs text-muted-foreground">
                {i.label}
                {i.detail ? ` · ${i.detail}` : ""} · {i.ref} · {daysSince(i.since)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <DueBadge due={i.due} />
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </Link>
        ))}
      </div>

      {waiting.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <div className="mb-1 text-xs text-muted-foreground">Waiting on something else</div>
          {waiting.map((i) => (
            <Link
              key={`${i.leadId}-${i.stepKey}`}
              href={`/leads/${i.leadId}`}
              className="block py-1 text-xs text-muted-foreground hover:underline"
            >
              {i.customer} · {i.label}
              {i.hint ? ` — ${i.hint}` : ""}
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
