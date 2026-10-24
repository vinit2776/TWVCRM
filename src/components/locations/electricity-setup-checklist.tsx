"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle, Circle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SetupCheck } from "@/lib/electricity-setup-checks";

interface Props {
  locationId: string;
  /** Changes when the settings above are saved, so the list re-reads. */
  refreshKey?: string;
}

interface Summary { missingRequired: number; missingRecommended: number }

export function ElectricitySetupChecklist({ locationId, refreshKey }: Props) {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/locations/${locationId}/electricity-setup`);
        if (!res.ok) throw new Error("read failed");
        const json = await res.json();
        if (!live) return;
        setChecks(json.data.checks);
        setSummary(json.data.summary);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [locationId, refreshKey]);

  if (failed) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">Couldn&apos;t load the setup checklist. Refresh to try again.</CardContent>
      </Card>
    );
  }
  if (!checks || !summary) return <div className="h-24 bg-muted animate-pulse rounded" />;

  const headline = summary.missingRequired > 0
    ? `${summary.missingRequired} thing${summary.missingRequired === 1 ? "" : "s"} to fix before bills flow`
    : summary.missingRecommended > 0
      ? "Ready for bills. One optional step left"
      : "Ready for bills";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span>Setup checklist</span>
          <span className={`text-xs font-normal ${summary.missingRequired > 0 ? "text-destructive" : "text-muted-foreground"}`}>{headline}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        {checks.map((c) => {
          const Icon = c.ok ? CheckCircle2 : c.level === "required" ? AlertTriangle : Circle;
          const tone = c.ok ? "text-emerald-600" : c.level === "required" ? "text-destructive" : "text-amber-600";
          return (
            <div key={c.key} className="flex gap-2.5 py-2.5 text-sm">
              <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone}`} aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">
                  {c.label}
                  {!c.ok && c.level === "recommended" && <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>}
                </p>
                <p className="text-xs text-muted-foreground">{c.detail}</p>
                {!c.ok && c.contracts && c.contracts.length > 0 && (
                  <p className="text-xs mt-1">
                    Open:{" "}
                    {c.contracts.map((ct, i) => (
                      <span key={ct.id}>
                        {i > 0 && ", "}
                        <Link href={`/contracts/${ct.id}`} className="text-primary underline underline-offset-2">{ct.number}</Link>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
