"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUp, ArrowDown } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { CenterSummary } from "./types";

function sum(centers: CenterSummary[], key: "sales" | "billed" | "collections" | "occupied_seats" | "capacity") {
  return centers.reduce((s, c) => s + c[key], 0);
}

function Delta({ cur, prev, unit }: { cur: number; prev: number | null; unit: "pct" | "pts" }) {
  if (prev === null) {
    return <span className="text-xs font-medium text-muted-foreground">No prior-period data</span>;
  }
  if (prev === 0) {
    return <span className="text-xs font-medium text-muted-foreground">vs prior period: —</span>;
  }
  const diff = unit === "pts" ? cur - prev : ((cur - prev) / prev) * 100;
  const up = diff >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${up ? "text-emerald-600" : "text-red-600"}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(diff).toFixed(1)}{unit === "pts" ? " pts" : "%"}
      <span className="font-normal text-muted-foreground">vs prior period</span>
    </span>
  );
}

export function KpiTiles({
  current,
  previous,
  isMtd,
}: {
  current: CenterSummary[];
  previous: CenterSummary[] | null;
  isMtd: boolean;
}) {
  const curSales = sum(current, "sales");
  const curCollections = sum(current, "collections");
  const curBilled = sum(current, "billed");
  const curOccupied = sum(current, "occupied_seats");
  const curCapacity = sum(current, "capacity");
  const curEff = curBilled > 0 ? (curCollections / curBilled) * 100 : 0;
  const curOccPct = curCapacity > 0 ? (curOccupied / curCapacity) * 100 : 0;

  const prevSales = previous ? sum(previous, "sales") : null;
  const prevCollections = previous ? sum(previous, "collections") : null;
  const prevBilled = previous ? sum(previous, "billed") : null;
  const prevOccupied = previous ? sum(previous, "occupied_seats") : null;
  const prevCapacity = previous ? sum(previous, "capacity") : null;
  const prevEff = previous && prevBilled ? (prevCollections! / prevBilled) * 100 : previous ? 0 : null;
  const prevOccPct = previous && prevCapacity ? (prevOccupied! / prevCapacity) * 100 : previous ? 0 : null;

  const tiles = [
    { label: "New sales", mtd: isMtd, value: formatCurrency(curSales), delta: <Delta cur={curSales} prev={prevSales} unit="pct" /> },
    { label: "Collections", mtd: isMtd, value: formatCurrency(curCollections), delta: <Delta cur={curCollections} prev={prevCollections} unit="pct" /> },
    { label: "Collection efficiency", mtd: isMtd, value: `${curEff.toFixed(0)}%`, delta: <Delta cur={curEff} prev={prevEff} unit="pts" /> },
    { label: "Blended occupancy", mtd: false, value: `${curOccPct.toFixed(0)}%`, delta: <Delta cur={curOccPct} prev={prevOccPct} unit="pts" /> },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {t.label}
              {t.mtd && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">MTD</Badge>}
            </div>
            <div className="mt-1 text-2xl font-bold tracking-tight">{t.value}</div>
            <div className="mt-1">{t.delta}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
