"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload } from "lucide-react";
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
}

export function VoucherInventoryCard({
  group,
  onRefill,
}: VoucherInventoryCardProps) {
  const percentage =
    group.total > 0 ? Math.round((group.available / group.total) * 100) : 0;

  return (
    <Card className={`${STOCK_BG_COLORS[group.stock_level]} transition-colors`}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <div
              className={`h-2.5 w-2.5 rounded-full ${STOCK_DOT_COLORS[group.stock_level]}`}
            />
            <Badge variant="outline" className="text-xs font-medium">
              {group.label}
            </Badge>
          </div>
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
