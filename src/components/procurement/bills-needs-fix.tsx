"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

interface NeedsFixItem {
  bill_id: string;
  bill_number: string;
  po_number: string | null;
  total_amount: number;
  po_value: number | null;
  kind: "query" | "hold";
  asker: string | null;
  message: string | null;
}

/** Red group at the top of the bills list: bills the viewer can fix that someone is waiting on. */
export function BillsNeedsFix() {
  const [items, setItems] = useState<NeedsFixItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/procurement/bills/needs-fix", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (!cancelled && json) setItems(json.items ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 space-y-2" data-testid="bills-needs-fix">
      <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
        <AlertTriangle className="h-4 w-4" /> Needs your correction ({items.length})
      </div>
      {items.map((i) => {
        const over = i.po_value !== null && i.total_amount > i.po_value + 0.01;
        return (
          <div key={i.bill_id} className="flex items-center justify-between gap-3 rounded-md border-2 border-red-300 bg-white px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm">
                <span className="font-mono font-medium">{i.bill_number}</span>
                {i.po_number && <span className="text-muted-foreground"> · {i.po_number}</span>}
              </div>
              <div className="text-xs text-red-800 truncate">
                {i.kind === "query" ? `Query${i.asker ? ` from ${i.asker}` : ""}` : "Payment on hold"}
                {i.message ? ` — latest: “${i.message}”` : ""}
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="text-right">
                <div className={`text-sm font-medium ${over ? "text-red-700" : ""}`}>{formatCurrency(i.total_amount)}</div>
                {over && <div className="text-[11px] text-red-700">above PO {formatCurrency(i.po_value ?? 0)}</div>}
              </div>
              <Button asChild size="sm" className="bg-red-600 hover:bg-red-700 text-white">
                <Link href={`/procurement/bills/${i.bill_id}`}>Fix this bill</Link>
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
