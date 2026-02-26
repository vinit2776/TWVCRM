"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, Loader2, Truck, MapPin, User, Calendar,
  FileText, PackageOpen, Receipt, Download, CreditCard,
} from "lucide-react";
import { generatePurchaseOrderPDF } from "@/lib/po-pdf-generator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  PO_STATUS_LABELS, PO_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PurchaseOrder } from "@/types";

type ActionType = "mark_ordered" | "mark_received" | "cancel";

export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const [actionDialog, setActionDialog] = useState<ActionType | null>(null);
  const [actualDeliveryDate, setActualDeliveryDate] = useState("");

  const today = new Date().toISOString().split("T")[0];

  const fetchPo = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/orders/${id}`);
    if (res.ok) {
      const json = await res.json();
      setPo(json.data);
    } else {
      toast.error("Failed to load purchase order");
      router.push("/procurement/orders");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchPo(); }, [fetchPo]);

  const performAction = async (action: ActionType, extra?: Record<string, string | null>) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/procurement/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Action failed");
        return;
      }
      const msgs: Record<ActionType, string> = {
        mark_ordered: "Order marked as ordered",
        mark_received: "Order marked as received",
        cancel: "Order cancelled",
      };
      toast.success(msgs[action]);
      setActionDialog(null);
      setActualDeliveryDate("");
      await fetchPo();
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!po) return null;

  const vendor = po.procurement_vendors as { id: string; name: string; contact_name?: string; contact_phone?: string; contact_email?: string } | null;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/orders")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{po.po_number}</h1>
              <Badge variant="secondary" className={PO_STATUS_COLORS[po.status]}>
                {PO_STATUS_LABELS[po.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {vendor?.name ?? "Unknown vendor"}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap justify-end">
          {po.status !== "cancelled" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const pdf = generatePurchaseOrderPDF(po as Parameters<typeof generatePurchaseOrderPDF>[0]);
                pdf.save(`${po.po_number}.pdf`);
              }}
            >
              <Download className="h-4 w-4 mr-1" /> Download PO
            </Button>
          )}
          {po.status === "pending" && (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => setActionDialog("mark_ordered")}
              disabled={actionLoading}
            >
              Mark as Ordered
            </Button>
          )}
          {po.status === "ordered" && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700"
              onClick={() => { setActualDeliveryDate(today); setActionDialog("mark_received"); }}
              disabled={actionLoading}
            >
              Mark as Received
            </Button>
          )}
          {!["cancelled", "invoice_received"].includes(po.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/procurement/bills/new?po_id=${po.id}`)}
            >
              <Receipt className="h-4 w-4 mr-1" /> Vendor Invoice
            </Button>
          )}
          {["pending", "ordered"].includes(po.status) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setActionDialog("cancel")}
              disabled={actionLoading}
            >
              Cancel Order
            </Button>
          )}
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Order Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Truck className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Vendor: </span>
                <span className="font-medium">{vendor?.name ?? "—"}</span>
              </span>
            </div>
            {vendor?.contact_name && (
              <div className="flex items-center gap-2.5 pl-[26px]">
                <span className="text-xs text-muted-foreground">
                  {vendor.contact_name}
                  {vendor.contact_phone ? ` · ${vendor.contact_phone}` : ""}
                </span>
              </div>
            )}
            {po.locations && (
              <div className="flex items-center gap-2.5">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Location: </span>
                  {po.locations.name}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5">
              <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Ordered by: </span>
                {po.orderer?.full_name ?? po.orderer?.email ?? "—"}
              </span>
            </div>
            {po.expected_delivery_date && (
              <div className="flex items-center gap-2.5">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Expected delivery: </span>
                  {formatDate(po.expected_delivery_date)}
                </span>
              </div>
            )}
            {po.actual_delivery_date && (
              <div className="flex items-center gap-2.5">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Actual delivery: </span>
                  {formatDate(po.actual_delivery_date)}
                </span>
              </div>
            )}
            {po.purchase_requests && (
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Source PR: </span>
                  <Link
                    href={`/procurement/requests/${po.purchase_requests.id}`}
                    className="text-primary hover:underline font-mono"
                  >
                    {po.purchase_requests.pr_number}
                  </Link>
                </span>
              </div>
            )}
            {po.notes && (
              <div className="flex items-start gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Notes: </span>
                  {po.notes}
                </span>
              </div>
            )}
            {po.payment_terms && (
              <div className="flex items-start gap-2.5">
                <CreditCard className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Payment Terms: </span>
                  {po.payment_terms}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Amount Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total Ordered</span>
              <span className="text-xl font-bold">
                {po.total_ordered_amount > 0 ? formatCurrency(po.total_ordered_amount) : "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Line items</span>
              <span>{po.purchase_order_items?.length ?? 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Created</span>
              <span>{formatDate(po.created_at)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Terms & Conditions */}
      {po.terms_and_conditions && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Terms &amp; Conditions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{po.terms_and_conditions}</p>
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <PackageOpen className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Order Items</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {!po.purchase_order_items?.length ? (
            <p className="text-sm text-muted-foreground">No items</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2.5 text-left font-medium">#</th>
                    <th className="px-3 py-2.5 text-left font-medium">Item</th>
                    <th className="px-3 py-2.5 text-right font-medium">Qty Ordered</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Qty Received</th>
                    <th className="px-3 py-2.5 text-left font-medium">Unit</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Unit Price</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {po.purchase_order_items.map((item, idx) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 text-muted-foreground">{idx + 1}</td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{item.item_name}</p>
                        {item.procurement_items?.description && (
                          <p className="text-xs text-blue-600 mt-0.5 italic">
                            {item.procurement_items.description}
                          </p>
                        )}
                        {item.notes && (
                          <p className="text-xs text-muted-foreground mt-0.5">{item.notes}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">{item.quantity_ordered}</td>
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell text-muted-foreground">
                        {item.quantity_received ?? 0}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{item.unit}</td>
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                        {item.unit_price ? formatCurrency(item.unit_price) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                        {item.total_amount ? formatCurrency(item.total_amount) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Mark as Ordered dialog */}
      <Dialog open={actionDialog === "mark_ordered"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Ordered</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Confirm that <strong>{po.po_number}</strong> has been sent to the vendor and is now in progress.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => performAction("mark_ordered")}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Mark as Ordered
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark as Received dialog */}
      <Dialog open={actionDialog === "mark_received"} onOpenChange={() => { setActionDialog(null); setActualDeliveryDate(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Received</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Confirm that items for <strong>{po.po_number}</strong> have been received.
            </p>
            <div className="space-y-1.5">
              <Label>Actual Delivery Date</Label>
              <Input
                type="date"
                value={actualDeliveryDate}
                onChange={(e) => setActualDeliveryDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setActualDeliveryDate(""); }}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => performAction("mark_received", { actual_delivery_date: actualDeliveryDate || null })}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Mark as Received
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={actionDialog === "cancel"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Purchase Order</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to cancel <strong>{po.po_number}</strong>? This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Keep Order</Button>
            <Button
              variant="destructive"
              onClick={() => performAction("cancel")}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Yes, Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
