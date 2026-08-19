"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, Loader2, Truck, MapPin, User, Calendar,
  FileText, PackageOpen, Receipt, Download, CreditCard,
  Clock, Paperclip, X, CheckCircle2, Package, ClipboardList, Info,
  AlertTriangle, Undo2, Mail, Wrench, Phone, CalendarDays,
  XCircle, Edit3, Save,
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
// Type-only import — compiles away, no runtime cost. Keeps Parameters<typeof ...> working.
import type { generatePurchaseOrderPDF } from "@/lib/po-pdf-generator";
import {
  PO_STATUS_LABELS, PO_STATUS_COLORS, BILLING_CYCLE_LABELS,
  PO_ADVANCE_STATUS_LABELS, PO_ADVANCE_STATUS_COLORS, PO_ADVANCE_PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { ServiceBillingSteps } from "@/components/procurement/service-billing-steps";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type { PurchaseOrder, AuditLog, PoServiceReport, AmcServiceEvent, AmcStatus } from "@/types";
import { AmcEventDialog } from "@/components/procurement/amc-event-dialog";
import { AmcLifecycleStrip } from "@/components/procurement/amc-lifecycle-strip";
import { computeAmcLifecycle } from "@/lib/amc-lifecycle";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { QueryButton } from "@/components/queries/query-button";

const ACCEPTED_FILE_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type ActionType =
  | "mark_ordered"
  | "mark_received"
  | "cancel"
  | "partial_cancel"
  | "record_delivery"
  | "record_service_report"
  | "add_invoice"
  | "reject_delivery"
  | "edit_delivery"
  | "edit_invoice"
  | "process_advance"
  | "approve_advance"
  | "reject_advance"
  | "terminate_amc"
  | "email_po";

// ─── Timeline helper ─────────────────────────────────────────────────────────
interface TimelineItem {
  id: string;
  ts: string;
  type: "created" | "ordered" | "delivery" | "service_report" | "invoice" | "status" | "advance";
  title: string;
  subtitle: string;
  fileUrl?: string | null;
  fileLabel?: string;
  deliveryReceiptId?: string;
  billId?: string;
  billApprovalStatus?: string;
}

function buildTimeline(
  po: PurchaseOrder,
  auditEvents: AuditLog[]
): TimelineItem[] {
  const items: TimelineItem[] = [];

  // PO Created
  items.push({
    id: "created",
    ts: po.created_at,
    type: "created",
    title: "PO Created",
    subtitle: po.orderer?.full_name ?? po.orderer?.email ?? "—",
  });

  // Audit-driven events (mark_ordered, cancellations, etc.)
  for (const ev of auditEvents) {
    const changes = ev.changes as Record<string, { old: unknown; new: unknown }> | null;
    const newStatus = changes?.status?.new as string | undefined;
    if (!newStatus) continue;

    if (newStatus === "ordered") {
      const performer = (ev as unknown as { performer?: { full_name?: string } }).performer;
      items.push({
        id: ev.id,
        ts: ev.created_at,
        type: "ordered",
        title: "Marked as Ordered",
        subtitle: performer?.full_name ?? "—",
      });
    } else if (newStatus === "cancelled") {
      const performer = (ev as unknown as { performer?: { full_name?: string } }).performer;
      items.push({
        id: ev.id,
        ts: ev.created_at,
        type: "status",
        title: "Order Cancelled",
        subtitle: performer?.full_name ?? "—",
      });
    } else if (newStatus === "partially_cancelled") {
      const performer = (ev as unknown as { performer?: { full_name?: string } }).performer;
      items.push({
        id: ev.id,
        ts: ev.created_at,
        type: "status",
        title: "Partially Cancelled",
        subtitle: performer?.full_name ?? "—",
      });
    }
  }

  // Delivery receipts
  for (const dr of po.po_delivery_receipts ?? []) {
    items.push({
      id: `dr-${dr.id}`,
      ts: dr.received_at,
      type: "delivery",
      title: dr.dc_number
        ? `Delivery Received — ${dr.dc_number}`
        : "Delivery Received",
      subtitle: dr.receiver?.full_name ?? "—",
      fileUrl: dr.file_url,
      fileLabel: "View Challan",
      deliveryReceiptId: dr.id,
    });
  }

  // Service reports
  for (const sr of (po.po_service_reports as PoServiceReport[] | undefined) ?? []) {
    const invoiced = (po.vendor_bills ?? []).some((b) => b.service_report_id === sr.id);
    items.push({
      id: `sr-${sr.id}`,
      ts: sr.created_at,
      type: "service_report",
      title: `Service Report — Cycle ${sr.cycle_number}`,
      subtitle: `${formatDate(sr.period_from)} – ${formatDate(sr.period_to)} · ${sr.recorder?.full_name ?? "—"}${invoiced ? " · Invoiced" : " · Pending invoice"}`,
      fileUrl: sr.report_file_url,
      fileLabel: "View Report",
    });
  }

  // Advance payment processed
  if (po.advance_status === "processed" && po.advance_processed_at) {
    items.push({
      id: "advance-processed",
      ts: po.advance_processed_at,
      type: "advance",
      title: "Advance Payment Processed",
      subtitle: `${formatCurrency(po.advance_amount ?? 0)} · ${PO_ADVANCE_PAYMENT_MODE_LABELS[po.advance_payment_mode ?? ""] ?? ""}${po.advance_payment_date ? ` · ${formatDate(po.advance_payment_date)}` : ""}`,
    });
  }

  // Vendor bills / invoices
  for (const bill of po.vendor_bills ?? []) {
    items.push({
      id: `bill-${bill.id}`,
      ts: bill.created_at,
      type: "invoice",
      title: `Invoice — ${bill.bill_number}`,
      subtitle: `${formatCurrency(bill.total_amount)}${bill.approval_status === "approved" ? " · Approved for Payment" : bill.approval_status === "rejected" ? " · Rejected" : " · Pending Payment Approval"}${bill.creator?.full_name ? ` · by ${bill.creator.full_name}` : ""}`,
      fileUrl: bill.invoice_file_url,
      fileLabel: "View Invoice",
      billId: bill.id,
      billApprovalStatus: bill.approval_status,
    });
  }

  // Sort chronologically
  return items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

const TIMELINE_DOT_COLORS: Record<TimelineItem["type"], string> = {
  created: "bg-blue-500",
  ordered: "bg-blue-600",
  delivery: "bg-green-500",
  service_report: "bg-teal-500",
  invoice: "bg-purple-500",
  status: "bg-gray-400",
  advance: "bg-orange-500",
};

// ─── File validation helper ───────────────────────────────────────────────────
function validateFile(file: File): string | null {
  if (!ACCEPTED_FILE_TYPES.includes(file.type)) {
    return "Only PDF, JPEG, PNG, or WebP files are accepted";
  }
  if (file.size > MAX_FILE_SIZE) {
    return "File size must be under 10 MB";
  }
  return null;
}

// ─── File upload helper ───────────────────────────────────────────────────────
async function uploadFile(file: File, bucket: string): Promise<string> {
  const supabase = createBrowserClient();
  const ext = file.name.split(".").pop() ?? "pdf";
  const filePath = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(filePath, file);
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

// ─── File attachment display ──────────────────────────────────────────────────
function FileAttachment({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
      <FileText className="h-4 w-4 text-primary flex-shrink-0" />
      <span className="text-sm flex-1 truncate">{file.name}</span>
      <span className="text-xs text-muted-foreground">
        {(file.size / 1024).toFixed(0)} KB
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 text-muted-foreground hover:text-destructive"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function FileDropzone({
  fileRef,
  label,
  required,
  onChange,
}: {
  fileRef: React.RefObject<HTMLInputElement | null>;
  label: string;
  required?: boolean;
  onChange: (file: File) => void;
}) {
  return (
    <div
      className="flex items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/25 px-4 py-5 cursor-pointer hover:border-muted-foreground/50 transition-colors"
      onClick={() => fileRef.current?.click()}
    >
      <div className="text-center">
        <Paperclip className="h-5 w-5 text-muted-foreground mx-auto mb-1" />
        <p className="text-sm text-muted-foreground">
          {label}
        </p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const err = validateFile(f);
          if (err) { toast.error(err); e.target.value = ""; return; }
          onChange(f);
        }}
      />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading: userLoading } = useCurrentUser();
  const currentUserRole = user?.role ?? null;

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditLog[]>([]);

  const [actionDialog, setActionDialog] = useState<ActionType | null>(null);

  // Mark Ordered
  // (no extra state needed)

  // Cancel (with delivery-aware warnings)
  const [forceCancelStep, setForceCancelStep] = useState<1 | 2>(1);

  // Reject Delivery
  const [rejectDeliveryId, setRejectDeliveryId] = useState<string | null>(null);

  // Email PO
  const [emailTo, setEmailTo] = useState("");
  const [emailSaveToVendor, setEmailSaveToVendor] = useState(false);
  const [emailSending, setEmailSending] = useState(false);

  // Partial Cancel
  const [partialCancelQtys, setPartialCancelQtys] = useState<Record<string, string>>({});
  const [hasBill, setHasBill] = useState(false);

  // Record Delivery
  const [dcNumber, setDcNumber] = useState("");
  const [dcDate, setDcDate] = useState("");
  const [dcFile, setDcFile] = useState<File | null>(null);
  const [dcNotes, setDcNotes] = useState("");
  const [dcQtys, setDcQtys] = useState<Record<string, string>>({});
  const [dcUploading, setDcUploading] = useState(false);
  const dcFileRef = useRef<HTMLInputElement>(null);

  // Add Invoice
  const [invNumber, setInvNumber] = useState("");
  const [invDate, setInvDate] = useState("");
  const [invDueDate, setInvDueDate] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invFile, setInvFile] = useState<File | null>(null);
  const [invNotes, setInvNotes] = useState("");
  const [invUploading, setInvUploading] = useState(false);
  const invFileRef = useRef<HTMLInputElement>(null);
  // Service PO invoice: which service report this invoice covers
  const [invServiceReportId, setInvServiceReportId] = useState("");

  // Edit Delivery (correct a wrong DC upload — file/number/date/notes only, no qty changes)
  const [editDeliveryId, setEditDeliveryId] = useState<string | null>(null);
  const [editDcNumber, setEditDcNumber] = useState("");
  const [editDcDate, setEditDcDate] = useState("");
  const [editDcFile, setEditDcFile] = useState<File | null>(null);
  const [editDcExistingUrl, setEditDcExistingUrl] = useState("");
  const [editDcNotes, setEditDcNotes] = useState("");
  const [editDcSaving, setEditDcSaving] = useState(false);
  const editDcFileRef = useRef<HTMLInputElement>(null);

  // Edit Invoice (correct a wrong invoice upload — locked once approved for payment)
  const [editBillId, setEditBillId] = useState<string | null>(null);
  const [editInvNumber, setEditInvNumber] = useState("");
  const [editInvDate, setEditInvDate] = useState("");
  const [editInvDueDate, setEditInvDueDate] = useState("");
  const [editInvAmount, setEditInvAmount] = useState("");
  const [editInvFile, setEditInvFile] = useState<File | null>(null);
  const [editInvExistingUrl, setEditInvExistingUrl] = useState("");
  const [editInvNotes, setEditInvNotes] = useState("");
  const [editInvLoading, setEditInvLoading] = useState(false);
  const [editInvSaving, setEditInvSaving] = useState(false);
  const editInvFileRef = useRef<HTMLInputElement>(null);

  // Process Advance
  const [advancePaymentDate, setAdvancePaymentDate] = useState("");

  // Record Service Report
  const [srCycleNumber, setSrCycleNumber] = useState("");
  const [srPeriodFrom, setSrPeriodFrom] = useState("");
  const [srPeriodTo, setSrPeriodTo] = useState("");
  const [srFile, setSrFile] = useState<File | null>(null);
  const [srNotes, setSrNotes] = useState("");
  const [srUploading, setSrUploading] = useState(false);
  const srFileRef = useRef<HTMLInputElement>(null);

  // AMC Events
  const [amcEvents, setAmcEvents] = useState<AmcServiceEvent[]>([]);
  const [amcEventsLoaded, setAmcEventsLoaded] = useState(false);
  const [amcEventsLoading, setAmcEventsLoading] = useState(false);
  const [showAmcEventDialog, setShowAmcEventDialog] = useState(false);
  // AMC contact edit mode
  const [amcEditMode, setAmcEditMode] = useState(false);
  // Termination reason — captured in the confirm dialog before calling the API
  const [terminationReason, setTerminationReason] = useState("");
  const [amcContactName, setAmcContactName] = useState("");
  const [amcHelpline, setAmcHelpline] = useState("");
  const [amcContactEmail, setAmcContactEmail] = useState("");
  const [amcStartDate, setAmcStartDate] = useState("");
  const [amcEndDate, setAmcEndDate] = useState("");
  const [amcVisitsCovered, setAmcVisitsCovered] = useState("");
  const [amcUnlimited, setAmcUnlimited] = useState(false);
  const [amcSaving, setAmcSaving] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const fetchPo = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/orders/${id}`);
    if (res.ok) {
      const json = await res.json();
      setPo(json.data);
      setAuditEvents(json.audit_events ?? []);
    } else {
      toast.error("Failed to load purchase order");
      router.push("/procurement/orders");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchPo(); }, [fetchPo]);

  // Load AMC events (called on demand when AMC section is first rendered)
  const fetchAmcEvents = useCallback(async () => {
    if (amcEventsLoaded) return;
    setAmcEventsLoading(true);
    try {
      const res = await fetch(`/api/procurement/amc/${id}/events`);
      const data = await res.json();
      setAmcEvents(data.data ?? []);
      setAmcEventsLoaded(true);
    } catch {
      toast.error("Failed to load AMC service events");
    } finally {
      setAmcEventsLoading(false);
    }
  }, [id, amcEventsLoaded]);

  const saveAmcDetails = async () => {
    setAmcSaving(true);
    try {
      const res = await fetch(`/api/procurement/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_amc_details",
          amc_start_date: amcStartDate || null,
          amc_end_date: amcEndDate || null,
          amc_visits_covered: amcUnlimited ? null : amcVisitsCovered ? parseInt(amcVisitsCovered) : null,
          amc_contact_name: amcContactName || null,
          amc_helpline_number: amcHelpline || null,
          amc_contact_email: amcContactEmail || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save AMC details"); return; }
      toast.success("AMC details saved");
      setAmcEditMode(false);
      await fetchPo();
    } finally {
      setAmcSaving(false);
    }
  };

  // Check if a vendor bill exists for this PO when status is invoice_received
  useEffect(() => {
    if (po?.status === "invoice_received" && po?.id) {
      fetch(`/api/procurement/bills?po_id=${po.id}`)
        .then((r) => r.json())
        .then((j) => setHasBill((j.data?.length ?? 0) > 0))
        .catch(() => setHasBill(false));
    }
  }, [po?.id, po?.status]);

  // ── Simple PATCH actions (mark_ordered, cancel, partial_cancel) ────────────
  const performAction = async (
    action: ActionType,
    extra?: Record<string, unknown>
  ) => {
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
      const msgs: Partial<Record<ActionType, string>> = {
        mark_ordered: "Order marked as ordered",
        cancel: "Order cancelled",
        partial_cancel: "Order partially cancelled — remaining qty released back to PR",
        process_advance: "Advance payment marked as processed",
        approve_advance: "Advance payment approved — accounts can now process payment",
        reject_advance: "Advance payment rejected",
        terminate_amc: "AMC terminated — events history preserved",
      };
      toast.success(msgs[action] ?? "Done");
      setActionDialog(null);
      setPartialCancelQtys({});
      setForceCancelStep(1);
      await fetchPo();
    } finally {
      setActionLoading(false);
    }
  };

  // ── Reject Delivery ──────────────────────────────────────────────────────
  const rejectDelivery = async (deliveryId: string) => {
    setActionLoading(true);
    try {
      const res = await fetch(
        `/api/procurement/orders/${id}/deliveries?delivery_id=${deliveryId}`,
        { method: "DELETE" }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to reject delivery");
        return;
      }
      toast.success("Delivery rejected — quantities reversed");
      setActionDialog(null);
      setRejectDeliveryId(null);
      await fetchPo();
    } finally {
      setActionLoading(false);
    }
  };

  // ── Record Delivery ────────────────────────────────────────────────────────
  const submitDelivery = async () => {
    if (!dcDate) { toast.error("Delivery date is required"); return; }
    if (dcDate < today) { toast.error("Delivery date cannot be in the past. Please select today or a future date."); return; }
    if (!dcFile) { toast.error("Please upload the delivery challan file"); return; }

    const items = (po?.purchase_order_items ?? []).map((item) => ({
      po_item_id: item.id,
      qty_received: parseFloat(dcQtys[item.id] || "0"),
    }));

    for (const i of items) {
      if (isNaN(i.qty_received) || i.qty_received < 0) {
        toast.error("All quantities must be valid non-negative numbers");
        return;
      }
    }
    if (items.every((i) => i.qty_received === 0)) {
      toast.error("At least one item must have a quantity greater than 0");
      return;
    }

    setDcUploading(true);
    try {
      let fileUrl: string;
      try {
        fileUrl = await uploadFile(dcFile, "delivery-challans");
      } catch (err) {
        toast.error(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }

      const res = await fetch(`/api/procurement/orders/${id}/deliveries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dc_number: dcNumber.trim() || null,
          dc_date: dcDate,
          file_url: fileUrl,
          notes: dcNotes.trim() || null,
          items,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to record delivery");
        return;
      }

      toast.success("Delivery recorded successfully");
      setActionDialog(null);
      setDcFile(null);
      setDcQtys({});
      setDcNumber("");
      setDcNotes("");
      setDcDate("");
      if (dcFileRef.current) dcFileRef.current.value = "";
      await fetchPo();
    } finally {
      setDcUploading(false);
    }
  };

  // ── Edit Delivery (correct a wrong DC upload) ──────────────────────────────
  const openEditDelivery = (deliveryId: string) => {
    const receipt = (po?.po_delivery_receipts ?? []).find((dr) => dr.id === deliveryId);
    if (!receipt) return;
    setEditDeliveryId(deliveryId);
    setEditDcNumber(receipt.dc_number ?? "");
    setEditDcDate(receipt.dc_date ?? "");
    setEditDcNotes(receipt.notes ?? "");
    setEditDcExistingUrl(receipt.file_url ?? "");
    setEditDcFile(null);
    setActionDialog("edit_delivery");
  };

  const submitEditDelivery = async () => {
    if (!editDeliveryId) return;
    if (!editDcDate) { toast.error("Delivery date is required"); return; }
    if (!editDcFile && !editDcExistingUrl) { toast.error("Please upload the delivery challan file"); return; }

    setEditDcSaving(true);
    try {
      let fileUrl = editDcExistingUrl;
      if (editDcFile) {
        try {
          fileUrl = await uploadFile(editDcFile, "delivery-challans");
        } catch (err) {
          toast.error(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
          return;
        }
      }

      const res = await fetch(
        `/api/procurement/orders/${id}/deliveries?delivery_id=${editDeliveryId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dc_number: editDcNumber.trim() || null,
            dc_date: editDcDate,
            file_url: fileUrl,
            notes: editDcNotes.trim() || null,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to update delivery challan");
        return;
      }

      toast.success("Delivery challan corrected");
      setActionDialog(null);
      setEditDeliveryId(null);
      setEditDcFile(null);
      if (editDcFileRef.current) editDcFileRef.current.value = "";
      await fetchPo();
    } finally {
      setEditDcSaving(false);
    }
  };

  // ── Record Service Report ──────────────────────────────────────────────────
  const submitServiceReport = async () => {
    const cycleNum = parseInt(srCycleNumber);
    if (!srCycleNumber || isNaN(cycleNum) || cycleNum < 1) {
      toast.error("Cycle number is required"); return;
    }
    if (!srPeriodFrom) { toast.error("Period start date is required"); return; }
    if (!srPeriodTo) { toast.error("Period end date is required"); return; }
    if (!srFile) { toast.error("Please upload the service report file"); return; }

    setSrUploading(true);
    try {
      let fileUrl: string;
      try {
        fileUrl = await uploadFile(srFile, "service-reports");
      } catch (err) {
        toast.error(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }

      const res = await fetch("/api/procurement/service-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          po_id: po?.id,
          cycle_number: cycleNum,
          period_from: srPeriodFrom,
          period_to: srPeriodTo,
          report_file_url: fileUrl,
          notes: srNotes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to record service report");
        return;
      }

      toast.success(`Service report for Cycle ${cycleNum} recorded`);
      setActionDialog(null);
      setSrCycleNumber("");
      setSrPeriodFrom("");
      setSrPeriodTo("");
      setSrFile(null);
      setSrNotes("");
      if (srFileRef.current) srFileRef.current.value = "";
      await fetchPo();
    } finally {
      setSrUploading(false);
    }
  };

  // ── Add Invoice (inline) ───────────────────────────────────────────────────
  const submitInvoice = async () => {
    if (invUploading) return;
    if (!invDate) { toast.error("Invoice date is required"); return; }
    if (invDate < today) { toast.error("Invoice date cannot be in the past. Please select today or a future date."); return; }
    const amount = parseFloat(invAmount);
    if (!invAmount || isNaN(amount) || amount <= 0) {
      toast.error("Invoice amount must be greater than 0");
      return;
    }
    if (!invFile) { toast.error("Please upload the vendor invoice file"); return; }
    if (po?.po_type === "service" && !invServiceReportId) {
      toast.error("Please select the service cycle this invoice covers");
      return;
    }

    // Proportionate value check for goods POs with delivery shortfall
    if (po?.po_type !== "service" && po?.purchase_order_items && po?.po_delivery_receipts) {
      const priceMap: Record<string, number> = {};
      for (const item of po.purchase_order_items) {
        priceMap[item.id] = Number(item.unit_price ?? 0);
      }
      let receivedValue = 0;
      for (const receipt of po.po_delivery_receipts) {
        for (const ri of receipt.po_delivery_receipt_items ?? []) {
          receivedValue += (priceMap[ri.po_item_id] ?? 0) * Number(ri.qty_received);
        }
      }
      if (receivedValue > 0 && receivedValue < Number(po.total_ordered_amount) && amount > receivedValue) {
        toast.error(
          `Invoice amount (${formatCurrency(amount)}) exceeds the proportionate value of goods received (${formatCurrency(receivedValue)}). Only goods worth ${formatCurrency(receivedValue)} have been received against the PO value of ${formatCurrency(po.total_ordered_amount)}.`,
          { duration: 8000 }
        );
        return;
      }
    }

    const ceiling = po?.po_type === "service" && po?.unit_cost_per_cycle
      ? Number(po.unit_cost_per_cycle)
      : Number(po?.total_ordered_amount ?? 0);
    if (ceiling > 0 && amount > ceiling) {
      toast.error(`Invoice amount cannot exceed ${po?.po_type === "service" ? "cycle cost" : "PO value"} (${formatCurrency(ceiling)})`);
      return;
    }

    setInvUploading(true);
    try {
      let fileUrl: string;
      try {
        fileUrl = await uploadFile(invFile, "vendor-invoices");
      } catch (err) {
        toast.error(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
        return;
      }

      const res = await fetch("/api/procurement/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          po_id: po?.id,
          vendor_id: po?.vendor_id,
          invoice_number: invNumber.trim() || null,
          invoice_date: invDate,
          due_date: invDueDate || null,
          total_amount: amount,
          notes: invNotes.trim() || null,
          invoice_file_url: fileUrl,
          service_report_id: invServiceReportId || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to create vendor invoice");
        return;
      }

      toast.success(`Vendor invoice recorded — ${json.data.bill_number}`);
      setActionDialog(null);
      setInvFile(null);
      setInvNumber("");
      setInvDate("");
      setInvDueDate("");
      setInvAmount("");
      setInvNotes("");
      setInvServiceReportId("");
      if (invFileRef.current) invFileRef.current.value = "";
      await fetchPo();
    } finally {
      setInvUploading(false);
    }
  };

  // ── Edit Invoice (correct a wrong invoice upload) ──────────────────────────
  const openEditInvoice = async (billId: string) => {
    setEditBillId(billId);
    setActionDialog("edit_invoice");
    setEditInvLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${billId}`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to load invoice details");
        setActionDialog(null);
        return;
      }
      const bill = json.data;
      setEditInvNumber(bill.invoice_number ?? "");
      setEditInvDate(bill.invoice_date ?? "");
      setEditInvDueDate(bill.due_date ?? "");
      setEditInvAmount(bill.total_amount != null ? String(bill.total_amount) : "");
      setEditInvNotes(bill.notes ?? "");
      setEditInvExistingUrl(bill.invoice_file_url ?? "");
      setEditInvFile(null);
    } finally {
      setEditInvLoading(false);
    }
  };

  const submitEditInvoice = async () => {
    if (!editBillId) return;
    if (!editInvDate) { toast.error("Invoice date is required"); return; }
    const amount = parseFloat(editInvAmount);
    if (!editInvAmount || isNaN(amount) || amount <= 0) {
      toast.error("Invoice amount must be greater than 0");
      return;
    }
    if (!editInvFile && !editInvExistingUrl) { toast.error("Please upload the vendor invoice file"); return; }

    setEditInvSaving(true);
    try {
      let fileUrl = editInvExistingUrl;
      if (editInvFile) {
        try {
          fileUrl = await uploadFile(editInvFile, "vendor-invoices");
        } catch (err) {
          toast.error(`File upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
          return;
        }
      }

      const res = await fetch(`/api/procurement/bills/${editBillId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit_invoice_details",
          invoice_number: editInvNumber.trim() || null,
          invoice_date: editInvDate,
          due_date: editInvDueDate || null,
          total_amount: amount,
          notes: editInvNotes.trim() || null,
          invoice_file_url: fileUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to update invoice");
        return;
      }

      toast.success("Invoice corrected");
      setActionDialog(null);
      setEditBillId(null);
      setEditInvFile(null);
      if (editInvFileRef.current) editInvFileRef.current.value = "";
      await fetchPo();
    } finally {
      setEditInvSaving(false);
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

  const vendor = po.procurement_vendors as {
    id: string; name: string;
    contact_name?: string; contact_phone?: string; contact_email?: string;
  } | null;

  const timelineItems = buildTimeline(po, auditEvents);

  // Determine if this is an AMC PO
  const isAmcPo =
    po.purchase_requests?.expenditure_type === "amc" || !!po.amc_start_date;

  const AMC_STATUS_LABELS: Record<AmcStatus, string> = {
    inactive: "Inactive", active: "Active", expiring: "Expiring Soon",
    exhausted: "Exhausted", expired: "Expired", terminated: "Terminated",
  };
  const AMC_STATUS_BADGE: Record<AmcStatus, string> = {
    inactive: "bg-gray-100 text-gray-600",
    active:   "bg-green-100 text-green-700",
    expiring: "bg-amber-100 text-amber-700",
    exhausted:"bg-red-100 text-red-700",
    expired:  "bg-red-100 text-red-600",
    terminated: "bg-rose-100 text-rose-700",
  };

  const amcStatus = (po.amc_status ?? "inactive") as AmcStatus;
  const amcVisitsUsed = po.amc_visits_used ?? 0;
  const amcVisitsCoveredNum = po.amc_visits_covered ?? null;
  const amcVisitPct = amcVisitsCoveredNum ? Math.min(100, Math.round((amcVisitsUsed / amcVisitsCoveredNum) * 100)) : 0;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: po.po_number }}
        fallbackParent={{ href: "/procurement/orders", label: "Purchase Orders" }}
      />
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
            <div className="mt-2">
              <QueryButton entityType="purchase_order" entityId={po.id} />
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap justify-end">
          {!["cancelled", "partially_cancelled"].includes(po.status) && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const { generatePurchaseOrderPDF: gen } = await import("@/lib/po-pdf-generator");
                const pdf = await gen(po as Parameters<typeof generatePurchaseOrderPDF>[0]);
                pdf.save(`${po.po_number}.pdf`);
              }}
            >
              <Download className="h-4 w-4 mr-1" /> Download PO
            </Button>
          )}
          {!["cancelled", "partially_cancelled"].includes(po.status) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const vendor = po.procurement_vendors as { contact_email?: string } | null;
                setEmailTo(vendor?.contact_email || "");
                setEmailSaveToVendor(false);
                setActionDialog("email_po");
              }}
            >
              <Mail className="h-4 w-4 mr-1" /> Email PO
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
          {["ordered", "partially_received"].includes(po.status) && po.po_type !== "service" && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700"
              onClick={() => {
                const initial: Record<string, string> = {};
                for (const item of po.purchase_order_items ?? []) initial[item.id] = "";
                setDcQtys(initial);
                setDcDate(today);
                setActionDialog("record_delivery");
              }}
              disabled={actionLoading}
            >
              <Package className="h-4 w-4 mr-1" /> Record Delivery
            </Button>
          )}
          {po.po_type === "service" && po.status === "ordered" && !po.amc_terminated_at && (
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700"
              onClick={() => {
                const nextCycle = (po.po_service_reports?.length ?? 0) + 1;
                setSrCycleNumber(String(nextCycle));
                setSrPeriodFrom("");
                setSrPeriodTo("");
                setActionDialog("record_service_report");
              }}
              disabled={actionLoading}
            >
              <ClipboardList className="h-4 w-4 mr-1" /> Record Service Report
            </Button>
          )}
          {isAmcPo && po.status === "ordered" && !po.amc_terminated_at && (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => setShowAmcEventDialog(true)}
              disabled={actionLoading}
            >
              <Wrench className="h-4 w-4 mr-1" /> Log Breakdown Visit
            </Button>
          )}
          {po.po_type !== "service" && !["cancelled", "partially_cancelled", "invoice_received"].includes(po.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setInvDate(today);
                setInvAmount(String(po.total_ordered_amount || ""));
                setActionDialog("add_invoice");
              }}
              disabled={!(po.po_delivery_receipts ?? []).length}
              title={!(po.po_delivery_receipts ?? []).length ? "Record a delivery before uploading a vendor invoice" : undefined}
            >
              <Receipt className="h-4 w-4 mr-1" /> Vendor Invoice
            </Button>
          )}
          {po.po_type === "service" && po.status === "ordered" && (() => {
            const invoicedIds = new Set((po.vendor_bills ?? []).map((b) => b.service_report_id).filter(Boolean));
            const uninvoiced = (po.po_service_reports ?? []).filter((sr) => !invoicedIds.has(sr.id));
            const cycleCap = Number(po.cycle_count ?? 0);
            const allCyclesBilled = cycleCap > 0 && (po.vendor_bills?.length ?? 0) >= cycleCap;
            // The reason a disabled button is disabled has to be readable without
            // hovering — new users otherwise read it as the feature being broken.
            const blockedReason = allCyclesBilled
              ? `All ${cycleCap} cycles invoiced`
              : uninvoiced.length === 0
                ? "Log a service report first"
                : null;
            return (
              <div className="flex flex-col items-end gap-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setInvDate(today);
                    setInvAmount(String(po.unit_cost_per_cycle || ""));
                    setActionDialog("add_invoice");
                  }}
                  disabled={blockedReason !== null}
                >
                  <Receipt className="h-4 w-4 mr-1" /> Vendor Invoice
                </Button>
                {blockedReason && (
                  <span className="text-[11px] text-muted-foreground">{blockedReason}</span>
                )}
              </div>
            );
          })()}
          {po.status === "invoice_received" && (
            <Button
              size="sm"
              variant="ghost"
              className="text-orange-600 hover:text-orange-700"
              onClick={() => {
                const initial: Record<string, string> = {};
                for (const item of po.purchase_order_items ?? []) {
                  initial[item.id] = String(item.quantity_ordered);
                }
                setPartialCancelQtys(initial);
                setActionDialog("partial_cancel");
              }}
              disabled={actionLoading}
            >
              Partial Cancel
            </Button>
          )}
          {["pending", "ordered", "partially_received", "received"].includes(po.status) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => { setForceCancelStep(1); setActionDialog("cancel"); }}
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
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-medium">
                {po.total_ordered_amount > 0 ? formatCurrency(po.total_ordered_amount) : "—"}
              </span>
            </div>
            {Number(po.total_gst_amount) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">GST</span>
                <span className="font-medium">{formatCurrency(po.total_gst_amount!)}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="text-xl font-bold">
                {formatCurrency(po.total_amount_with_gst ?? po.total_ordered_amount)}
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

      {/* Service Contract Info */}
      {po.po_type === "service" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Service Contract</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground mb-0.5">Service</p>
                <p className="font-medium">{po.purchase_order_items?.[0]?.item_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Start Date</p>
                <p className="font-medium">{po.service_start_date ? formatDate(po.service_start_date) : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Billing Cycle</p>
                <p className="font-medium">{po.billing_cycle ? BILLING_CYCLE_LABELS[po.billing_cycle] : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Total Cycles</p>
                <p className="font-medium">{po.cycle_count ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Cost per Cycle</p>
                <p className="font-medium">{po.unit_cost_per_cycle ? formatCurrency(po.unit_cost_per_cycle) : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Total Contract Value</p>
                <p className="font-medium">{po.total_ordered_amount > 0 ? formatCurrency(po.total_ordered_amount) : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Reports Filed</p>
                <p className="font-medium">{po.po_service_reports?.length ?? 0} / {po.cycle_count ?? "?"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Invoices Filed</p>
                <p className="font-medium">{po.vendor_bills?.length ?? 0} / {po.cycle_count ?? "?"}</p>
              </div>
            </div>

            <div className="mt-4">
              <ServiceBillingSteps
                billingCycle={po.billing_cycle ?? null}
                cycleCount={po.cycle_count ?? null}
                unitCostPerCycle={po.unit_cost_per_cycle ?? null}
                reportsFiled={po.po_service_reports?.length ?? 0}
                invoicesFiled={po.vendor_bills?.length ?? 0}
                isOrdered={po.status === "ordered"}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── AMC Contract Panel ─────────────────────────────────────────── */}
      {isAmcPo && (() => {
        // Lazy-load events when this section first renders
        if (!amcEventsLoaded && !amcEventsLoading) fetchAmcEvents();

        const missingInfo = !po.amc_start_date || (!po.amc_contact_name && !po.amc_helpline_number);

        // Live status — reflects today, not the day the PO was created
        const liveLc = computeAmcLifecycle({
          amc_start_date: po.amc_start_date,
          amc_end_date: po.amc_end_date,
          amc_visits_covered: po.amc_visits_covered,
          amc_visits_used: po.amc_visits_used,
          amc_terminated_at: po.amc_terminated_at,
        });
        const isTerminated = !!po.amc_terminated_at;
        const canTerminate = !isTerminated
          && po.po_type === "service"
          && (currentUserRole === "admin" || currentUserRole === "manager")
          && (liveLc.status === "active" || liveLc.status === "expiring");

        return (
          <Card className="border-blue-200">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <Wrench className="h-4 w-4 text-blue-600" />
                  <CardTitle className="text-base">AMC Contract</CardTitle>
                  <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium border ${liveLc.badgeClass}`}>
                    {liveLc.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {!amcEditMode && !isTerminated && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setAmcContactName(po.amc_contact_name ?? "");
                        setAmcHelpline(po.amc_helpline_number ?? "");
                        setAmcContactEmail(po.amc_contact_email ?? "");
                        setAmcStartDate(po.amc_start_date ?? "");
                        setAmcEndDate(po.amc_end_date ?? "");
                        setAmcUnlimited(po.amc_visits_covered == null && !!po.amc_start_date);
                        setAmcVisitsCovered(po.amc_visits_covered ? String(po.amc_visits_covered) : "");
                        setAmcEditMode(true);
                      }}
                    >
                      <Edit3 className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  )}
                  {canTerminate && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-rose-700 border-rose-200 hover:bg-rose-50"
                      onClick={() => { setTerminationReason(""); setActionDialog("terminate_amc"); }}
                    >
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Terminate AMC
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>

            <CardContent className="space-y-5">
              {/* Termination banner — supersedes everything else when AMC is terminated */}
              {isTerminated && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-rose-600 shrink-0" />
                    <p className="text-sm font-semibold text-rose-900">
                      AMC Terminated{po.amc_terminated_at ? ` on ${formatDate(po.amc_terminated_at)}` : ""}
                      {po.terminator?.full_name ? ` by ${po.terminator.full_name}` : ""}
                    </p>
                  </div>
                  {po.amc_termination_reason && (
                    <p className="text-sm text-rose-800 ml-6">{po.amc_termination_reason}</p>
                  )}
                  <p className="text-xs text-rose-700 ml-6">
                    Service events logged before termination remain on record. To resume AMC coverage, create a new Material Request.
                  </p>
                </div>
              )}

              {/* Missing info warning */}
              {!isTerminated && missingInfo && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
                  <span>
                    {!po.amc_start_date
                      ? "AMC contract dates are not set. Add start/end dates to activate tracking."
                      : "AMC contact details are missing. Add helpline/contact info before issuing."}
                  </span>
                </div>
              )}

              {/* Lifecycle strip — Created → Activates → Expires, current position highlighted */}
              {!amcEditMode && po.amc_start_date && po.amc_end_date && (
                <div className="rounded-lg border bg-muted/20 px-4 py-3">
                  <AmcLifecycleStrip
                    createdAt={po.created_at}
                    amcStartDate={po.amc_start_date}
                    amcEndDate={po.amc_end_date}
                    amcVisitsCovered={po.amc_visits_covered}
                    amcVisitsUsed={po.amc_visits_used}
                    amcTerminatedAt={po.amc_terminated_at}
                  />
                </div>
              )}

              {/* Edit form */}
              {amcEditMode ? (
                <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Contract Start Date</Label>
                      <Input type="date" value={amcStartDate} onChange={(e) => setAmcStartDate(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Contract End Date</Label>
                      <Input type="date" value={amcEndDate} onChange={(e) => setAmcEndDate(e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Visits / Calls Covered</Label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={1}
                        placeholder="e.g. 12"
                        value={amcUnlimited ? "" : amcVisitsCovered}
                        onChange={(e) => setAmcVisitsCovered(e.target.value)}
                        disabled={amcUnlimited}
                        className="w-28"
                      />
                      <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={amcUnlimited}
                          onChange={(e) => {
                            setAmcUnlimited(e.target.checked);
                            if (e.target.checked) setAmcVisitsCovered("");
                          }}
                          className="rounded"
                        />
                        Unlimited
                      </label>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">AMC Contact Name</Label>
                      <Input placeholder="e.g. Rajesh Kumar" value={amcContactName} onChange={(e) => setAmcContactName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Helpline / Support No.</Label>
                      <Input placeholder="+91 98400 12345" value={amcHelpline} onChange={(e) => setAmcHelpline(e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">AMC Contact Email</Label>
                    <Input type="email" placeholder="amc@vendor.com" value={amcContactEmail} onChange={(e) => setAmcContactEmail(e.target.value)} />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={saveAmcDetails} disabled={amcSaving}>
                      {amcSaving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      <Save className="h-3.5 w-3.5 mr-1" /> Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setAmcEditMode(false)} disabled={amcSaving}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {/* Contract period */}
                  <div className="space-y-3">
                    <div className="flex items-start gap-2.5">
                      <CalendarDays className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground mb-0.5">Contract Period</p>
                        {po.amc_start_date ? (
                          <p className="text-sm font-medium">
                            {formatDate(po.amc_start_date)} – {po.amc_end_date ? formatDate(po.amc_end_date) : "Open-ended"}
                          </p>
                        ) : (
                          <p className="text-sm text-amber-600">Not set</p>
                        )}
                      </div>
                    </div>

                    {/* Visits counter */}
                    <div className="flex items-start gap-2.5">
                      <Wrench className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs text-muted-foreground mb-1">Visits / Calls</p>
                        {amcVisitsCoveredNum === null ? (
                          <p className="text-sm font-medium">
                            {amcVisitsUsed} used · <span className="text-blue-600">∞ unlimited</span>
                          </p>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="font-medium">{amcVisitsUsed} / {amcVisitsCoveredNum} used</span>
                              <span className={amcVisitPct >= 100 ? "text-red-600 font-medium" : "text-muted-foreground"}>{amcVisitPct}%</span>
                            </div>
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${amcVisitPct >= 100 ? "bg-red-500" : amcVisitPct >= 80 ? "bg-amber-500" : "bg-green-500"}`}
                                style={{ width: `${amcVisitPct}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Contact details */}
                  <div className="space-y-3">
                    {po.amc_contact_name && (
                      <div className="flex items-center gap-2.5">
                        <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground mb-0.5">AMC Contact</p>
                          <p className="text-sm font-medium">{po.amc_contact_name}</p>
                        </div>
                      </div>
                    )}
                    {po.amc_helpline_number && (
                      <div className="flex items-center gap-2.5">
                        <Phone className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground mb-0.5">Helpline</p>
                          <a href={`tel:${po.amc_helpline_number}`} className="text-sm font-medium text-primary hover:underline">
                            {po.amc_helpline_number}
                          </a>
                        </div>
                      </div>
                    )}
                    {po.amc_contact_email && (
                      <div className="flex items-center gap-2.5">
                        <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div>
                          <p className="text-xs text-muted-foreground mb-0.5">AMC Email</p>
                          <a href={`mailto:${po.amc_contact_email}`} className="text-sm font-medium text-primary hover:underline">
                            {po.amc_contact_email}
                          </a>
                        </div>
                      </div>
                    )}
                    {!po.amc_contact_name && !po.amc_helpline_number && !po.amc_contact_email && (
                      <p className="text-sm text-muted-foreground">No contact details — click Edit to add.</p>
                    )}
                  </div>
                </div>
              )}

              {/* Service Events List */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium">Service Events</p>
                  {amcEventsLoaded && (
                    <span className="text-xs text-muted-foreground">{amcEvents.length} event{amcEvents.length !== 1 ? "s" : ""} logged</span>
                  )}
                </div>

                {amcEventsLoading ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading events...
                  </div>
                ) : amcEvents.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-center">
                    <p className="text-sm text-muted-foreground">No service events logged yet.</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Click &ldquo;Log Breakdown Visit&rdquo; at the top when a service visit happens.
                    </p>
                  </div>
                ) : (
                  <div className="relative pl-5 space-y-4">
                    <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
                    {amcEvents.map((ev) => {
                      const typeColors: Record<string, string> = {
                        breakdown: "bg-red-500",
                        preventive: "bg-green-500",
                        remote_support: "bg-blue-500",
                        annual_service: "bg-purple-500",
                      };
                      const typeLabels: Record<string, string> = {
                        breakdown: "Breakdown",
                        preventive: "Preventive Visit",
                        remote_support: "Remote Support",
                        annual_service: "Annual Service",
                      };
                      return (
                        <div key={ev.id} className="relative flex gap-3">
                          <div className={`absolute -left-5 mt-1 h-3.5 w-3.5 rounded-full border-2 border-background ${typeColors[ev.event_type] ?? "bg-gray-400"}`} />
                          <div className="ml-1 min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-medium leading-snug">
                                  #{ev.event_number} · {typeLabels[ev.event_type] ?? ev.event_type}
                                </p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {formatDate(ev.event_date)}
                                  {ev.technician_name ? ` · ${ev.technician_name}` : ""}
                                  {ev.logger?.full_name ? ` · Logged by ${ev.logger.full_name}` : ""}
                                </p>
                              </div>
                              {ev.report_file_url && (
                                <a
                                  href={ev.report_file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary hover:underline flex items-center gap-1 flex-shrink-0"
                                >
                                  <Paperclip className="h-3 w-3" /> Job Card
                                </a>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">{ev.issue_description}</p>
                            {ev.resolution_notes && (
                              <p className="text-xs text-muted-foreground mt-0.5 italic">{ev.resolution_notes}</p>
                            )}
                            {ev.next_scheduled_date && (
                              <p className="text-xs text-blue-600 mt-0.5">
                                Next visit: {formatDate(ev.next_scheduled_date)}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Advance Payment */}
      {(po.advance_amount ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Advance Payment</CardTitle>
              </div>
              <Badge
                variant="secondary"
                className={PO_ADVANCE_STATUS_COLORS[po.advance_status ?? "not_required"]}
              >
                {PO_ADVANCE_STATUS_LABELS[po.advance_status ?? "not_required"]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground mb-0.5">Amount</p>
                <p className="font-bold text-base">{formatCurrency(po.advance_amount ?? 0)}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-0.5">Mode</p>
                <p className="font-medium">{PO_ADVANCE_PAYMENT_MODE_LABELS[po.advance_payment_mode ?? ""] ?? "—"}</p>
              </div>
              {po.advance_payment_reference && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Reference</p>
                  <p className="font-medium font-mono text-xs">{po.advance_payment_reference}</p>
                </div>
              )}
              {po.advance_payment_date && (
                <div>
                  <p className="text-muted-foreground mb-0.5">Paid On</p>
                  <p className="font-medium">{formatDate(po.advance_payment_date)}</p>
                </div>
              )}
            </div>
            {po.advance_notes && (
              <p className="text-sm text-muted-foreground">{po.advance_notes}</p>
            )}
            {po.advance_status === "pending" && (() => {
              // Treat null/undefined as pending_review (schema cache lag or pre-migration rows)
              const approvalStatus = po.advance_approval_status ?? "pending_review";
              const needsApproval = approvalStatus === "pending_review";
              const isApproved = approvalStatus === "approved";
              const isAdmin = !userLoading && currentUserRole === "admin";
              return (
                <div className="pt-1 flex flex-wrap items-center gap-2">
                  {needsApproval && isAdmin && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-200 hover:bg-red-50"
                        onClick={() => setActionDialog("reject_advance")}
                        disabled={actionLoading}
                      >
                        <XCircle className="h-4 w-4 mr-1" /> Reject Advance
                      </Button>
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700"
                        onClick={() => setActionDialog("approve_advance")}
                        disabled={actionLoading}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Approve Advance
                      </Button>
                    </>
                  )}
                  {needsApproval && !isAdmin && !userLoading && (
                    <p className="text-xs text-amber-600 font-medium">Awaiting admin approval before payment can be processed</p>
                  )}
                  {isApproved && !po.amc_terminated_at && (
                    <Button
                      size="sm"
                      className="bg-orange-600 hover:bg-orange-700"
                      onClick={() => {
                        setAdvancePaymentDate(today);
                        setActionDialog("process_advance");
                      }}
                      disabled={actionLoading}
                    >
                      <CheckCircle2 className="h-4 w-4 mr-1.5" /> Process Advance Payment
                    </Button>
                  )}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

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

      {/* Service Reports */}
      {po.po_type === "service" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Service Reports</CardTitle>
              </div>
              {po.status === "ordered" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const nextCycle = (po.po_service_reports?.length ?? 0) + 1;
                    setSrCycleNumber(String(nextCycle));
                    setSrPeriodFrom("");
                    setSrPeriodTo("");
                    setActionDialog("record_service_report");
                  }}
                >
                  <ClipboardList className="h-4 w-4 mr-1" /> Record Report
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!(po.po_service_reports?.length) ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Info className="h-4 w-4 flex-shrink-0" />
                No service reports filed yet. Record a report at the end of each cycle to unlock vendor invoicing.
              </div>
            ) : (
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2.5 text-left font-medium">Cycle</th>
                      <th className="px-3 py-2.5 text-left font-medium">Period</th>
                      <th className="px-3 py-2.5 text-left font-medium hidden sm:table-cell">Recorded by</th>
                      <th className="px-3 py-2.5 text-center font-medium">Report</th>
                      <th className="px-3 py-2.5 text-center font-medium">Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(po.po_service_reports as PoServiceReport[]).map((sr) => {
                      const bill = (po.vendor_bills ?? []).find((b) => b.service_report_id === sr.id);
                      return (
                        <tr key={sr.id} className="border-b last:border-0">
                          <td className="px-3 py-2.5 font-medium">Cycle {sr.cycle_number}</td>
                          <td className="px-3 py-2.5 text-muted-foreground text-xs">
                            {formatDate(sr.period_from)} – {formatDate(sr.period_to)}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                            {sr.recorder?.full_name ?? "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {sr.report_file_url ? (
                              <a href={sr.report_file_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                                <Paperclip className="h-3 w-3" /> View
                              </a>
                            ) : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            {bill ? (
                              <div className="flex items-center justify-center gap-1">
                                <Badge variant="secondary" className="text-xs font-mono">{bill.bill_number}</Badge>
                                <Badge variant="secondary" className={`text-[10px] ${bill.approval_status === "approved" ? "bg-green-100 text-green-800" : bill.approval_status === "rejected" ? "bg-red-100 text-red-800" : "bg-yellow-100 text-yellow-800"}`}>
                                  {bill.approval_status === "approved" ? "OK" : bill.approval_status === "rejected" ? "Rejected" : "Pending"}
                                </Badge>
                              </div>
                            ) : (
                              <span className="text-xs text-amber-600">Pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
                    <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">GST%</th>
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
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                        {Number(item.quantity_received) > 0 ? (
                          <span className={
                            Number(item.quantity_received) >= Number(item.quantity_ordered)
                              ? "text-green-700 font-medium"
                              : "text-amber-700 font-medium"
                          }>
                            {item.quantity_received}
                            {Number(item.quantity_received) >= Number(item.quantity_ordered) && (
                              <CheckCircle2 className="inline h-3.5 w-3.5 ml-1 text-green-600" />
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{item.unit}</td>
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                        {item.unit_price ? formatCurrency(item.unit_price) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right hidden sm:table-cell text-muted-foreground">
                        {Number(item.gst_rate) > 0 ? `${item.gst_rate}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                        {item.total_amount
                          ? formatCurrency(Number(item.total_amount) + Number(item.gst_amount ?? 0))
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activity Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Activity</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {timelineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          ) : (
            <div className="relative pl-5">
              {/* Vertical line */}
              <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
              <div className="space-y-5">
                {timelineItems.map((item) => (
                  <div key={item.id} className="relative flex gap-3">
                    {/* Dot */}
                    <div
                      className={`absolute -left-5 mt-1 h-3.5 w-3.5 rounded-full border-2 border-background flex-shrink-0 ${TIMELINE_DOT_COLORS[item.type]}`}
                    />
                    <div className="ml-1 min-w-0">
                      <p className="text-sm font-medium leading-snug">{item.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(item.ts)} · {item.subtitle}
                      </p>
                      <div className="flex items-center gap-3 mt-1">
                        {item.fileUrl && (
                          <a
                            href={item.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <Paperclip className="h-3 w-3" />
                            {item.fileLabel ?? "View Document"}
                          </a>
                        )}
                        {item.deliveryReceiptId && !["invoice_approved", "cancelled", "partially_cancelled"].includes(po.status) && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            onClick={() => openEditDelivery(item.deliveryReceiptId!)}
                          >
                            <Edit3 className="h-3 w-3" />
                            Edit
                          </button>
                        )}
                        {item.deliveryReceiptId && ["partially_received", "received"].includes(po.status) && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700 hover:underline"
                            onClick={() => { setRejectDeliveryId(item.deliveryReceiptId!); setActionDialog("reject_delivery"); }}
                          >
                            <Undo2 className="h-3 w-3" />
                            Reject
                          </button>
                        )}
                        {item.billId && item.billApprovalStatus !== "approved" && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            onClick={() => openEditInvoice(item.billId!)}
                          >
                            <Edit3 className="h-3 w-3" />
                            Edit
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Record Service Report dialog ─────────────────────────────────── */}
      <Dialog
        open={actionDialog === "record_service_report"}
        onOpenChange={() => {
          setActionDialog(null);
          setSrFile(null);
          setSrCycleNumber("");
          setSrPeriodFrom("");
          setSrPeriodTo("");
          setSrNotes("");
          if (srFileRef.current) srFileRef.current.value = "";
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record Service Report — {po?.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Cycle # <span className="text-red-500">*</span></Label>
                <Input
                  type="number"
                  min="1"
                  placeholder="e.g. 1"
                  value={srCycleNumber}
                  onChange={(e) => setSrCycleNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Period From <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  value={srPeriodFrom}
                  onChange={(e) => setSrPeriodFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Period To <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  value={srPeriodTo}
                  onChange={(e) => setSrPeriodTo(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Service Report File <span className="text-red-500">*</span></Label>
              {srFile ? (
                <FileAttachment file={srFile} onRemove={() => { setSrFile(null); if (srFileRef.current) srFileRef.current.value = ""; }} />
              ) : (
                <FileDropzone
                  fileRef={srFileRef}
                  label="Click to upload service report (PDF, JPG, PNG — max 10 MB)"
                  required
                  onChange={setSrFile}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes about this service cycle..."
                value={srNotes}
                onChange={(e) => setSrNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setActionDialog(null);
                setSrFile(null);
                setSrCycleNumber("");
                setSrPeriodFrom("");
                setSrPeriodTo("");
                setSrNotes("");
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700"
              disabled={srUploading}
              onClick={submitServiceReport}
            >
              {srUploading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Record Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Process Advance dialog ────────────────────────────────────────── */}
      <Dialog
        open={actionDialog === "process_advance"}
        onOpenChange={() => { setActionDialog(null); setAdvancePaymentDate(today); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Process Advance Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Confirm that the advance of <strong>{formatCurrency(po.advance_amount ?? 0)}</strong> has
              been transferred to <strong>{vendor?.name}</strong>.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="adv_date">Payment Date <span className="text-red-500">*</span></Label>
              <Input
                id="adv_date"
                type="date"
                value={advancePaymentDate}
                onChange={(e) => setAdvancePaymentDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                if (!advancePaymentDate) { toast.error("Payment date is required"); return; }
                performAction("process_advance", { advance_payment_date: advancePaymentDate });
              }}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirm Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Mark as Ordered dialog ───────────────────────────────────────── */}
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

      {/* ── Approve Advance dialog ───────────────────────────────────────── */}
      <Dialog open={actionDialog === "approve_advance"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Advance Payment</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Approve the advance of <strong>{formatCurrency(po.advance_amount ?? 0)}</strong> for <strong>{po.po_number}</strong>?
            Accounts will be able to process this payment once approved.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => performAction("approve_advance")}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reject Advance dialog ────────────────────────────────────────── */}
      <Dialog open={actionDialog === "reject_advance"} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Advance Payment</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Reject the advance of <strong>{formatCurrency(po.advance_amount ?? 0)}</strong> for <strong>{po.po_number}</strong>?
            This advance will not appear in Acc Payables.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => performAction("reject_advance")}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              <XCircle className="h-4 w-4 mr-1" /> Reject Advance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Terminate AMC dialog ─────────────────────────────────────────── */}
      <Dialog
        open={actionDialog === "terminate_amc"}
        onOpenChange={() => { setActionDialog(null); setTerminationReason(""); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate AMC — {po.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="font-medium">This action cannot be undone.</p>
              <ul className="list-disc list-inside text-xs mt-1.5 space-y-0.5 text-rose-800">
                <li>No new breakdowns or service reports can be logged on this AMC</li>
                <li>Existing event history stays visible as institutional memory</li>
                <li>Pending advances will not be processed</li>
                <li>To resume AMC, create a new Material Request</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">
                Reason for termination <span className="text-rose-600">*</span>
              </Label>
              <Textarea
                rows={3}
                placeholder="e.g. Vendor failed to respond to 2 consecutive breakdown calls. Switching to a different vendor."
                value={terminationReason}
                onChange={(e) => setTerminationReason(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Minimum 10 characters. This reason will be visible on the asset page as part of its history.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setTerminationReason(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => performAction("terminate_amc", { termination_reason: terminationReason.trim() })}
              disabled={actionLoading || terminationReason.trim().length < 10}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              <XCircle className="h-4 w-4 mr-1" /> Terminate AMC
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Record Delivery dialog ───────────────────────────────────────── */}
      <Dialog
        open={actionDialog === "record_delivery"}
        onOpenChange={() => {
          setActionDialog(null);
          setDcFile(null);
          setDcQtys({});
          setDcNumber("");
          setDcNotes("");
          setDcDate("");
          if (dcFileRef.current) dcFileRef.current.value = "";
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Record Delivery — {po?.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 overflow-y-auto flex-1 min-h-0">
            {/* DC Number + Date */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>DC Number</Label>
                <Input
                  placeholder="Challan no. (optional)"
                  value={dcNumber}
                  onChange={(e) => setDcNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>DC Date <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  min={today}
                  value={dcDate}
                  onChange={(e) => setDcDate(e.target.value)}
                />
                {dcDate && dcDate < today && (
                  <p className="text-xs text-red-600">Date cannot be in the past.</p>
                )}
              </div>
            </div>

            {/* DC File */}
            <div className="space-y-1.5">
              <Label>Delivery Challan File <span className="text-red-500">*</span></Label>
              {dcFile ? (
                <FileAttachment file={dcFile} onRemove={() => { setDcFile(null); if (dcFileRef.current) dcFileRef.current.value = ""; }} />
              ) : (
                <FileDropzone
                  fileRef={dcFileRef}
                  label="Click to upload challan (PDF, JPG, PNG — max 10 MB)"
                  required
                  onChange={setDcFile}
                />
              )}
            </div>

            {/* Per-item qty table */}
            <div>
              <Label className="mb-2 block">Quantities Received <span className="text-red-500">*</span></Label>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Ordered</th>
                      <th className="px-3 py-2 text-right font-medium">Received</th>
                      <th className="px-3 py-2 text-right font-medium w-28">Receiving Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(po?.purchase_order_items ?? []).map((item) => {
                      const alreadyReceived = Number(item.quantity_received ?? 0);
                      const remaining = Number(item.quantity_ordered) - alreadyReceived;
                      return (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="px-3 py-2">
                            <p className="font-medium leading-snug">{item.item_name}</p>
                            <p className="text-xs text-muted-foreground">{item.unit}</p>
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {item.quantity_ordered}
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {alreadyReceived}
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              min="0"
                              max={remaining}
                              step="0.01"
                              className="h-8 text-right"
                              placeholder="0"
                              value={dcQtys[item.id] ?? ""}
                              onChange={(e) =>
                                setDcQtys((prev) => ({ ...prev, [item.id]: e.target.value }))
                              }
                              disabled={remaining <= 0}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes..."
                value={dcNotes}
                onChange={(e) => setDcNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setActionDialog(null);
                setDcFile(null);
                setDcQtys({});
                setDcNumber("");
                setDcNotes("");
                setDcDate("");
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              disabled={dcUploading || actionLoading}
              onClick={submitDelivery}
            >
              {(dcUploading || actionLoading) && (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              )}
              Record Delivery
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Invoice dialog (inline) ──────────────────────────────────── */}
      <Dialog
        open={actionDialog === "add_invoice"}
        onOpenChange={() => {
          setActionDialog(null);
          setInvFile(null);
          setInvNumber("");
          setInvDate("");
          setInvDueDate("");
          setInvAmount("");
          setInvNotes("");
          setInvServiceReportId("");
          if (invFileRef.current) invFileRef.current.value = "";
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Vendor Invoice — {po?.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {po && (po.po_type === "service" ? Number(po.unit_cost_per_cycle) > 0 : Number(po.total_ordered_amount) > 0) && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-sm text-blue-800">
                {po.po_type === "service"
                  ? <>Cycle cost: <strong>{formatCurrency(po.unit_cost_per_cycle ?? 0)}</strong> — invoice must not exceed this amount.</>
                  : <>PO value: <strong>{formatCurrency(po.total_ordered_amount)}</strong> — invoice must not exceed this amount.</>}
              </div>
            )}

            {po?.po_type === "service" && (() => {
              const invoicedIds = new Set((po.vendor_bills ?? []).map((b) => b.service_report_id).filter(Boolean));
              const uninvoiced = (po.po_service_reports as PoServiceReport[] | undefined ?? []).filter((sr) => !invoicedIds.has(sr.id));
              return (
                <div className="space-y-1.5">
                  <Label>Service Cycle <span className="text-red-500">*</span></Label>
                  <Select value={invServiceReportId} onValueChange={(v) => {
                    setInvServiceReportId(v);
                    if (po.unit_cost_per_cycle) setInvAmount(String(po.unit_cost_per_cycle));
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select the cycle this invoice covers" />
                    </SelectTrigger>
                    <SelectContent>
                      {uninvoiced.map((sr) => (
                        <SelectItem key={sr.id} value={sr.id}>
                          Cycle {sr.cycle_number} ({formatDate(sr.period_from)} – {formatDate(sr.period_to)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })()}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Invoice Number</Label>
                <Input
                  placeholder="Vendor's invoice #"
                  value={invNumber}
                  onChange={(e) => setInvNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Amount (₹) <span className="text-red-500">*</span></Label>
                <Input
                  type="number"
                  min="0.01"
                  max={po?.total_ordered_amount ?? undefined}
                  step="0.01"
                  placeholder="0.00"
                  value={invAmount}
                  onChange={(e) => setInvAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Date <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  min={today}
                  value={invDate}
                  onChange={(e) => setInvDate(e.target.value)}
                />
                {invDate && invDate < today && (
                  <p className="text-xs text-red-600">Date cannot be in the past.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={invDueDate}
                  onChange={(e) => setInvDueDate(e.target.value)}
                />
              </div>
            </div>

            {/* Invoice File Upload */}
            <div className="space-y-1.5">
              <Label>Invoice File <span className="text-red-500">*</span></Label>
              {invFile ? (
                <FileAttachment
                  file={invFile}
                  onRemove={() => { setInvFile(null); if (invFileRef.current) invFileRef.current.value = ""; }}
                />
              ) : (
                <FileDropzone
                  fileRef={invFileRef}
                  label="Click to upload invoice (PDF, JPG, PNG — max 10 MB)"
                  required
                  onChange={setInvFile}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea
                placeholder="Any additional notes..."
                value={invNotes}
                onChange={(e) => setInvNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setActionDialog(null);
                setInvFile(null);
                setInvNumber("");
                setInvDate("");
                setInvDueDate("");
                setInvAmount("");
                setInvNotes("");
                setInvServiceReportId("");
              }}
            >
              Cancel
            </Button>
            <Button disabled={invUploading} onClick={submitInvoice}>
              {invUploading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save Invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Delivery dialog (correct a wrong DC upload) ───────────────── */}
      <Dialog
        open={actionDialog === "edit_delivery"}
        onOpenChange={() => {
          setActionDialog(null);
          setEditDeliveryId(null);
          setEditDcFile(null);
          if (editDcFileRef.current) editDcFileRef.current.value = "";
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Delivery Challan — {po?.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              Corrects the challan on file — quantities received are unaffected. To fix a wrong
              quantity, reject this delivery and record it again.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>DC Number</Label>
                <Input
                  placeholder="Challan no. (optional)"
                  value={editDcNumber}
                  onChange={(e) => setEditDcNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>DC Date <span className="text-red-500">*</span></Label>
                <Input
                  type="date"
                  value={editDcDate}
                  onChange={(e) => setEditDcDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Delivery Challan File <span className="text-red-500">*</span></Label>
              {editDcFile ? (
                <FileAttachment
                  file={editDcFile}
                  onRemove={() => { setEditDcFile(null); if (editDcFileRef.current) editDcFileRef.current.value = ""; }}
                />
              ) : (
                <>
                  {editDcExistingUrl && (
                    <a
                      href={editDcExistingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-1.5"
                    >
                      <Paperclip className="h-3 w-3" />
                      View current file
                    </a>
                  )}
                  <FileDropzone
                    fileRef={editDcFileRef}
                    label="Click to replace with a corrected file (PDF, JPG, PNG — max 10 MB)"
                    onChange={setEditDcFile}
                  />
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes..."
                value={editDcNotes}
                onChange={(e) => setEditDcNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setActionDialog(null); setEditDeliveryId(null); setEditDcFile(null); }}
            >
              Cancel
            </Button>
            <Button disabled={editDcSaving} onClick={submitEditDelivery}>
              {editDcSaving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save Correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Invoice dialog (correct a wrong invoice upload) ───────────── */}
      <Dialog
        open={actionDialog === "edit_invoice"}
        onOpenChange={() => {
          setActionDialog(null);
          setEditBillId(null);
          setEditInvFile(null);
          if (editInvFileRef.current) editInvFileRef.current.value = "";
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Invoice — {po?.po_number}</DialogTitle>
          </DialogHeader>
          {editInvLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <p className="text-xs text-muted-foreground">
                Correcting a pending or rejected invoice. This is locked once the invoice has been
                approved for payment.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Invoice Number</Label>
                  <Input
                    placeholder="Vendor's invoice #"
                    value={editInvNumber}
                    onChange={(e) => setEditInvNumber(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Invoice Amount (₹) <span className="text-red-500">*</span></Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="0.00"
                    value={editInvAmount}
                    onChange={(e) => setEditInvAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Invoice Date <span className="text-red-500">*</span></Label>
                  <Input
                    type="date"
                    value={editInvDate}
                    onChange={(e) => setEditInvDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Due Date</Label>
                  <Input
                    type="date"
                    value={editInvDueDate}
                    onChange={(e) => setEditInvDueDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Invoice File <span className="text-red-500">*</span></Label>
                {editInvFile ? (
                  <FileAttachment
                    file={editInvFile}
                    onRemove={() => { setEditInvFile(null); if (editInvFileRef.current) editInvFileRef.current.value = ""; }}
                  />
                ) : (
                  <>
                    {editInvExistingUrl && (
                      <a
                        href={editInvExistingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline mb-1.5"
                      >
                        <Paperclip className="h-3 w-3" />
                        View current file
                      </a>
                    )}
                    <FileDropzone
                      fileRef={editInvFileRef}
                      label="Click to replace with a corrected file (PDF, JPG, PNG — max 10 MB)"
                      onChange={setEditInvFile}
                    />
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  placeholder="Any additional notes..."
                  value={editInvNotes}
                  onChange={(e) => setEditInvNotes(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setActionDialog(null); setEditBillId(null); setEditInvFile(null); }}
            >
              Cancel
            </Button>
            <Button disabled={editInvSaving || editInvLoading} onClick={submitEditInvoice}>
              {editInvSaving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save Correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Cancel dialog (delivery-aware) ──────────────────────────────── */}
      <Dialog open={actionDialog === "cancel"} onOpenChange={() => { setActionDialog(null); setForceCancelStep(1); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Purchase Order</DialogTitle>
          </DialogHeader>

          {(() => {
            const receivedItems = (po.purchase_order_items ?? []).filter(
              (i) => Number(i.quantity_received) > 0
            );
            const hasDeliveries = receivedItems.length > 0;

            // Simple cancel — no deliveries
            if (!hasDeliveries) {
              return (
                <>
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
                </>
              );
            }

            // Step 1: Warning about received goods
            if (forceCancelStep === 1) {
              return (
                <div className="space-y-4 py-2">
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                      <p className="text-sm font-medium text-amber-800">This PO has received goods</p>
                    </div>
                    <div className="rounded border border-amber-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-amber-100/50 border-b border-amber-200">
                            <th className="px-3 py-1.5 text-left font-medium text-amber-900">Item</th>
                            <th className="px-3 py-1.5 text-right font-medium text-amber-900">Received</th>
                          </tr>
                        </thead>
                        <tbody>
                          {receivedItems.map((item) => (
                            <tr key={item.id} className="border-b border-amber-200 last:border-0">
                              <td className="px-3 py-1.5 text-amber-900">{item.item_name}</td>
                              <td className="px-3 py-1.5 text-right text-amber-900">
                                {item.quantity_received} {item.unit}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-amber-700">
                      Rejecting deliveries first is recommended to avoid inventory imbalance.
                    </p>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => { setActionDialog(null); setForceCancelStep(1); }}
                    >
                      Reject Deliveries First
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setForceCancelStep(2)}
                    >
                      Cancel Anyway
                    </Button>
                  </DialogFooter>
                </div>
              );
            }

            // Step 2: Final force-cancel confirmation
            return (
              <div className="space-y-4 py-2">
                <div className="rounded-md border border-red-300 bg-red-50 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-red-800">Inventory imbalance warning</p>
                      <p className="text-xs text-red-700">
                        Cancelling with received goods means you have inventory that will never be billed.
                        This creates an accounting discrepancy that must be resolved manually.
                      </p>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setForceCancelStep(1)}>Go Back</Button>
                  <Button
                    variant="destructive"
                    onClick={() => performAction("cancel", { force: true })}
                    disabled={actionLoading}
                  >
                    {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    Yes, Force Cancel
                  </Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Email PO dialog ─────────────────────────────────────────────────── */}
      <Dialog
        open={actionDialog === "email_po"}
        onOpenChange={() => { setActionDialog(null); setEmailTo(""); setEmailSaveToVendor(false); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Email Purchase Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!(po.procurement_vendors as { contact_email?: string } | null)?.contact_email && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm text-amber-800">
                  No email address on file for this vendor. Enter one below.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email-to">Recipient Email</Label>
              <Input
                id="email-to"
                type="email"
                placeholder="vendor@example.com"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
              />
            </div>
            {!(po.procurement_vendors as { contact_email?: string } | null)?.contact_email && emailTo && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={emailSaveToVendor}
                  onChange={(e) => setEmailSaveToVendor(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Save this email to vendor for future use
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              The PO PDF will be generated and sent as an attachment.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setEmailTo(""); }}>Cancel</Button>
            <Button
              disabled={emailSending || !emailTo.trim()}
              onClick={async () => {
                const email = emailTo.trim();
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                  toast.error("Please enter a valid email address");
                  return;
                }
                setEmailSending(true);
                try {
                  const { generatePurchaseOrderPDF: gen } = await import("@/lib/po-pdf-generator");
                  const pdf = await gen(po as Parameters<typeof generatePurchaseOrderPDF>[0]);
                  const pdfBlob = pdf.output("blob");
                  const formData = new FormData();
                  formData.append("recipients", JSON.stringify([email]));
                  formData.append("pdf", new File([pdfBlob], `${po.po_number}.pdf`, { type: "application/pdf" }));
                  if (emailSaveToVendor) formData.append("save_email", "true");
                  const res = await fetch(`/api/procurement/orders/${id}/email`, {
                    method: "POST",
                    body: formData,
                  });
                  const json = await res.json();
                  if (!res.ok) {
                    toast.error(json.error || "Failed to send email");
                    return;
                  }
                  toast.success(`PO emailed to ${email}`);
                  setActionDialog(null);
                  setEmailTo("");
                  setEmailSaveToVendor(false);
                  if (emailSaveToVendor) fetchPo(); // Refresh to show updated vendor email
                } catch {
                  toast.error("Failed to send email");
                } finally {
                  setEmailSending(false);
                }
              }}
            >
              {emailSending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Send Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reject Delivery confirmation dialog ────────────────────────────── */}
      <Dialog
        open={actionDialog === "reject_delivery" && !!rejectDeliveryId}
        onOpenChange={() => { setActionDialog(null); setRejectDeliveryId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Delivery</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will reverse the received quantities from this delivery and delete the delivery record.
            This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setRejectDeliveryId(null); }}>
              Keep Delivery
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejectDeliveryId && rejectDelivery(rejectDeliveryId)}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Yes, Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Partial Cancel dialog ─────────────────────────────────────────── */}
      <Dialog
        open={actionDialog === "partial_cancel"}
        onOpenChange={() => { setActionDialog(null); setPartialCancelQtys({}); }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Partial Cancel — {po?.po_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Enter the quantity actually delivered. Undelivered quantities are released back to the PR.
            </p>
            {hasBill && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                A vendor bill exists for this PO. Partial cancellation does not modify the bill — adjust it separately.
              </p>
            )}
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium w-32">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {(po?.purchase_order_items ?? []).map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-medium">{item.item_name}</p>
                        <p className="text-xs text-muted-foreground">{item.unit}</p>
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{item.quantity_ordered}</td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          max={item.quantity_ordered}
                          step="0.01"
                          className="h-8 text-right"
                          value={partialCancelQtys[item.id] ?? String(item.quantity_ordered)}
                          onChange={(e) => setPartialCancelQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              Once partially cancelled, this PO cannot be reissued.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setPartialCancelQtys({}); }}>Keep Order</Button>
            <Button
              variant="destructive"
              disabled={actionLoading}
              onClick={() => {
                const confirmed_items = (po?.purchase_order_items ?? []).map((item) => ({
                  po_item_id: item.id,
                  confirmed_qty: parseFloat(partialCancelQtys[item.id] ?? String(item.quantity_ordered)),
                }));
                for (const ci of confirmed_items) {
                  if (isNaN(ci.confirmed_qty) || ci.confirmed_qty < 0) {
                    toast.error("All quantities must be valid non-negative numbers");
                    return;
                  }
                  const orig = po?.purchase_order_items?.find((i) => i.id === ci.po_item_id);
                  if (orig && ci.confirmed_qty > Number(orig.quantity_ordered)) {
                    toast.error(`Confirmed qty for "${orig.item_name}" exceeds ordered qty`);
                    return;
                  }
                }
                performAction("partial_cancel", { confirmed_items });
              }}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirm Partial Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AMC Service Event Dialog */}
      {isAmcPo && (
        <AmcEventDialog
          open={showAmcEventDialog}
          onOpenChange={setShowAmcEventDialog}
          poId={po.id}
          eventNumber={(amcEvents.length) + 1}
          visitsCovered={amcVisitsCoveredNum}
          visitsUsed={amcVisitsUsed}
          defaultAssetId={po.linked_asset_id ?? null}
          onSuccess={() => {
            setAmcEventsLoaded(false);
            fetchAmcEvents();
            fetchPo();
          }}
        />
      )}
    </div>
  );
}
