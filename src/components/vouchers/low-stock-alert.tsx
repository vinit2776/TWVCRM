"use client";

import { AlertTriangle } from "lucide-react";
import type { VoucherInventoryGroup } from "@/types";

interface LowStockAlertProps {
  alerts: VoucherInventoryGroup[];
}

export function LowStockAlert({ alerts }: LowStockAlertProps) {
  if (alerts.length === 0) return null;

  const outOfStock = alerts.filter((a) => a.stock_level === "red");
  const lowStock = alerts.filter((a) => a.stock_level === "amber");

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-800">
            Low Voucher Stock Alert
          </p>
          <div className="text-sm text-amber-700 space-y-1">
            {outOfStock.length > 0 && (
              <p>
                <span className="font-medium text-red-700">Out of stock:</span>{" "}
                {outOfStock.map((a) => a.label).join(", ")}
              </p>
            )}
            {lowStock.length > 0 && (
              <p>
                <span className="font-medium text-amber-700">Low stock (&lt;10):</span>{" "}
                {lowStock.map((a) => `${a.label} (${a.available} left)`).join(", ")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
