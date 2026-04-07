"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft, Loader2, ArrowRight, MapPin, User, Calendar,
  FileText, Download, CheckCircle2, XCircle, Truck, PackageCheck,
  AlertTriangle,
} from "lucide-react";
import { generateTransferChallanPDF } from "@/lib/transfer-challan-pdf";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  TRANSFER_STATUS_LABELS, TRANSFER_STATUS_COLORS,
  TRANSFER_ISSUE_TYPE_LABELS, TRANSFER_ISSUE_TYPES,
  TRANSFER_ISSUE_STATUS_LABELS, TRANSFER_ISSUE_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import type { StockTransfer, StockTransferItem, StockTransferIssue } from "@/types";

interface StockLevel {
  item_id: string;
  location_id: string;
  quantity_on_hand: number;
}

interface UserInfo {
  role: string;
}

// ─── Receive Dialog types ─────────────────────────────────────────────────
interface ReceiveLineItem {
  transfer_item_id: string;
  item_name: string;
  unit: string;
  quantity_sent: number;
  quantity_received: string;
  has_issue: boolean;
  issue_type: string;
  issue_description: string;
}

export default function TransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [transfer, setTransfer] = useState<StockTransfer | null>(null);
  const [stockLevels, setStockLevels] = useState<StockLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [userRole, setUserRole] = useState("");

  // Dialog states
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveItems, setReceiveItems] = useState<ReceiveLineItem[]>([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveIssueId, setResolveIssueId] = useState("");
  const [resolveNotes, setResolveNotes] = useState("");
  const [resolveAdjustStock, setResolveAdjustStock] = useState(false);

  const fetchTransfer = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/transfers/${id}`);
    if (res.ok) {
      const json = await res.json();
      setTransfer(json.data);
      setStockLevels(json.stock_levels || []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);

  // Fetch user role
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => {
        if (json.data?.role) setUserRole(json.data.role);
        else if (json.role) setUserRole(json.role);
      });
  }, []);

  // ─── Action handlers ────────────────────────────────────────────────────

  const handleAction = async (action: string, body?: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/procurement/transfers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Action failed");
        return false;
      }
      toast.success(`Transfer ${action.replace(/_/g, " ")} successfully`);
      await fetchTransfer();
      return true;
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitForApproval = () => handleAction("submit");

  const handleApprove = () => handleAction("approve");

  const handleReject = async () => {
    if (!rejectNotes.trim()) { toast.error("Rejection notes are required"); return; }
    const ok = await handleAction("reject", { notes: rejectNotes.trim() });
    if (ok) { setRejectOpen(false); setRejectNotes(""); }
  };

  const handleDispatch = () => handleAction("dispatch");

  const handleDownloadChallan = () => {
    if (!transfer) return;
    const pdf = generateTransferChallanPDF(transfer);
    pdf.save(`challan-${transfer.transfer_number}.pdf`);
  };

  // ── Receive flow ──────────────────────────────────────────────────────────

  const openReceiveDialog = () => {
    if (!transfer?.stock_transfer_items) return;
    setReceiveItems(
      transfer.stock_transfer_items.map((item) => ({
        transfer_item_id: item.id,
        item_name: item.item_name,
        unit: item.unit,
        quantity_sent: item.quantity_sent,
        quantity_received: String(item.quantity_sent),
        has_issue: false,
        issue_type: "shortage",
        issue_description: "",
      }))
    );
    setReceiveOpen(true);
  };

  const updateReceiveItem = (idx: number, field: keyof ReceiveLineItem, value: string | boolean) => {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const handleReceive = async () => {
    // Build receive payload
    const receivePayload = {
      items: receiveItems.map((ri) => ({
        transfer_item_id: ri.transfer_item_id,
        quantity_received: parseFloat(ri.quantity_received) || 0,
      })),
    };

    setActionLoading(true);
    try {
      const res = await fetch(`/api/procurement/transfers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "receive", ...receivePayload }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to receive transfer");
        return;
      }
      toast.success("Transfer received");

      // Report issues if any
      const issueItems = receiveItems.filter((ri) => ri.has_issue && ri.issue_type);
      if (issueItems.length > 0) {
        const issuePayload = {
          action: "report_issue",
          items: issueItems.map((ri) => ({
            transfer_item_id: ri.transfer_item_id,
            issue_type: ri.issue_type,
            reported_quantity: parseFloat(ri.quantity_received) || 0,
            expected_quantity: ri.quantity_sent,
            description: ri.issue_description || undefined,
          })),
        };

        const issueRes = await fetch(`/api/procurement/transfers/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(issuePayload),
        });
        if (issueRes.ok) {
          toast.success("Issues reported");
        } else {
          const issueJson = await issueRes.json();
          toast.error(typeof issueJson.error === "string" ? issueJson.error : "Failed to report issues");
        }
      }

      setReceiveOpen(false);
      await fetchTransfer();
    } finally {
      setActionLoading(false);
    }
  };

  // ── Resolve issue ─────────────────────────────────────────────────────────

  const openResolveDialog = (issueId: string) => {
    setResolveIssueId(issueId);
    setResolveNotes("");
    setResolveAdjustStock(false);
    setResolveOpen(true);
  };

  const handleResolveIssue = async () => {
    if (!resolveNotes.trim()) { toast.error("Resolution notes are required"); return; }
    const ok = await handleAction("resolve_issue", {
      issue_id: resolveIssueId,
      resolution_notes: resolveNotes.trim(),
      adjust_stock: resolveAdjustStock,
    });
    if (ok) { setResolveOpen(false); }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────

  const getStockForItem = (itemId: string | undefined, locationId: string): number | null => {
    if (!itemId) return null;
    const entry = stockLevels.find((s) => s.item_id === itemId && s.location_id === locationId);
    return entry ? entry.quantity_on_hand : 0;
  };

  const isAdminOrManager = ["admin", "manager"].includes(userRole);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!transfer) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => router.push("/procurement/transfers")}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to Transfers
        </Button>
        <p className="text-muted-foreground">Transfer not found.</p>
      </div>
    );
  }

  const items: StockTransferItem[] = transfer.stock_transfer_items ?? [];
  const issues: StockTransferIssue[] = transfer.stock_transfer_issues ?? [];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/transfers")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{transfer.transfer_number}</h1>
              <Badge variant="secondary" className={TRANSFER_STATUS_COLORS[transfer.status]}>
                {TRANSFER_STATUS_LABELS[transfer.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
              {transfer.from_location?.name ?? "—"}
              <ArrowRight className="h-3 w-3" />
              {transfer.to_location?.name ?? "—"}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {transfer.status === "draft" && (
            <Button onClick={handleSubmitForApproval} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Submit for Approval
            </Button>
          )}

          {transfer.status === "pending_approval" && isAdminOrManager && (
            <>
              <Button onClick={handleApprove} disabled={actionLoading} className="bg-green-600 hover:bg-green-700">
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={actionLoading} className="border-red-300 text-red-600 hover:bg-red-50">
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
            </>
          )}

          {transfer.status === "approved" && (
            <>
              <Button onClick={handleDispatch} disabled={actionLoading}>
                <Truck className="h-4 w-4 mr-1" /> Mark Dispatched
              </Button>
              <Button variant="outline" onClick={handleDownloadChallan}>
                <Download className="h-4 w-4 mr-1" /> Download Challan
              </Button>
            </>
          )}

          {transfer.status === "dispatched" && (
            <Button onClick={openReceiveDialog} disabled={actionLoading}>
              <PackageCheck className="h-4 w-4 mr-1" /> Receive Transfer
            </Button>
          )}
        </div>
      </div>

      {/* Approval Stock Info Card (when pending_approval) */}
      {transfer.status === "pending_approval" && stockLevels.length > 0 && (
        <Card className="border-blue-200 bg-blue-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-blue-800">Stock Levels for Approval Review</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">From Location Stock</th>
                    <th className="px-3 py-2 text-right font-medium">Transfer Qty</th>
                    <th className="px-3 py-2 text-right font-medium">To Location Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const fromStock = getStockForItem(item.item_id, transfer.from_location_id);
                    const toStock = getStockForItem(item.item_id, transfer.to_location_id);
                    return (
                      <tr key={item.id} className="border-b">
                        <td className="px-3 py-2 font-medium">{item.item_name}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={fromStock !== null && fromStock < item.quantity_sent ? "text-red-600 font-medium" : ""}>
                            {fromStock !== null ? fromStock : "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">{item.quantity_sent}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {toStock !== null ? toStock : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transfer Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transfer Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-muted-foreground">From</p>
                <p className="font-medium">{transfer.from_location?.name ?? "—"}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-muted-foreground">To</p>
                <p className="font-medium">{transfer.to_location?.name ?? "—"}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-muted-foreground">Initiated By</p>
                <p className="font-medium">{transfer.initiator?.full_name ?? "—"}</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-muted-foreground">Date</p>
                <p className="font-medium">{formatDate(transfer.created_at)}</p>
              </div>
            </div>
            {transfer.notes && (
              <div className="flex items-start gap-2 sm:col-span-2">
                <FileText className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Notes</p>
                  <p className="font-medium">{transfer.notes}</p>
                </div>
              </div>
            )}
            {transfer.approver && (
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Approved By</p>
                  <p className="font-medium">{transfer.approver.full_name ?? "—"}</p>
                </div>
              </div>
            )}
            {transfer.approved_at && (
              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Approved At</p>
                  <p className="font-medium">{formatDate(transfer.approved_at)}</p>
                </div>
              </div>
            )}
            {transfer.dispatched_at && (
              <div className="flex items-start gap-2">
                <Truck className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Dispatched At</p>
                  <p className="font-medium">{formatDate(transfer.dispatched_at)}</p>
                </div>
              </div>
            )}
            {transfer.receiver && (
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Received By</p>
                  <p className="font-medium">{transfer.receiver.full_name ?? "—"}</p>
                </div>
              </div>
            )}
            {transfer.received_at && (
              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Received At</p>
                  <p className="font-medium">{formatDate(transfer.received_at)}</p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Items Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium w-10">#</th>
                  <th className="px-4 py-3 text-left font-medium">Item Name</th>
                  <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Unit</th>
                  <th className="px-4 py-3 text-right font-medium">Qty Sent</th>
                  <th className="px-4 py-3 text-right font-medium">Qty Received</th>
                  <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Difference</th>
                  <th className="px-4 py-3 text-center font-medium hidden md:table-cell">Issue</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const diff = item.quantity_received - item.quantity_sent;
                  const hasIssue = issues.some((iss) => iss.transfer_item_id === item.id);
                  return (
                    <tr key={item.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{item.item_name}</td>
                      <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">{item.unit}</td>
                      <td className="px-4 py-3 text-right">{item.quantity_sent}</td>
                      <td className="px-4 py-3 text-right">
                        {item.quantity_received > 0 ? item.quantity_received : "—"}
                      </td>
                      <td className="px-4 py-3 text-right hidden md:table-cell">
                        {item.quantity_received > 0 ? (
                          <span className={diff !== 0 ? "text-red-600 font-medium" : "text-green-600"}>
                            {diff > 0 ? `+${diff}` : diff === 0 ? "0" : diff}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3 text-center hidden md:table-cell">
                        {hasIssue ? (
                          <Badge variant="secondary" className="bg-red-100 text-red-800">Issue</Badge>
                        ) : item.quantity_received > 0 && diff === 0 ? (
                          <Badge variant="secondary" className="bg-green-100 text-green-800">OK</Badge>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Issues Section */}
      {issues.length > 0 && (transfer.status === "issue_raised" || transfer.status === "received" || transfer.status === "completed") && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              Issues ({issues.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Item</th>
                    <th className="px-4 py-3 text-left font-medium">Issue Type</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Expected</th>
                    <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Received</th>
                    <th className="px-4 py-3 text-center font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Resolution</th>
                    {isAdminOrManager && (
                      <th className="px-4 py-3 text-center font-medium">Action</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => {
                    const relatedItem = items.find((i) => i.id === issue.transfer_item_id);
                    return (
                      <tr key={issue.id} className="border-b">
                        <td className="px-4 py-3 font-medium">
                          {relatedItem?.item_name ?? "—"}
                        </td>
                        <td className="px-4 py-3">
                          {TRANSFER_ISSUE_TYPE_LABELS[issue.issue_type] || issue.issue_type}
                        </td>
                        <td className="px-4 py-3 text-right hidden sm:table-cell">{issue.expected_quantity}</td>
                        <td className="px-4 py-3 text-right hidden sm:table-cell">{issue.reported_quantity}</td>
                        <td className="px-4 py-3 text-center">
                          <Badge variant="secondary" className={TRANSFER_ISSUE_STATUS_COLORS[issue.status]}>
                            {TRANSFER_ISSUE_STATUS_LABELS[issue.status]}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                          {issue.resolution_notes ?? "—"}
                        </td>
                        {isAdminOrManager && (
                          <td className="px-4 py-3 text-center">
                            {issue.status !== "resolved" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openResolveDialog(issue.id)}
                              >
                                Resolve
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">Resolved</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Reject Dialog ──────────────────────────────────────────────── */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Transfer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Rejection Notes <span className="text-red-500">*</span></Label>
              <Textarea
                placeholder="Reason for rejecting this transfer..."
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={actionLoading || !rejectNotes.trim()}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Reject Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Receive Dialog ─────────────────────────────────────────────── */}
      <Dialog open={receiveOpen} onOpenChange={setReceiveOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Receive Transfer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {receiveItems.map((ri, idx) => (
              <div key={ri.transfer_item_id} className="border rounded-lg p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{ri.item_name}</span>
                  <span className="text-xs text-muted-foreground">
                    Sent: {ri.quantity_sent} {ri.unit}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity Received</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={ri.quantity_received}
                      onChange={(e) => updateReceiveItem(idx, "quantity_received", e.target.value)}
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={ri.has_issue}
                        onChange={(e) => updateReceiveItem(idx, "has_issue", e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      Report Issue
                    </label>
                  </div>
                </div>

                {ri.has_issue && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                    <div className="space-y-1">
                      <Label className="text-xs">Issue Type</Label>
                      <Select
                        value={ri.issue_type}
                        onValueChange={(v) => updateReceiveItem(idx, "issue_type", v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TRANSFER_ISSUE_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {TRANSFER_ISSUE_TYPE_LABELS[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Description</Label>
                      <Input
                        placeholder="Describe the issue..."
                        value={ri.issue_description}
                        onChange={(e) => updateReceiveItem(idx, "issue_description", e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveOpen(false)}>Cancel</Button>
            <Button onClick={handleReceive} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirm Receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Resolve Issue Dialog ───────────────────────────────────────── */}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Issue</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Resolution Notes <span className="text-red-500">*</span></Label>
              <Textarea
                placeholder="Describe the resolution..."
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                rows={3}
              />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={resolveAdjustStock}
                onChange={(e) => setResolveAdjustStock(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Adjust stock (add shortfall quantity to destination)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>Cancel</Button>
            <Button onClick={handleResolveIssue} disabled={actionLoading || !resolveNotes.trim()}>
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Resolve Issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
