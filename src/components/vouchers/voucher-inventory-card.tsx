"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Shuffle, MapPin } from "lucide-react";
import type { VoucherInventoryGroup } from "@/types";

const STOCK_DOT_COLORS: Record<string, string> = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

const STOCK_BG_COLORS: Record<string, string> = {
  green: "border-green-200",
  amber: "border-amber-200",
  red: "border-red-200",
};

interface VoucherInventoryCardProps {
  group: VoucherInventoryGroup;
  onRefill?: (validityDays: number | null) => void;
  /** Called when admin clicks "Set Validity" on the Unclassified card */
  onReclassify?: () => void;
}

export function VoucherInventoryCard({
  group,
  onRefill,
  onReclassify,
}: VoucherInventoryCardProps) {
  const percentage =
    group.total > 0 ? Math.round((group.available / group.total) * 100) : 0;

  const isUnclassified = group.validity_days === null;

  return (
    <Card className={`${STOCK_BG_COLORS[group.stock_level]} transition-colors`}>
      <CardContent className="pt-6">
        {/* Location strap — each location runs its own pool, so the card
            now belongs to a specific location. Falls back to "All locations"
            for legacy rows where location_id was never set. */}
        {group.location_name ? (
          <div className="flex items-center gap-1 mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span className="font-medium text-foreground/80">{group.location_name}</span>
            {group.location_code && <span className="text-muted-foreground">({group.location_code})</span>}
          </div>
        ) : group.location_id === null ? (
          <div className="flex items-center gap-1 mb-2 text-[11px] uppercase tracking-wide text-amber-700">
            <MapPin className="h-3 w-3" />
            <span className="font-medium">No location assigned</span>
          </div>
        ) : null}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <div
              className={`h-2.5 w-2.5 rounded-full ${STOCK_DOT_COLORS[group.stock_level]}`}
            />
            <Badge variant="outline" className="text-xs font-medium">
              {group.label}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            {isUnclassified && onReclassify && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                onClick={onReclassify}
              >
                <Shuffle className="mr-1 h-3 w-3" />
                Set Validity
              </Button>
            )}
            {onRefill && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onRefill(group.validity_days)}
              >
                <Upload className="mr-1 h-3 w-3" />
                Refill
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-3xl font-bold tabular-nums">{group.available}</p>
            <p className="text-xs text-muted-foreground">available</p>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                group.stock_level === "green"
                  ? "bg-green-500"
                  : group.stock_level === "amber"
                  ? "bg-amber-500"
                  : "bg-red-500"
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{group.issued} issued</span>
            <span>{group.total} total</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
