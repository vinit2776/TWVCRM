"use client";

import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";

interface WalkinPayment {
  id: string;
  amount: number;
  payment_mode: string;
  status: string;
  created_at: string;
  booking?: {
    id: string;
    booking_date: string;
    guest_name?: string;
    guest_company?: string;
    customer_type?: string;
    space?: { name: string };
    lead?: { first_name: string; last_name: string; company?: string };
  };
}

interface WalkinCollectionsTableProps {
  payments: WalkinPayment[];
}

const modeLabels: Record<string, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  razorpay: "Razorpay",
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  verified: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

export function WalkinCollectionsTable({ payments }: WalkinCollectionsTableProps) {
  if (payments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No walk-in collections this period
      </p>
    );
  }

  const total = payments
    .filter((p) => p.status === "verified")
    .reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="space-y-3">
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Customer</th>
              <th className="text-left px-3 py-2 font-medium">Space</th>
              <th className="text-left px-3 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Mode</th>
              <th className="text-right px-3 py-2 font-medium">Amount</th>
              <th className="text-center px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {payments.map((p) => (
              <tr key={p.id} className="hover:bg-accent/50">
                <td className="px-3 py-2">
                  {p.booking?.guest_company ||
                    p.booking?.guest_name ||
                    p.booking?.lead?.company ||
                    `${p.booking?.lead?.first_name || ""} ${p.booking?.lead?.last_name || ""}`.trim() ||
                    "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {p.booking?.space?.name || "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {p.booking?.booking_date ? formatDate(p.booking.booking_date) : formatDate(p.created_at)}
                </td>
                <td className="px-3 py-2">
                  {modeLabels[p.payment_mode] || p.payment_mode}
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatCurrency(p.amount)}
                </td>
                <td className="px-3 py-2 text-center">
                  <Badge className={statusColors[p.status] || ""} variant="outline">
                    {p.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-right text-sm">
        <span className="text-muted-foreground">Total (verified): </span>
        <span className="font-bold">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}
