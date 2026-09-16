"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";

interface DetailCharge {
  id: string;
  description: string;
  contract?: { contract_number: string } | null;
  booking?: { booking_number: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  quantity: number;
  unit_price: number;
  total: number;
  gst_rate?: number;
  gst_amount?: number;
  total_with_gst?: number;
  charge_date: string;
  status: string;
  notes?: string;
  source?: "manual" | "print" | "facility";
  billing_cycle_label?: string;
  waive_reason?: string | null;
  waived_at?: string | null;
  waived_by_name?: string | null;
}

interface UsageChargeDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  charge: DetailCharge | null;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{value}</div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = { pending: "Pending", billed: "Billed", waived: "Waived" };
const SOURCE_LABELS: Record<string, string> = { manual: "Manual charge", print: "Print log", facility: "Facility usage" };

export function UsageChargeDetailsDialog({ open, onOpenChange, charge }: UsageChargeDetailsDialogProps) {
  if (!charge) return null;

  const customerName = charge.lead?.company || `${charge.lead?.first_name ?? ""} ${charge.lead?.last_name ?? ""}`.trim() || "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Charge Details</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Description" value={charge.description} />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Customer" value={customerName} />
            <Field label="Source" value={SOURCE_LABELS[charge.source ?? "manual"]} />
          </div>

          {(charge.contract?.contract_number || charge.booking?.booking_number) && (
            <div className="grid grid-cols-2 gap-4">
              {charge.contract?.contract_number && <Field label="Contract" value={charge.contract.contract_number} />}
              {charge.booking?.booking_number && <Field label="Booking" value={charge.booking.booking_number} />}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 rounded-md border bg-muted/30 p-3">
            <Field label="Quantity" value={charge.quantity} />
            <Field label="Unit Price" value={formatCurrency(charge.unit_price)} />
            <Field label="Subtotal" value={formatCurrency(charge.total)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="GST"
              value={charge.gst_rate ? `${formatCurrency(charge.gst_amount || 0)} (${charge.gst_rate}%)` : "—"}
            />
            <Field label="Total (incl. GST)" value={<span className="font-semibold">{formatCurrency(charge.total_with_gst ?? charge.total)}</span>} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Charge Date" value={formatDate(charge.charge_date)} />
            <Field label="Billing Period" value={charge.billing_cycle_label || "—"} />
          </div>

          <Field
            label="Status"
            value={<Badge variant="secondary">{STATUS_LABELS[charge.status] || charge.status}</Badge>}
          />

          {charge.status === "waived" && (
            <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
              <Field label="Waived By" value={charge.waived_by_name || "—"} />
              <Field label="Waived At" value={charge.waived_at ? formatDateTime(charge.waived_at) : "—"} />
              <Field label="Waive Reason" value={charge.waive_reason || "—"} />
            </div>
          )}

          {charge.notes && <Field label="Notes" value={<span className="whitespace-pre-wrap">{charge.notes}</span>} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
