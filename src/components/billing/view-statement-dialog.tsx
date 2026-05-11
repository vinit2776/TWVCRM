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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Skeleton } from "@/components/shared/loading-skeleton";
import { Loader2, CheckCircle, Upload, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";

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

interface ServiceCharge {
  id: string;
  service_name: string;
  quantity_used: number;
  quota: number;
  overage: number;
  rate: number;
  amount: number;
}

interface BookingCharge {
  id: string;
  booking_number: string;
  date: string;
  space: string;
  time: string;
  duration: string;
  amount: number;
  is_free: boolean;
}

interface Statement {
  id: string;
  statement_number: string;
  status: string;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  service_usage_amount?: number;
  booking_usage_amount?: number;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  prepaid_month?: number;
  prepaid_year?: number;
  // Lifecycle fields
  emailed_at?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_status?: string | null;
  accounted?: boolean | null;
  finalized_at?: string | null;
  gst_invoice_number?: string | null;
  notes?: string;
  contract?: { id: string; contract_number: string; title?: string } | null;
  booking?: { id: string; booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string } | null;
  usage_charges?: UsageCharge[];
  facility_charges?: FacilityCharge[];
  service_charges?: ServiceCharge[];
  booking_charges?: BookingCharge[];
}


const ADD_CHARGE_ROLES = ["admin", "manager", "accounts"];

interface ViewStatementDialogProps {
  statementId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: () => void;
  /** Current user's role — drives visibility of "Add charge" on draft statements */
  userRole?: string | null;
}

export function ViewStatementDialog({
  statementId,
  open,
  onOpenChange,
  onStatusChange,
  userRole,
}: ViewStatementDialogProps) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(false);

  // ── Inline "Add charge" form state ────────────────────────────────
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [addingCharge, setAddingCharge] = useState(false);
  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeQty, setChargeQty] = useState<number>(1);
  const [chargePrice, setChargePrice] = useState<number>(0);
  // GST rate is locked to the statement's tax_percentage for consistency
  const chargeGstRate = Number(statement?.tax_percentage ?? 18);
  const [chargeDate, setChargeDate] = useState(
    new Date().toISOString().split("T")[0]
  );

  const chargeSubtotal = chargeQty * chargePrice;
  const chargeGstAmt = parseFloat((chargeSubtotal * chargeGstRate / 100).toFixed(2));
  const chargeTotal = parseFloat((chargeSubtotal + chargeGstAmt).toFixed(2));

  const canAddCharge =
    statement?.status === "draft" &&
    !!userRole &&
    ADD_CHARGE_ROLES.includes(userRole);

  const resetChargeForm = () => {
    setChargeDesc("");
    setChargeQty(1);
    setChargePrice(0);
    setChargeDate(new Date().toISOString().split("T")[0]);
    setShowAddCharge(false);
  };

  const handleAddCharge = async () => {
    if (!statementId) return;
    if (!chargeDesc.trim()) { toast.error("Description is required"); return; }
    if (chargeQty <= 0) { toast.error("Quantity must be positive"); return; }
    if (chargePrice <= 0) { toast.error("Unit price must be positive"); return; }

    setAddingCharge(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/add-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: chargeDesc.trim(),
          quantity: chargeQty,
          unit_price: chargePrice,
          gst_rate: chargeGstRate,
          charge_date: chargeDate,
        }),
      });
      if (res.ok) {
        toast.success("Charge added to statement");
        resetChargeForm();
        onStatusChange(); // refresh parent list
        // Refresh statement in-place so totals update
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const json = await refreshed.json();
          setStatement(json.data || null);
        }
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to add charge");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setAddingCharge(false);
    }
  };

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
                <p className="text-muted-foreground text-xs mb-0.5">Lifecycle</p>
                <BillingLifecycleStatus
                  status={statement.status}
                  emailed_at={statement.emailed_at}
                  razorpay_payment_link_url={statement.razorpay_payment_link_url}
                  payment_status={statement.payment_status}
                  accounted={statement.accounted}
                  finalized_at={statement.finalized_at}
                  gst_invoice_number={statement.gst_invoice_number}
                  variant="full"
                />
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
              const hasPrepaid = statement.prepaid_month && statement.fixed_amount > 0;
              const prepaidLabel = hasPrepaid
                ? `Prepaid Rent — ${new Date(statement.prepaid_year || 0, (statement.prepaid_month || 1) - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`
                : statement.contract ? "Monthly Membership Fee" : "Booking Amount";

              const bookingAmt = Number(statement.booking_usage_amount || 0);
              const usageAmt = Number(statement.usage_amount || 0);
              const serviceAmt = Number(statement.service_usage_amount || 0);

              return (
                <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{prepaidLabel}</span>
                    <span>{formatCurrency(statement.fixed_amount)}</span>
                  </div>
                  {bookingAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Meeting Room Usage ({statement.booking_charges?.length || 0} booking{(statement.booking_charges?.length || 0) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(bookingAmt)}</span>
                    </div>
                  )}
                  {usageAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Additional Charges ({(statement.usage_charges?.length ?? 0) + (statement.facility_charges?.length ?? 0)} item{((statement.usage_charges?.length ?? 0) + (statement.facility_charges?.length ?? 0)) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(usageAmt)}</span>
                    </div>
                  )}
                  {serviceAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Service Usage ({statement.service_charges?.length || 0} service{(statement.service_charges?.length || 0) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(serviceAmt)}</span>
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

            {/* Booking charges table (auto-rolled contract bookings) */}
            {(statement.booking_charges?.length ?? 0) > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Meeting Room Bookings</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Booking</th>
                        <th className="px-3 py-2 text-left font-medium">Space</th>
                        <th className="px-3 py-2 text-left font-medium">Time</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(statement.booking_charges ?? []).map((bc) => (
                        <tr key={bc.id} className={`border-b last:border-0${bc.is_free ? " bg-green-50/30" : ""}`}>
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs">{bc.booking_number}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(bc.date)}</div>
                          </td>
                          <td className="px-3 py-2">{bc.space}</td>
                          <td className="px-3 py-2">
                            <div>{bc.time}</div>
                            <div className="text-xs text-muted-foreground">{bc.duration}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {bc.is_free ? (
                              <span className="text-green-700 text-xs">Free quota</span>
                            ) : (
                              formatCurrency(bc.amount)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Usage charges table (ad-hoc + facility) */}
            {((statement.usage_charges?.length ?? 0) > 0 || (statement.facility_charges?.length ?? 0) > 0) && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Ad-hoc & Facility Charges</h4>
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

            {/* Service charges table (printer/service overages) */}
            {(statement.service_charges?.length ?? 0) > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Service Usage</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Service</th>
                        <th className="px-3 py-2 text-right font-medium">Used</th>
                        <th className="px-3 py-2 text-right font-medium">Quota</th>
                        <th className="px-3 py-2 text-right font-medium">Overage</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(statement.service_charges ?? []).map((sc) => (
                        <tr key={sc.id} className="border-b last:border-0 bg-purple-50/30">
                          <td className="px-3 py-2 font-medium">{sc.service_name}</td>
                          <td className="px-3 py-2 text-right">{sc.quantity_used}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{sc.quota}</td>
                          <td className="px-3 py-2 text-right">
                            {sc.overage > 0 ? (
                              <span>{sc.overage} × {formatCurrency(sc.rate)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(sc.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Add charge (draft only, role-gated) ─────────────── */}
            {canAddCharge && !showAddCharge && (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={() => setShowAddCharge(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Charge
              </Button>
            )}

            {canAddCharge && showAddCharge && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">New Charge</h4>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={resetChargeForm}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="stmt-charge-desc" className="text-xs">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="stmt-charge-desc"
                    value={chargeDesc}
                    onChange={(e) => setChargeDesc(e.target.value)}
                    placeholder="e.g., Cafeteria charges, Overtime, Damage..."
                    className="h-8 text-sm"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-qty" className="text-xs">Qty</Label>
                    <Input
                      id="stmt-charge-qty"
                      type="number"
                      min={0.01}
                      step="any"
                      value={chargeQty}
                      onChange={(e) => setChargeQty(parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-price" className="text-xs">Unit Price</Label>
                    <Input
                      id="stmt-charge-price"
                      type="number"
                      min={0.01}
                      step="any"
                      value={chargePrice}
                      onChange={(e) => setChargePrice(parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">GST %</Label>
                    <div className="rounded-md border bg-muted px-2.5 py-1.5 text-sm tabular-nums">
                      {chargeGstRate}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-date" className="text-xs">Charge Date</Label>
                    <Input
                      id="stmt-charge-date"
                      type="date"
                      value={chargeDate}
                      onChange={(e) => setChargeDate(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Total (incl. GST)</Label>
                    <div className="rounded-md border bg-background px-2.5 py-1.5 text-sm font-semibold">
                      {formatCurrency(chargeTotal)}
                      {chargeGstAmt > 0 && (
                        <span className="text-xs text-muted-foreground font-normal ml-1">
                          ({formatCurrency(chargeSubtotal)} + {formatCurrency(chargeGstAmt)} GST)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={handleAddCharge}
                  disabled={addingCharge || !chargeDesc.trim() || chargeQty <= 0 || chargePrice <= 0}
                  className="w-full"
                >
                  {addingCharge ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add to Statement
                </Button>
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
