"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CheckCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CashHandoverItem {
  id: string;
  amount: number;
  payment_date?: string;
  cash_handover_status: string;
  collected_at?: string;
  handed_over_at?: string;
  handover_notes?: string;
  source: "contract" | "booking";
  display_name: string;
  reference: string;
  payment_number?: string;
  collector?: { full_name: string } | null;
  handover_receiver?: { full_name: string } | null;
  // Click-through target — booking# for booking-source rows,
  // contract# for contract-source rows. Surfaced from the API so
  // finance can drill into the originating transaction.
  link_target_id?: string | null;
  link_target_label?: string | null;
  link_target_type?: "booking" | "contract" | null;
}

interface CashHandoverTableProps {
  items: CashHandoverItem[];
  status: "pending_handover" | "handed_over";
  onRefresh: () => void;
}

export function CashHandoverTable({ items, status, onRefresh }: CashHandoverTableProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  const handleConfirmHandover = async (item: CashHandoverItem) => {
    setConfirming(item.id);
    try {
      const endpoint = item.source === "contract"
        ? `/api/accounting/contract-payments/${item.id}`
        : `/api/booking-payments/${item.id}`;

      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm_handover" }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to confirm handover");
        return;
      }

      toast.success("Cash handover confirmed");
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setConfirming(null);
    }
  };

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        {status === "pending_handover" ? "No pending cash handovers" : "No completed handovers"}
      </p>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Customer</th>
            {/* Transaction column — the linked booking# / contract#
                that this cash payment came from. Replaces the legacy
                "Reference" text-only column with a click-through to
                the source so finance can audit each row in one click. */}
            <th className="text-left px-3 py-2 font-medium">Transaction</th>
            <th className="text-left px-3 py-2 font-medium">Source</th>
            <th className="text-right px-3 py-2 font-medium">Amount</th>
            <th className="text-left px-3 py-2 font-medium">Collected By</th>
            <th className="text-left px-3 py-2 font-medium">Date</th>
            {status === "pending_handover" && (
              <th className="text-center px-3 py-2 font-medium">Action</th>
            )}
            {status === "handed_over" && (
              <th className="text-left px-3 py-2 font-medium">Confirmed</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item) => (
            <tr key={`${item.source}-${item.id}`} className="hover:bg-accent/50">
              <td className="px-3 py-2">{item.display_name}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {item.link_target_id && item.link_target_label && item.link_target_type ? (
                  <Link
                    href={`/${item.link_target_type === "booking" ? "bookings" : "contracts"}/${item.link_target_id}`}
                    target="_blank"
                    rel="noopener"
                    className="text-primary hover:underline"
                    title={`Open ${item.link_target_type} — opens in new tab`}
                  >
                    {item.link_target_label}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">{item.reference || "—"}</span>
                )}
              </td>
              <td className="px-3 py-2">
                <Badge variant="outline" className="text-xs">
                  {item.source === "contract" ? "Contract" : "Booking"}
                </Badge>
              </td>
              <td className="px-3 py-2 text-right font-medium">{formatCurrency(item.amount)}</td>
              <td className="px-3 py-2">{item.collector?.full_name || "—"}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {item.collected_at ? formatDate(item.collected_at) : item.payment_date ? formatDate(item.payment_date) : "—"}
              </td>
              {status === "pending_handover" && (
                <td className="px-3 py-2 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleConfirmHandover(item)}
                    disabled={confirming === item.id}
                  >
                    {confirming === item.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Confirm
                      </>
                    )}
                  </Button>
                </td>
              )}
              {status === "handed_over" && (
                <td className="px-3 py-2 text-muted-foreground">
                  {item.handed_over_at ? formatDate(item.handed_over_at) : "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
