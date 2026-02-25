"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft, CheckCircle, XCircle, RefreshCcw, Loader2,
  Building2, MapPin, User, Calendar, FileText, PackageOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  PR_STATUS_LABELS, PR_STATUS_COLORS,
  PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
  PROCUREMENT_APPROVAL_THRESHOLDS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PurchaseRequest } from "@/types";

type ActionType = "approve" | "reject" | "cancel" | "submit" | "resubmit";

export default function PurchaseRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [pr, setPr] = useState<PurchaseRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog state
  const [actionDialog, setActionDialog] = useState<ActionType | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const fetchPr = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/requests/${id}`);
    if (res.ok) {
      const json = await res.json();
      setPr(json.data);
    } else {
      toast.error("Failed to load purchase request");
      router.push("/procurement/requests");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchPr(); }, [fetchPr]);

  const performAction = async (action: ActionType, extra?: Record<string, string>) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/procurement/requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Action failed");
        return;
      }
      const successMessages: Record<ActionType, string> = {
        submit: "Request submitted for approval",
        approve: "Request approved",
        reject: "Request rejected",
        cancel: "Request cancelled",
        resubmit: "Request resubmitted",
      };
      toast.success(successMessages[action]);
      setActionDialog(null);
      setRejectionReason("");
      await fetchPr();
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = () => {
    if (!rejectionReason.trim()) {
      toast.error("Please provide a rejection reason");
      return;
    }
    performAction("reject", { rejection_reason: rejectionReason.trim() });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!pr) return null;

  const isLargeAmount = pr.total_estimated_amount > PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/requests")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{pr.pr_number}</h1>
              <Badge variant="secondary" className={PR_STATUS_COLORS[pr.status]}>
                {PR_STATUS_LABELS[pr.status]}
              </Badge>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className={PROCUREMENT_DEPARTMENT_COLORS[pr.department]}>
                {PROCUREMENT_DEPARTMENT_LABELS[pr.department]}
              </Badge>
              {isLargeAmount && pr.status === "submitted" && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs">
                  Requires admin approval
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap justify-end">
          {pr.status === "draft" && (
            <Button
              size="sm"
              onClick={() => performAction("submit")}
              disabled={actionLoading}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Submit for Approval
            </Button>
          )}
          {pr.status === "submitted" && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700"
                onClick={() => setActionDialog("approve")}
                disabled={actionLoading}
              >
                <CheckCircle className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => setActionDialog("reject")}
                disabled={actionLoading}
              >
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
            </>
          )}
          {pr.status === "rejected" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => performAction("resubmit")}
              disabled={actionLoading}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCcw className="h-4 w-4 mr-1" />}
              Resubmit
            </Button>
          )}
          {["draft", "submitted"].includes(pr.status) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => setActionDialog("cancel")}
              disabled={actionLoading}
            >
              Cancel Request
            </Button>
          )}
        </div>
      </div>

      {/* Rejection reason callout */}
      {pr.status === "rejected" && pr.rejection_reason && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="pt-4 flex gap-3">
            <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">Rejection Reason</p>
              <p className="text-sm text-red-700 mt-0.5">{pr.rejection_reason}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Approval callout */}
      {pr.status === "approved" && pr.approver && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="pt-4 flex gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-green-800">Approved</p>
              <p className="text-sm text-green-700 mt-0.5">
                By {pr.approver.full_name ?? pr.approver.email}
                {pr.approved_at ? ` on ${formatDate(pr.approved_at)}` : ""}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Request Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Department: </span>
                {PROCUREMENT_DEPARTMENT_LABELS[pr.department]}
              </span>
            </div>
            {pr.locations && (
              <div className="flex items-center gap-2.5">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Location: </span>
                  {pr.locations.name}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5">
              <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Requested by: </span>
                {pr.requester?.full_name ?? pr.requester?.email ?? "—"}
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Created: </span>
                {formatDate(pr.created_at)}
              </span>
            </div>
            {pr.notes && (
              <div className="flex items-start gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Notes: </span>
                  {pr.notes}
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
              <span className="text-sm text-muted-foreground">Total Estimated</span>
              <span className="text-xl font-bold">
                {pr.total_estimated_amount > 0 ? formatCurrency(pr.total_estimated_amount) : "—"}
              </span>
            </div>
            {isLargeAmount && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                Amount exceeds ₹{PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE.toLocaleString()} — admin approval required
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Line items</span>
              <span>{pr.purchase_request_items?.length ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <PackageOpen className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Items Requested</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {!pr.purchase_request_items?.length ? (
            <p className="text-sm text-muted-foreground">No items</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2.5 text-left font-medium">#</th>
                    <th className="px-3 py-2.5 text-left font-medium">Item</th>
                    <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-2.5 text-left font-medium">Unit</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Est. Price</th>
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pr.purchase_request_items.map((item, idx) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 text-muted-foreground">{idx + 1}</td>
                      <td className="px-3 py-2.5">
                        <div>
                          <p className="font-medium">{item.item_name}</p>
                          {item.notes && (
                            <p className="text-xs text-muted-foreground mt-0.5">{item.notes}</p>
                          )}
                          {item.procurement_items && (
                            <Badge variant="secondary" className="text-xs mt-0.5 bg-blue-50 text-blue-700">
                              Catalog
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">{item.quantity}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{item.unit}</td>
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                        {item.estimated_price ? formatCurrency(item.estimated_price) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                        {item.total_estimated ? formatCurrency(item.total_estimated) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {pr.total_estimated_amount > 0 && (
                  <tfoot>
                    <tr className="bg-muted/30">
                      <td colSpan={4} className="px-3 py-2.5 text-sm font-medium text-right hidden sm:table-cell">
                        Total
                      </td>
                      <td colSpan={2} className="px-3 py-2.5 text-sm font-bold text-right hidden sm:table-cell">
                        {formatCurrency(pr.total_estimated_amount)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approve confirm dialog */}
      <Dialog open={actionDialog === "approve"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Purchase Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              You are about to approve <strong>{pr.pr_number}</strong> for{" "}
              <strong>{formatCurrency(pr.total_estimated_amount)}</strong>.
            </p>
            {isLargeAmount && (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                This amount exceeds ₹{PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE.toLocaleString()}. Only admin users can approve this.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => performAction("approve")}
              disabled={actionLoading}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle className="h-4 w-4 mr-1" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={actionDialog === "reject"} onOpenChange={() => { setActionDialog(null); setRejectionReason(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Purchase Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Provide a reason for rejecting <strong>{pr.pr_number}</strong>.
            </p>
            <div className="space-y-1.5">
              <Label>Rejection Reason <span className="text-red-500">*</span></Label>
              <Textarea
                placeholder="e.g. Budget exceeded, please adjust quantities..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setRejectionReason(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={actionLoading || !rejectionReason.trim()}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <XCircle className="h-4 w-4 mr-1" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirm dialog */}
      <Dialog open={actionDialog === "cancel"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Purchase Request</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Are you sure you want to cancel <strong>{pr.pr_number}</strong>? This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Keep Request</Button>
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
