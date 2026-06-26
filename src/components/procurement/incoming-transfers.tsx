"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Truck, PackageCheck, CheckCircle2, Clock, ArrowRight } from "lucide-react";

/**
 * IncomingTransfers — "upcoming inwards" for a location. Shows transfers heading
 * TO this location that are still in the pipeline so the receiving team knows
 * what's on the way and can be prepared to receive it.
 */

interface IncomingTransfer {
  id: string;
  transfer_number: string;
  status: string;
  from_location?: { name?: string | null } | null;
  stock_transfer_items?: { id: string }[];
}

const STATUS_META: Record<string, { label: string; hint: string; Icon: React.ElementType; pill: string }> = {
  dispatched: {
    label: "On the way",
    hint: "Dispatched — prepare to receive",
    Icon: Truck,
    pill: "bg-indigo-100 text-indigo-700 border-indigo-200",
  },
  approved: {
    label: "Approved",
    hint: "Approved at HO — awaiting dispatch",
    Icon: CheckCircle2,
    pill: "bg-green-100 text-green-700 border-green-200",
  },
  pending_approval: {
    label: "Requested",
    hint: "Awaiting HO approval",
    Icon: Clock,
    pill: "bg-gray-100 text-gray-600 border-gray-200",
  },
};

export function IncomingTransfers({ locationId, locationName }: { locationId: string; locationName?: string }) {
  const [transfers, setTransfers] = useState<IncomingTransfer[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!locationId) {
      setTransfers([]);
      return;
    }
    let active = true;
    setLoading(true);
    fetch(`/api/procurement/transfers?incoming_to=${locationId}&limit=50`)
      .then((r) => r.json())
      .then((j) => {
        if (active) setTransfers(j.data || []);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId]);

  if (loading || transfers.length === 0) return null;

  const onTheWay = transfers.filter((t) => t.status === "dispatched").length;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <PackageCheck className="h-4 w-4 text-indigo-600" />
        <p className="text-sm font-medium text-indigo-900">
          {transfers.length} transfer{transfers.length > 1 ? "s" : ""} incoming
          {locationName ? ` to ${locationName}` : ""}
          {onTheWay > 0 && (
            <span className="font-normal text-indigo-700"> · {onTheWay} on the way</span>
          )}
        </p>
      </div>

      <div className="space-y-2">
        {transfers.map((t) => {
          const meta = STATUS_META[t.status] ?? STATUS_META.pending_approval;
          const Icon = meta.Icon;
          const itemCount = t.stock_transfer_items?.length ?? 0;
          return (
            <Link
              key={t.id}
              href={`/procurement/transfers/${t.id}`}
              className="flex items-center gap-3 rounded-md bg-background border px-3 py-2 hover:bg-muted/40 transition-colors"
            >
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${meta.pill}`}>
                <Icon className="h-3 w-3" />
                {meta.label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {t.from_location?.name ?? "—"}
                  <ArrowRight className="inline h-3 w-3 mx-1 text-muted-foreground" />
                  {itemCount} item{itemCount === 1 ? "" : "s"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t.transfer_number} · {meta.hint}
                </p>
              </div>
              <span className="text-xs text-indigo-600 font-medium shrink-0">
                {t.status === "dispatched" ? "Receive →" : "View →"}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
