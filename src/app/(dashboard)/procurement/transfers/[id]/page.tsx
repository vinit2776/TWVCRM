"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useParams, useRouter } from "next/navigation";
import {
  ChevronLeft, Loader2, ArrowRight, MapPin, User, Calendar,
  FileText, Download, CheckCircle2, XCircle, Truck, PackageCheck,
  AlertTriangle, BarChart3,
} from "lucide-react";
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
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  TRANSFER_STATUS_LABELS, TRANSFER_STATUS_COLORS,
  TRANSFER_ISSUE_TYPE_LABELS, TRANSFER_ISSUE_TYPES,
  TRANSFER_ISSUE_STATUS_LABELS, TRANSFER_ISSUE_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { TransferLifecycleStatus } from "@/components/procurement/transfer-lifecycle-status";
import { TransferAuditTrail } from "@/components/procurement/transfer-audit-trail";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { TransferPhotoUpload, type UploadedTransferPhoto } from "@/components/procurement/transfer-photo-upload";

interface AuditEntry {
  id: string;
  action: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: any;
  created_at: string;
  performer?: { full_name?: string | null; role?: string | null } | null;
}
import type { StockTransfer, StockTransferItem, StockTransferIssue } from "@/types";

interface StockLevel {
  item_id: string;
  location_id: string;
  quantity_on_hand: number;
}

interface ApprovalIntelligenceItem {
  item_id: string;
  consumption_7d: number;
  consumption_30d: number;
  headcount: number | null;
  headcount_window: "7d" | "30d" | null;
  usage_per_head: number | null;
  peer_usage_per_head: number | null;
  used_peer_benchmark: boolean;
}

// ─── Dive-deeper analytics types ────────────────────────────────────────────
interface WeeklyTrendPoint {
  weekStart: string;
  consumption: number;
  headcount: number | null;
  usagePerHead: number | null;
}

interface RequestHistoryRow {
  transferNumber: string;
  date: string;
  status: string;
  requested: number;
  approved: number | null;
}

interface PeerBreakdownRow {
  locationName: string;
  consumption: number;
  headcount: number | null;
  usagePerHead: number | null;
}

interface AnalyticsData {
  weekly_trend: WeeklyTrendPoint[];
  request_history: RequestHistoryRow[];
  peer_breakdown: PeerBreakdownRow[];
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
  photos: UploadedTransferPhoto[];
}

// ─── Dispatch Dialog types ──────────────────────────────────────────────────
interface DispatchLineItem {
  transfer_item_id: string;
  item_name: string;
  unit: string;
  quantity_approved: number;
  quantity_sent: string;
}

