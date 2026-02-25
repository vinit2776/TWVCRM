"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PO_STATUS_LABELS, PO_STATUS_COLORS } from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PoStatus } from "@/types";

interface HistoryEntry {
  id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit: string;
  unit_price?: number;
  total_amount?: number;
  purchase_orders: {
    po_number: string;
    status: string;
    created_at: string;
    actual_delivery_date?: string;
    procurement_vendors?: { name: string } | null;
    locations?: { name: string } | null;
  };
}

interface Props {
  itemId: string;
  itemName: string;
  triggerClassName?: string;
}

export function ItemHistoryDialog({ itemId, itemName, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [fetched, setFetched] = useState(false);

  const handleOpen = async () => {
    setOpen(true);
    if (fetched) return; // already loaded
    setLoading(true);
    try {
      const res = await fetch(`/api/procurement/items/${itemId}/history`);
      if (res.ok) {
        const json = await res.json();
        setHistory(json.data ?? []);
      }
    } finally {
      setLoading(false);
      setFetched(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={
          triggerClassName ??
          "text-xs text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1"
        }
      >
        <History className="h-3 w-3" /> History
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Purchase History — {itemName}</DialogTitle>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              No purchase history found for this item.
            </p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2.5 text-left font-medium">PO #</th>
                    <th className="px-3 py-2.5 text-left font-medium">Vendor</th>
                    <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">
                      Location
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                      Unit Price
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                      Total
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    <th className="px-3 py-2.5 text-left font-medium hidden md:table-cell">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => {
                    const status = entry.purchase_orders.status as PoStatus;
                    return (
                      <tr
                        key={entry.id}
                        className="border-b last:border-0 hover:bg-muted/30"
                      >
                        <td className="px-3 py-2.5 font-mono text-xs font-medium text-primary">
                          {entry.purchase_orders.po_number}
                        </td>
                        <td className="px-3 py-2.5 font-medium">
                          {entry.purchase_orders.procurement_vendors?.name ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                          {entry.purchase_orders.locations?.name ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {entry.quantity_ordered} {entry.unit}
                        </td>
                        <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                          {entry.unit_price ? formatCurrency(entry.unit_price) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                          {entry.total_amount
                            ? formatCurrency(entry.total_amount)
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge
                            variant="secondary"
                            className={PO_STATUS_COLORS[status]}
                          >
                            {PO_STATUS_LABELS[status]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell text-xs">
                          {formatDate(entry.purchase_orders.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
