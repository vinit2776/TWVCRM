"use client";

import { useState } from "react";
import { CheckCircle, AlertTriangle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";

interface EbLine {
  id?: string;
  line_type: string;
  meter_label?: string | null;
  label?: string | null;
  units?: number | null;
  rate?: number | null;
  amount: number;
}

interface EbBill {
  id: string;
  bill_month: number;
  bill_year: number;
  status: "draft" | "invoiced" | "revised";
  landlord_bill_number?: string | null;
  landlord_bill_date?: string | null;
  landlord_total_amount: number;
  reimbursement_enabled: boolean;
  customer_subtotal?: number | null;
  customer_cgst?: number | null;
  customer_sgst?: number | null;
  customer_total?: number | null;
  customer_round_off?: number | null;
  vendor_bill_id?: string | null;
  created_at: string;
  electricity_bill_lines: EbLine[];
  locations?: { id: string; name: string; code: string };
  created_by_user?: { id: string; full_name: string };
  confirmed_by_user?: { id: string; full_name: string } | null;
  confirmed_at?: string | null;
  created_by?: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const LINE_TYPE_LABELS: Record<string, string> = {
  utility: "Utility (EB)",
  generator: "Generator (DG)",
  other: "Other",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-700 border-yellow-200",
  invoiced: "bg-green-100 text-green-700 border-green-200",
  revised: "bg-gray-100 text-gray-500 border-gray-200",
};

interface Props {
  bill: EbBill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
}

export function ElectricityBillReviewDialog({ bill, open, onOpenChange, onConfirmed }: Props) {
  const { user } = useCurrentUser();
  const [confirming, setConfirming] = useState(false);

  if (!bill) return null;

  const isMaker = bill.created_by === user?.id;
  const canConfirm =
    bill.status === "draft" &&
    (user?.role === "admin" || user?.role === "manager") &&
    !isMaker;

  const handleConfirm = async () => {
    setConfirming(true);
    const res = await fetch(`/api/electricity-bills/${bill.id}/confirm`, { method: "PATCH" });
    const json = await res.json();
    setConfirming(false);

    if (!res.ok) {
      toast.error(json.error || "Failed to confirm bill");
      return;
    }
    toast.success("Bill confirmed — status set to Invoiced");
    onConfirmed();
    onOpenChange(false);
  };

  const subtotalLines = bill.electricity_bill_lines.filter((l) => l.line_type !== "other");
  const otherLines = bill.electricity_bill_lines.filter((l) => l.line_type === "other");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-[#015E65]" />
            Electricity Bill — {MONTHS[bill.bill_month - 1]} {bill.bill_year}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Header meta */}
          <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
            <div className="space-y-0.5">
              <p className="font-medium">{bill.locations?.name ?? "—"}</p>
              {bill.landlord_bill_number && (
                <p className="text-muted-foreground text-xs">Bill ref: {bill.landlord_bill_number}</p>
              )}
              {bill.landlord_bill_date && (
                <p className="text-muted-foreground text-xs">Dated: {formatDate(bill.landlord_bill_date)}</p>
              )}
            </div>
            <Badge className={STATUS_COLORS[bill.status] ?? ""}>
              {bill.status.charAt(0).toUpperCase() + bill.status.slice(1)}
            </Badge>
          </div>

          {/* Lines */}
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium hidden sm:table-cell">Label</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Rate</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {bill.electricity_bill_lines.map((l, i) => (
                  <tr key={l.id ?? i} className="border-b last:border-0">
                    <td className="px-3 py-2 text-muted-foreground">
                      {LINE_TYPE_LABELS[l.line_type] ?? l.line_type}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs hidden sm:table-cell">
                      {l.meter_label || l.label || "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {l.units != null ? l.units.toLocaleString("en-IN") : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {l.rate != null ? `₹${l.rate}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {formatCurrency(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {/* Landlord side */}
            <div className="bg-orange-50/60 border border-orange-200 rounded-lg p-3 space-y-1.5">
              <p className="text-xs font-semibold text-orange-800 uppercase tracking-wide">Landlord Bill</p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold">{formatCurrency(bill.landlord_total_amount)}</span>
              </div>
              {bill.vendor_bill_id ? (
                <p className="text-xs text-green-700">✓ Vendor bill created</p>
              ) : (
                <p className="text-xs text-amber-600">⚠ No vendor bill (create manually)</p>
              )}
            </div>

            {/* Customer side */}
            {bill.reimbursement_enabled && bill.customer_total != null ? (
              <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-3 space-y-1.5">
                <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Customer Statement</p>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(bill.customer_subtotal ?? 0)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground text-xs">
                  <span>CGST + SGST</span>
                  <span>{formatCurrency((bill.customer_cgst ?? 0) + (bill.customer_sgst ?? 0))}</span>
                </div>
                {(bill.customer_round_off ?? 0) !== 0 && (
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>Round-off</span>
                    <span>{(bill.customer_round_off ?? 0) > 0 ? "+" : ""}{formatCurrency(bill.customer_round_off ?? 0)}</span>
                  </div>
                )}
                <Separator className="my-1" />
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span>{formatCurrency(bill.customer_total)}</span>
                </div>
              </div>
            ) : (
              <div className="bg-muted/40 border rounded-lg p-3 flex items-center justify-center">
                <p className="text-xs text-muted-foreground">Vendor bill only — no customer statement</p>
              </div>
            )}
          </div>

          {/* Audit trail */}
          <div className="text-xs text-muted-foreground space-y-0.5 border-t pt-3">
            <p>Captured by <span className="font-medium">{bill.created_by_user?.full_name ?? "—"}</span> on {formatDate(bill.created_at)}</p>
            {bill.confirmed_by_user && bill.confirmed_at && (
              <p>Confirmed by <span className="font-medium">{bill.confirmed_by_user.full_name}</span> on {formatDate(bill.confirmed_at)}</p>
            )}
          </div>

          {/* Maker-checker warning */}
          {bill.status === "draft" && isMaker && (
            <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded px-3 py-2 text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              You created this bill. Another admin or manager must confirm it (maker-checker rule).
            </div>
          )}
          {bill.status === "draft" && !isMaker && !canConfirm && (
            <div className="flex items-start gap-2 text-xs bg-muted/50 border rounded px-3 py-2 text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Only admin or manager can confirm bills.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            Close
          </Button>
          {canConfirm && (
            <Button onClick={handleConfirm} disabled={confirming}>
              <CheckCircle className="mr-1.5 h-4 w-4" />
              {confirming ? "Confirming…" : "Confirm Bill"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