export default function TransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useCurrentUser();
  const userRole = user?.role ?? "";

  const [transfer, setTransfer] = useState<StockTransfer | null>(null);
  const [stockLevels, setStockLevels] = useState<StockLevel[]>([]);
  const [approvalIntelligence, setApprovalIntelligence] = useState<ApprovalIntelligenceItem[]>([]);
  const [openIssuesCount, setOpenIssuesCount] = useState(0);
  const [auditTrail, setAuditTrail] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog states
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveItems, setReceiveItems] = useState<ReceiveLineItem[]>([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveIssueId, setResolveIssueId] = useState("");
  const [resolveNotes, setResolveNotes] = useState("");
  const [resolveAdjustStock, setResolveAdjustStock] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveNotes, setApproveNotes] = useState("");
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchNotes, setDispatchNotes] = useState("");
  const [dispatchItems, setDispatchItems] = useState<DispatchLineItem[]>([]);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsItemName, setAnalyticsItemName] = useState("");
  // The stock_transfer_items row the analytics dialog is showing — links the
  // dialog's approval-quantity input to the matching transfer item.
  const [analyticsTransferItemId, setAnalyticsTransferItemId] = useState("");
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  // Draft input for the line currently open in the analytics dialog — saved
  // server-side (via approve_line) only when "Submit this line" is clicked.
  const [lineQtyInput, setLineQtyInput] = useState("");

  const fetchTransfer = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/transfers/${id}`);
    if (res.ok) {
      const json = await res.json();
      setTransfer(json.data);
      setStockLevels(json.stock_levels || []);
      setApprovalIntelligence(json.approval_intelligence || []);
      setOpenIssuesCount(json.open_issues_count || 0);
      setAuditTrail(json.audit_trail || []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchTransfer(); }, [fetchTransfer]);


  // ─── Action handlers ────────────────────────────────────────────────────

  const handleAction = async (action: string, body?: Record<string, unknown>, successMessage?: string) => {
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
      toast.success(successMessage ?? `Transfer ${action.replace(/_/g, " ")} successfully`);
      await fetchTransfer();
      return true;
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitForApproval = () => handleAction("submit");

  const handleReject = async () => {
    if (!rejectNotes.trim()) { toast.error("Rejection notes are required"); return; }
    const ok = await handleAction("reject", { notes: rejectNotes.trim() });
    if (ok) { setRejectOpen(false); setRejectNotes(""); }
  };

  // ── Approve flow ──────────────────────────────────────────────────────────
  // Each line is decided and saved independently via approve_line (persisted
  // server-side, so it survives closing the dialog, reloading, or coming
  // back in a different session). The transfer-level approve is a separate,
  // final step that the backend blocks until every line has been confirmed.

  const openApproveDialog = () => setApproveOpen(true);

  const handleSubmitLine = async () => {
    if (!analyticsTransferItemId) return;
    const qty = parseFloat(lineQtyInput);
    if (isNaN(qty) || qty < 0) { toast.error("Enter a valid quantity"); return; }
    const ok = await handleAction(
      "approve_line",
      { transfer_item_id: analyticsTransferItemId, quantity_approved: qty },
      "Line decision saved"
    );
    return ok;
  };

  const handleConfirmApprove = async () => {
    const ok = await handleAction("approve", { notes: approveNotes.trim() || undefined }, "Transfer approved");
    if (ok) { setApproveOpen(false); setApproveNotes(""); }
  };

  // ── Dispatch flow ─────────────────────────────────────────────────────────

  const openDispatchDialog = () => {
    if (!transfer?.stock_transfer_items) return;
    setDispatchNotes("");
    setDispatchItems(
      transfer.stock_transfer_items.map((item) => {
        const approvedQty = item.quantity_approved ?? item.quantity_requested;
        return {
          transfer_item_id: item.id,
          item_name: item.item_name,
          unit: item.unit,
          quantity_approved: approvedQty,
          quantity_sent: String(approvedQty),
        };
      })
    );
    setDispatchOpen(true);
  };

  const updateDispatchItem = (idx: number, value: string) => {
    setDispatchItems((prev) => prev.map((it, i) => (i === idx ? { ...it, quantity_sent: value } : it)));
  };

  const handleConfirmDispatch = async () => {
    const ok = await handleAction("dispatch", {
      notes: dispatchNotes.trim() || undefined,
      items: dispatchItems.map((it) => ({
        transfer_item_id: it.transfer_item_id,
        quantity_sent: parseFloat(it.quantity_sent) || 0,
      })),
    });
    if (ok) { setDispatchOpen(false); }
  };

  const handleDownloadChallan = async () => {
    if (!transfer) return;
    const { generateTransferChallanPDF } = await import("@/lib/transfer-challan-pdf");
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
        photos: [],
      }))
    );
    setReceiveOpen(true);
  };

  const updateReceiveItem = (idx: number, field: keyof ReceiveLineItem, value: string | boolean) => {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const addReceiveItemPhoto = (idx: number, photo: UploadedTransferPhoto) => {
    setReceiveItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, photos: [...item.photos, photo] } : item))
    );
  };

  const removeReceiveItemPhoto = (idx: number, photoIdx: number) => {
    setReceiveItems((prev) =>
      prev.map((item, i) =>
        i === idx ? { ...item, photos: item.photos.filter((_, pi) => pi !== photoIdx) } : item
      )
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

          // Attach any photos captured for each item to its newly-created issue.
          const issueJson = await issueRes.json();
          const createdIssues: Array<{ id: string; transfer_item_id: string }> = issueJson.data?.issues ?? [];
          for (const ri of issueItems) {
            if (ri.photos.length === 0) continue;
            const issueId = createdIssues.find((iss) => iss.transfer_item_id === ri.transfer_item_id)?.id;
            if (!issueId) continue;
            for (const photo of ri.photos) {
              await fetch(`/api/procurement/transfers/${id}/attachments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...photo, issue_id: issueId }),
              });
            }
          }
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
  const canDispatch = ["admin", "manager", "office_admin"].includes(userRole);

  const openAnalytics = async (itemId: string | undefined, itemName: string, transferItemId: string) => {
    if (!itemId || !transfer) return;
    setAnalyticsItemName(itemName);
    setAnalyticsTransferItemId(transferItemId);
    setAnalyticsData(null);
    setAnalyticsOpen(true);
    setAnalyticsLoading(true);
    const sourceItem = transfer.stock_transfer_items?.find((i) => i.id === transferItemId);
    if (sourceItem) {
      setLineQtyInput(String(sourceItem.quantity_approved ?? sourceItem.quantity_requested));
    }
    try {
      const res = await fetch(
        `/api/procurement/transfers/analytics?location_id=${transfer.to_location_id}&item_id=${itemId}`
      );
      if (res.ok) setAnalyticsData(await res.json());
    } finally {
      setAnalyticsLoading(false);
    }
  };

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
  const confirmedLineCount = items.filter((i) => i.approval_confirmed_at).length;
  const allLinesConfirmed = items.length > 0 && confirmedLineCount === items.length;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/transfers")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">{transfer.transfer_number}</h1>
              <Badge variant="secondary" className={TRANSFER_STATUS_COLORS[transfer.status]}>
                {TRANSFER_STATUS_LABELS[transfer.status]}
              </Badge>
              {(transfer as unknown as { billing_status?: string }).billing_status === "billed" && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-300">Billable — Billed</Badge>
              )}
              {(transfer as unknown as { billing_status?: string }).billing_status === "pending" && (
                <Badge className="bg-amber-100 text-amber-800 border-amber-300">Billable — Pending</Badge>
              )}
              {(transfer as unknown as { billing_status?: string }).billing_status === "error" && (
                <Badge variant="destructive">Billing Error</Badge>
              )}
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
              <Button onClick={openApproveDialog} disabled={actionLoading} className="bg-green-600 hover:bg-green-700">
                <CheckCircle2 className="h-4 w-4 mr-1" /> Approve ({confirmedLineCount}/{items.length})
              </Button>
              <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={actionLoading} className="border-red-300 text-red-600 hover:bg-red-50">
                <XCircle className="h-4 w-4 mr-1" /> Reject
              </Button>
            </>
          )}

          {transfer.status === "approved" && (
            <>
              {canDispatch && (
                <>
                  <Button onClick={openDispatchDialog} disabled={actionLoading}>
                    <Truck className="h-4 w-4 mr-1" /> Mark Dispatched
                  </Button>
                  <InfoTooltip text="Dispatching removes this stock from the source location immediately." />
                </>
              )}
              <Button variant="outline" onClick={handleDownloadChallan}>
                <Download className="h-4 w-4 mr-1" /> Download Challan
              </Button>
            </>
          )}

          {transfer.status === "dispatched" && (
            <>
              <Button onClick={openReceiveDialog} disabled={actionLoading}>
                <PackageCheck className="h-4 w-4 mr-1" /> Receive Transfer
              </Button>
              <InfoTooltip text="Receiving adds the entered quantities to this location's stock." />
            </>
          )}
        </div>
      </div>

      {/* Lifecycle progress */}
      <TransferLifecycleStatus transfer={transfer} />

      {/* Approval Stock Info Card (when pending_approval) */}
      {transfer.status === "pending_approval" && stockLevels.length > 0 && (
        <Card className="border-blue-200 bg-blue-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-blue-800">Stock Levels for Approval Review</CardTitle>
          </CardHeader>
          <CardContent>
            {openIssuesCount > 0 && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {openIssuesCount} unresolved issue{openIssuesCount !== 1 ? "s" : ""} from past transfers at this location.
              </div>
            )}
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">From Location Stock</th>
                    <th className="px-3 py-2 text-right font-medium">Requested</th>
                    <th className="px-3 py-2 text-right font-medium">To Location Stock</th>
                    <th className="px-3 py-2 text-right font-medium">Used (7d / 30d)</th>
                    <th className="px-3 py-2 text-right font-medium">Headcount</th>
                    <th className="px-3 py-2 text-right font-medium">Usage/head</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const fromStock = getStockForItem(item.item_id, transfer.from_location_id);
                    const toStock = getStockForItem(item.item_id, transfer.to_location_id);
                    const intel = approvalIntelligence.find((a) => a.item_id === item.item_id);
                    // used_peer_benchmark is the source of truth for which number to trust —
                    // usage_per_head can be legitimately 0 (no local history), which `??`
                    // would keep instead of falling back to the peer benchmark.
                    const usagePerHead = intel?.used_peer_benchmark
                      ? intel?.peer_usage_per_head ?? null
                      : intel?.usage_per_head ?? null;
                    const impliedExpected = usagePerHead !== null && intel?.headcount ? usagePerHead * intel.headcount : null;
                    const isAnomaly = impliedExpected !== null && impliedExpected > 0 && item.quantity_requested > impliedExpected * 2;
                    return (
                      <tr key={item.id} className="border-b">
                        <td className="px-3 py-2 font-medium">
                          <button
                            type="button"
                            className="text-left text-blue-700 hover:underline underline-offset-2 inline-flex items-center gap-1"
                            onClick={() => openAnalytics(item.item_id, item.item_name, item.id)}
                            title="See consumption, headcount, and request history behind this"
                          >
                            {item.item_name}
                            <BarChart3 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                          </button>
                          {item.approval_confirmed_at && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-green-700 bg-green-100 rounded px-1.5 py-0.5 align-middle">
                              <CheckCircle2 className="h-3 w-3" /> {item.quantity_approved} approved
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={fromStock !== null && fromStock < item.quantity_requested ? "text-red-600 font-medium" : ""}>
                            {fromStock !== null ? fromStock : "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className={isAnomaly ? "text-amber-600 font-semibold" : "font-medium"}>
                            {item.quantity_requested}
                          </span>
                          {isAnomaly && (
                            <button
                              type="button"
                              className="block text-[10px] text-amber-600 font-normal hover:underline"
                              onClick={() => openAnalytics(item.item_id, item.item_name, item.id)}
                            >
                              usual ~{Math.round(impliedExpected!)} · see why
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {toStock !== null ? toStock : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {intel ? `${intel.consumption_7d} / ${intel.consumption_30d}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {intel?.headcount ? `${Math.round(intel.headcount)} (${intel.headcount_window})` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {usagePerHead !== null ? (
                            <>
                              {usagePerHead.toFixed(2)}
                              {intel?.used_peer_benchmark && (
                                <span className="block text-[10px] text-blue-600 font-normal">peer avg</span>
                              )}
                            </>
                          ) : "—"}
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
                  <p className="text-muted-foreground">Requester&apos;s Notes</p>
                  <p className="font-medium">{transfer.notes}</p>
                </div>
              </div>
            )}
            {transfer.approver_notes && (
              <div className="flex items-start gap-2 sm:col-span-2">
                <FileText className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-muted-foreground">Approver&apos;s Notes</p>
                  <p className="font-medium">{transfer.approver_notes}</p>
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
                  <th className="px-4 py-3 text-right font-medium">Requested</th>
                  <th className="px-4 py-3 text-right font-medium hidden sm:table-cell">Approved</th>
                  <th className="px-4 py-3 text-right font-medium">Sent</th>
                  <th className="px-4 py-3 text-right font-medium">Received</th>
                  <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Difference</th>
                  <th className="px-4 py-3 text-center font-medium hidden md:table-cell">Issue</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const diff = item.quantity_received - item.quantity_sent;
                  const hasIssue = issues.some((iss) => iss.transfer_item_id === item.id);
                  const approvedShort = item.quantity_approved !== null && item.quantity_approved < item.quantity_requested;
                  const sentShort = transfer.status !== "draft" && transfer.status !== "pending_approval"
                    && item.quantity_approved !== null && item.quantity_sent < item.quantity_approved;
                  return (
                    <tr key={item.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">
                        {item.item_name}
                        <span className="block text-xs font-normal text-muted-foreground sm:hidden">{item.unit}</span>
                        {item.notes && (
                          <span className="block text-xs font-normal text-muted-foreground italic">&quot;{item.notes}&quot;</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">{item.quantity_requested}</td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        <span className={approvedShort ? "text-amber-600 font-medium" : ""}>
                          {item.quantity_approved ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={sentShort ? "text-amber-600 font-medium" : ""}>
                          {transfer.status === "draft" || transfer.status === "pending_approval" || transfer.status === "approved"
                            ? "—"
                            : item.quantity_sent}
                        </span>
                      </td>
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

      {/* Billing Summary (billable transfers only, after receipt) */}
      {(transfer as unknown as { billing_status?: string }).billing_status === "billed" && (
        <Card className="border-amber-300 bg-amber-50/30 dark:bg-amber-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-amber-800 dark:text-amber-300 flex items-center gap-2">
              Billing Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              This transfer has been billed. The charge will appear on the destination&apos;s next billing statement.
              Refer to this DC ({transfer.transfer_number}) for the itemised goods list.
            </p>
            <div className="text-sm space-y-1">
              <div className="flex justify-between text-muted-foreground">
                <span>Procurement value (incl. GST)</span>
                <span className="font-mono">see DC</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Service charge</span>
                <span className="font-mono">see DC</span>
              </div>
              <div className="flex justify-between font-medium border-t pt-1 mt-1">
                <span>Usage charge created</span>
                <Badge className="bg-green-100 text-green-800">Pending billing</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                                Explain & close
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

            {(transfer.stock_transfer_attachments ?? []).length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Photos</p>
                <div className="flex gap-2 flex-wrap">
                  {(transfer.stock_transfer_attachments ?? []).map((att) => {
                    const relatedIssue = issues.find((iss) => iss.id === att.issue_id);
                    const relatedItem = items.find((i) => i.id === relatedIssue?.transfer_item_id);
                    return (
                      <a
                        key={att.id}
                        href={att.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="relative h-20 w-20 shrink-0 rounded-md overflow-hidden border bg-muted block"
                        title={relatedItem?.item_name ?? "Attachment"}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={att.file_url} alt={relatedItem?.item_name ?? "Attachment"} className="h-full w-full object-cover" />
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Audit trail — who did what, and when */}
      {auditTrail.length > 0 && <TransferAuditTrail entries={auditTrail} />}

      {/* ─── Approve Dialog ─────────────────────────────────────────────── */}
      {/* Read-only checklist over decisions already saved per-line via
          approve_line — this dialog only finalizes; it never edits a
          quantity itself. Blocked until every line is confirmed. */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Approve Transfer</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            {confirmedLineCount} of {items.length} lines confirmed.
            {!allLinesConfirmed && " Every line needs a saved decision before you can approve."}
          </p>
          <div className="space-y-2">
            {items.map((item) => {
              const isConfirmed = !!item.approval_confirmed_at;
              const approvedQty = item.quantity_approved;
              const isShort = isConfirmed && approvedQty !== null && approvedQty < item.quantity_requested;
              return (
                <div
                  key={item.id}
                  className={`border rounded-lg p-3 flex items-center justify-between gap-3 ${isConfirmed ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{item.item_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Requested: {item.quantity_requested} {item.unit}
                      {isConfirmed && (
                        <>
                          {" · Approved: "}
                          <span className={isShort ? "text-amber-600 font-medium" : ""}>{approvedQty} {item.unit}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {isConfirmed ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-green-700 bg-green-100 rounded px-1.5 py-0.5">
                        <CheckCircle2 className="h-3 w-3" /> Confirmed
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                        Needs a decision
                      </span>
                    )}
                    <button
                      type="button"
                      className="text-xs text-blue-700 hover:underline inline-flex items-center gap-1"
                      onClick={() => {
                        setApproveOpen(false);
                        openAnalytics(item.item_id, item.item_name, item.id);
                      }}
                    >
                      <BarChart3 className="h-3 w-3" /> {isConfirmed ? "Revisit" : "Decide now"}
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="space-y-1.5">
              <Label>Notes to requester (optional)</Label>
              <Textarea
                placeholder="e.g. reduce next month's request, approved with caution..."
                value={approveNotes}
                onChange={(e) => setApproveNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)}>Cancel</Button>
            <Button
              onClick={handleConfirmApprove}
              disabled={actionLoading || !allLinesConfirmed}
              className="bg-green-600 hover:bg-green-700"
              title={allLinesConfirmed ? undefined : "Every line needs a saved decision first"}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Approve Transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dispatch Dialog ────────────────────────────────────────────── */}
      <Dialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dispatch Transfer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {dispatchItems.map((di, idx) => {
              const sentNum = parseFloat(di.quantity_sent) || 0;
              const isShort = sentNum < di.quantity_approved;
              return (
                <div key={di.transfer_item_id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{di.item_name}</span>
                    <span className="text-xs text-muted-foreground">
                      Approved: {di.quantity_approved} {di.unit}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity Actually Sent</Label>
                    <Input
                      type="number"
                      min="0"
                      max={di.quantity_approved}
                      step="0.01"
                      value={di.quantity_sent}
                      onChange={(e) => updateDispatchItem(idx, e.target.value)}
                      className={isShort ? "border-amber-400 focus-visible:ring-amber-300" : ""}
                    />
                  </div>
                  {isShort && (
                    <p className="text-xs text-amber-600">
                      Short by {di.quantity_approved - sentNum} {di.unit} — this is final, not backordered.
                    </p>
                  )}
                </div>
              );
            })}
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="e.g. only 6 physically on shelf at dispatch time..."
                value={dispatchNotes}
                onChange={(e) => setDispatchNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDispatchOpen(false)}>Cancel</Button>
            <Button onClick={handleConfirmDispatch} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirm Dispatch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Dive-Deeper Analytics Dialog ───────────────────────────────── */}
      <Dialog open={analyticsOpen} onOpenChange={setAnalyticsOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{analyticsItemName} — {transfer.to_location?.name ?? "this location"}</DialogTitle>
          </DialogHeader>
          {analyticsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !analyticsData ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Couldn&apos;t load analytics.</p>
          ) : (
            <div className="space-y-5">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Weekly consumption vs headcount (10 weeks)</p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={analyticsData.weekly_trend}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="weekStart"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => formatDate(v).replace(/,.*/, "")}
                    />
                    <YAxis yAxisId="left" tick={{ fontSize: 11 }} width={30} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} width={30} />
                    <Tooltip
                      labelFormatter={(v) => formatDate(String(v))}
                      formatter={(value, name) => [
                        value as number,
                        name === "consumption" ? "Used" : name === "headcount" ? "Headcount" : name,
                      ]}
                    />
                    <Line yAxisId="left" type="monotone" dataKey="consumption" stroke="#015E65" strokeWidth={2} dot={{ r: 2 }} name="consumption" />
                    <Line yAxisId="right" type="monotone" dataKey="headcount" stroke="#e67e22" strokeWidth={2} dot={{ r: 2 }} name="headcount" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full inline-block" style={{ background: "#015E65" }} />Used</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full inline-block" style={{ background: "#e67e22" }} />Headcount</span>
                </div>
              </div>

              {analyticsData.peer_breakdown.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Local history is too thin to trust — this location&apos;s benchmark is averaged from these locations instead:
                  </p>
                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">Location</th>
                          <th className="px-3 py-1.5 text-right font-medium">Used (30d)</th>
                          <th className="px-3 py-1.5 text-right font-medium">Headcount</th>
                          <th className="px-3 py-1.5 text-right font-medium">Usage/head</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsData.peer_breakdown.map((p) => (
                          <tr key={p.locationName} className="border-b last:border-0">
                            <td className="px-3 py-1.5">{p.locationName}</td>
                            <td className="px-3 py-1.5 text-right">{p.consumption}</td>
                            <td className="px-3 py-1.5 text-right">{p.headcount !== null ? Math.round(p.headcount) : "—"}</td>
                            <td className="px-3 py-1.5 text-right">{p.usagePerHead !== null ? p.usagePerHead.toFixed(2) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Past requests for this item at this location</p>
                {analyticsData.request_history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No prior requests found.</p>
                ) : (
                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">Transfer</th>
                          <th className="px-3 py-1.5 text-left font-medium">Date</th>
                          <th className="px-3 py-1.5 text-right font-medium">Requested</th>
                          <th className="px-3 py-1.5 text-right font-medium">Approved</th>
                          <th className="px-3 py-1.5 text-center font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyticsData.request_history.map((r) => (
                          <tr key={r.transferNumber} className="border-b last:border-0">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.transferNumber}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{formatDate(r.date)}</td>
                            <td className="px-3 py-1.5 text-right">{r.requested}</td>
                            <td className="px-3 py-1.5 text-right">{r.approved ?? "—"}</td>
                            <td className="px-3 py-1.5 text-center">
                              <Badge variant="secondary" className={TRANSFER_STATUS_COLORS[r.status]}>
                                {TRANSFER_STATUS_LABELS[r.status]}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Approval decision — set and save this item's approved quantity
              right here, with all the context above in view. Saves
              immediately via approve_line; independent of every other line. */}
          {transfer.status === "pending_approval" && isAdminOrManager && (() => {
            const item = transfer.stock_transfer_items?.find((i) => i.id === analyticsTransferItemId);
            if (!item) return null;
            const approvedNum = parseFloat(lineQtyInput) || 0;
            const isShort = approvedNum < item.quantity_requested;
            const isConfirmed = !!item.approval_confirmed_at;
            return (
              <div className="rounded-lg border border-green-200 bg-green-50/40 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Approval decision</p>
                  <span className="text-xs text-muted-foreground">
                    Requested: {item.quantity_requested} {item.unit}
                  </span>
                </div>
                {isConfirmed && (
                  <p className="text-xs text-green-700 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Saved — {item.quantity_approved} {item.unit} approved
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Quantity to approve</Label>
                    <Input
                      type="number"
                      min="0"
                      max={item.quantity_requested}
                      step="0.01"
                      value={lineQtyInput}
                      onChange={(e) => setLineQtyInput(e.target.value)}
                      className={isShort ? "border-amber-400 focus-visible:ring-amber-300" : ""}
                    />
                  </div>
                </div>
                {isShort && (
                  <p className="text-xs text-amber-600">
                    Short by {item.quantity_requested - approvedNum} {item.unit} — this is final, not backordered.
                  </p>
                )}
                <Button
                  size="sm"
                  onClick={handleSubmitLine}
                  disabled={actionLoading}
                  className="w-full bg-green-600 hover:bg-green-700"
                >
                  {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                  {isConfirmed ? "Update this line's decision" : "Submit this line"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Saves immediately — close this and come back later if you need to. The
                  transfer can only be approved once every line has been submitted.
                </p>
              </div>
            );
          })()}

          {transfer.status === "pending_approval" && isAdminOrManager && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setAnalyticsOpen(false)}>Close</Button>
              <Button
                variant="outline"
                onClick={() => { setAnalyticsOpen(false); openApproveDialog(); }}
              >
                View approval checklist
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

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
                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Photos (state / damage evidence)</Label>
                      <TransferPhotoUpload
                        pathPrefix={`transfer/${id}`}
                        photos={ri.photos}
                        onUploaded={(photo) => addReceiveItemPhoto(idx, photo)}
                        onRemove={(photoIdx) => removeReceiveItemPhoto(idx, photoIdx)}
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

      {/* ─── Explain & Close Issue Dialog ───────────────────────────────── */}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Explain & close issue</DialogTitle>
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
              Explain & close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
