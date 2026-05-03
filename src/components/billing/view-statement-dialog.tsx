"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { Loader2, CheckCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date: string;
  status: string;
}

interface FacilityCharge {
  id: string;
  name: string;
  unit: string;
  quantity_used: number;
  free_quota_applied: number;
  billable_quantity: number;
  unit_price: number;
  total_charge: number;
}

interface Statement {
  id: string;
  statement_number: string;
  status: string;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  notes?: string;
  contract?: { id: string; contract_number: string; title?: string } | null;
  booking?: { id: string; booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  usage_charges?: UsageCharge[];
  facility_charges?: FacilityCharge[];
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  finalized: "bg-blue-100 text-blue-800",
  exported: "bg-green-100 text-green-800",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
};

interface ViewStatementDialogProps {
  statementId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: () => void;
}

export function ViewStatementDialog({
  statementId,
  open,
  onOpenChange,
  onStatusChange,
}: ViewStatementDialogProps) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(false);

  useEffect(() => {
    if (!open || !statementId) {
      setStatement(null);
      return;
    }
    setLoading(true);
    fetch(`/api/billing-statements/${statementId}`)
      .then((res) => res.json())
      .then((json) => setStatement(json.data || null))
      .catch(() => toast.error("Failed to load statement"))
      .finally(() => setLoading(false));
  }, [open, statementId]);

  const handleStatusTransition = async (newStatus: "finalized" | "exported") => {
    if (!statementId) return;
    setActioning(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        toast.success(newStatus === "finalized" ? "Statement finalized" : "Statement exported");
        onStatusChange();
        // Refresh statement in dialog
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const json = await refreshed.json();
          setStatement(json.data || null);
        }
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to ${newStatus === "finalized" ? "finalize" : "export"} statement`);
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setActioning(false);
    }
  };

  const customerName = statement?.lead
    ? statement.lead.company || `${statement.lead.first_name} ${statement.lead.last_name}`
    : statement?.booking?.guest_name || null;

  const reference = statement?.contract?.contract_number
    ? `Contract ${statement.contract.contract_number}`
    : statement?.booking?.booking_number
    ? `Booking ${statement.booking.booking_number}`
    : "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {loading ? "Loading..." : statement ? `Statement ${statement.statement_number}` : "Statement"}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3 py-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : statement ? (
          <div className="space-y-5">
            {/* Header info */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Status</p>
                <Badge
                  variant="secondary"
                  className={STATUS_COLORS[statement.status] || ""}
                >
                  {STATUS_LABELS[statement.status] || statement.status}
                </Badge>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Reference</p>
                <p className="font-mono font-medium">{reference}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Customer</p>
                <p className="font-medium">{customerName || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Billing Period</p>
                <p>{formatDate(statement.period_start)} – {formatDate(statement.period_end)}</p>
              </div>
            </div>

            {/* Amounts summary */}
            {(() => {
              const usageCount = statement.usage_charges?.length ?? 0;
              const facilityCount = statement.facility_charges?.length ?? 0;
              const totalLineItems = usageCount + facilityCount;
              return (
                <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {statement.contract ? "Monthly Membership Fee" : "Booking Amount"}
                    </span>
                    <span>{formatCurrency(statement.fixed_amount)}</span>
                  </div>
                  {totalLineItems > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Additional Charges ({totalLineItems} item{totalLineItems !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(statement.usage_amount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-2">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatCurrency(statement.subtotal)}</span>
                  </div>
                  {statement.tax_percentage > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">GST ({statement.tax_percentage}%)</span>
                      <span>{formatCurrency(statement.tax_amount)}</span>
                    </div>
                  )}
                  <div className="border-t pt-2 flex justify-between font-semibold">
                    <span>Total</span>
                    <span>{formatCurrency(statement.total_amount)}</span>
                  </div>
                </div>
              );
            })()}

            {/* Usage charges table */}
            {((statement.usage_charges?.length ?? 0) > 0 || (statement.facility_charges?.length ?? 0) > 0) && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Charge Breakdown</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                        <th className="px-3 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Usage charges (manual or ad-hoc) */}
                      {(statement.usage_charges ?? []).map((charge) => (
                        <tr key={charge.id} className="border-b last:border-0">
                          <td className="px-3 py-2">
                            <div className="font-medium">{charge.description}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(charge.charge_date)}</div>
                          </td>
                          <td className="px-3 py-2 text-right">{charge.quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(charge.unit_price)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(charge.total)}</td>
                        </tr>
                      ))}
                      {/* Facility usage overages (conference rooms, printing, etc.) */}
                      {(statement.facility_charges ?? []).map((fc) => (
                        <tr key={fc.id} className="border-b last:border-0 bg-blue-50/30">
                          <td className="px-3 py-2">
                            <div className="font-medium">{fc.name} — Overage</div>
                            <div className="text-xs text-muted-foreground">
                              {fc.quantity_used} {fc.unit} used · {fc.free_quota_applied} free · {fc.billable_quantity} chargeable
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">{fc.billable_quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(fc.unit_price)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(fc.total_charge)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Notes */}
            {statement.notes && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{statement.notes}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">Statement not found.</p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {statement?.status === "draft" && (
            <Button
              onClick={() => handleStatusTransition("finalized")}
              disabled={actioning}
            >
              {actioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
              Finalize
            </Button>
          )}
          {statement?.status === "finalized" && (
            <Button
              onClick={() => handleStatusTransition("exported")}
              disabled={actioning}
            >
              {actioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Export
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
