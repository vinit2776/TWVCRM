"use client";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, CheckCircle, XCircle, RefreshCcw, Loader2,
  Building2, MapPin, User, Calendar, FileText, PackageOpen, ShoppingCart, ShieldCheck,
  Activity, ArrowRight, Receipt, Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { ItemHistoryDialog } from "@/components/procurement/item-history-dialog";
import { MaterialRequestQuotations } from "@/components/procurement/material-request-quotations";
import { ReimbursementSupportingDocuments } from "@/components/procurement/reimbursement-supporting-documents";
import { BillCustomerDialog } from "@/components/procurement/bill-customer-dialog";
import { CorrectDepartmentDialog } from "@/components/procurement/correct-department-dialog";
import {
  PR_STATUS_LABELS, PR_STATUS_COLORS, MR_EDITABLE_STATUSES,
  PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
  PROCUREMENT_APPROVAL_THRESHOLDS,
  PO_STATUS_LABELS, PO_STATUS_COLORS,
  BILL_APPROVAL_STATUS_LABELS, BILL_APPROVAL_STATUS_COLORS,
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  EXPENDITURE_TYPE_LABELS, EXPENDITURE_TYPE_COLORS,
  BILLING_STATEMENT_STATUS_LABELS, BILLING_STATEMENT_STATUS_COLORS,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatDate, formatDateTime, formatCurrency } from "@/lib/utils";
import { cycleFromUnit, CYCLE_UNIT_LABEL } from "@/lib/procurement/amc-billing";
import type { PurchaseRequest } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { QueryButton } from "@/components/queries/query-button";

type ActionType = "approve" | "reject" | "cancel" | "submit" | "resubmit";

// ─── Lifecycle types ──────────────────────────────────────────────────────────

interface LinkedPo {
  id: string;
  po_number: string;
  po_type: string;
  status: string;
  total_amount?: number;
  created_at: string;
  procurement_vendors?: { id: string; name: string } | null;
  po_delivery_receipts?: Array<{ id: string; status: string; received_at: string }>;
  po_service_reports?: Array<{ id: string; service_date: string }>;
  vendor_bills?: Array<{ id: string; bill_number: string; approval_status: string; payment_status: string; total_amount?: number }>;
}

interface AuditEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  created_at: string;
  performer?: { id: string; full_name?: string } | null;
}

interface LifecycleData {
  mr: { id: string; pr_number: string; status: string; created_at: string; approved_at?: string; rejection_reason?: string };
  linked_pos: LinkedPo[];
  audit_trail: AuditEvent[];
}

// ─── Lifecycle stage definitions ─────────────────────────────────────────────

const LIFECYCLE_STAGES = [
  "MR Raised",
  "Submitted for Approval",
  "Approved",
  "Purchase Order(s) Created",
  "Order(s) Dispatched / Service In Progress",
  "Goods Received / Service Completed",
  "Invoice / Bill Received",
  "Bill Approved",
  "Payment Processed",
] as const;

type StageStatus = "completed" | "current" | "pending" | "stopped";

function computeStageStatuses(lc: LifecycleData): StageStatus[] {
  const { mr, linked_pos } = lc;
  const isStopped = mr.status === "rejected" || mr.status === "cancelled";

  const checks: boolean[] = [
    // 1. MR Raised — always done
    true,
    // 2. Submitted for Approval
    mr.status !== "draft",
    // 3. Approved
    ["approved", "partially_ordered", "po_created"].includes(mr.status) && !!mr.approved_at,
    // 4. PO Created
    linked_pos.length > 0,
    // 5. Order Dispatched
    linked_pos.some((p) =>
      ["ordered", "partially_received", "received", "invoice_received", "invoice_approved"].includes(p.status)
    ),
    // 6. Goods/Service Completed
    linked_pos.some(
      (p) =>
        (p.po_delivery_receipts ?? []).some((dr) => dr.status === "received") ||
        (p.po_service_reports ?? []).length > 0
    ),
    // 7. Bill Received
    linked_pos.some((p) => (p.vendor_bills ?? []).length > 0),
    // 8. Bill Approved
    linked_pos.some((p) =>
      (p.vendor_bills ?? []).some((b) => b.approval_status === "approved")
    ),
    // 9. Payment Processed
    linked_pos.some((p) =>
      (p.vendor_bills ?? []).some((b) => b.payment_status === "paid")
    ),
  ];

  if (isStopped) {
    // Find furthest completed index, mark as stopped from first false after that
    const lastTrue = checks.lastIndexOf(true);
    return checks.map((v, i) => {
      if (i <= lastTrue && v) return "stopped";
      return "pending";
    });
  }

  // Find first false → that becomes "current", everything before is "completed", after is "pending"
  const firstFalse = checks.indexOf(false);
  if (firstFalse === -1) {
    // All done
    return checks.map(() => "completed");
  }
  return checks.map((v, i) => {
    if (i < firstFalse) return "completed";
    if (i === firstFalse) return "current";
    return "pending";
  });
}

// ─── Audit field humanizer ────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  rejection_reason: "Reason",
  payment_status: "Payment",
  approval_status: "Approval",
  amount_paid: "Amount Paid",
};

function humanizeAction(action: string): string {
  if (action === "create") return "Created";
  if (action === "update") return "Updated";
  if (action === "delete") return "Deleted";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function humanizeValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "string") return val.replace(/_/g, " ");
  return String(val);
}

// ─── Entity dot colors ────────────────────────────────────────────────────────

function entityDotClass(entityType: string): string {
  if (entityType === "purchase_request") return "bg-blue-500";
  if (entityType === "purchase_order") return "bg-purple-500";
  if (entityType === "vendor_bill") return "bg-green-500";
  return "bg-gray-400";
}

function entityBadgeClass(entityType: string): string {
  if (entityType === "purchase_request") return "bg-blue-100 text-blue-800";
  if (entityType === "purchase_order") return "bg-purple-100 text-purple-800";
  if (entityType === "vendor_bill") return "bg-green-100 text-green-800";
  return "bg-gray-100 text-gray-700";
}

// ─── Activity log noise reduction ────────────────────────────────────────────
// Every page load logs a "view" event, including the detail page's own
// refetch right after one of its own mutations — so a single real action
// (e.g. "Updated: status") is immediately followed by a same-user "view" that
// carries no new information. Consecutive "view" events on the same entity
// are collapsed into one summary row so genuine changes aren't buried under
// them.

type DisplayAuditEvent =
  | { kind: "single"; event: AuditEvent }
  | {
      kind: "view-group";
      id: string;
      entity_type: string;
      entity_label: string;
      count: number;
      performers: string[];
      last_created_at: string;
    };

function buildDisplayAuditEvents(events: AuditEvent[]): DisplayAuditEvent[] {
  // Drop a "view" that immediately follows a real action by the same person
  // on the same entity — that's the page's own post-mutation refetch, not a
  // second look.
  const filtered: AuditEvent[] = [];
  for (const ev of events) {
    const prev = filtered[filtered.length - 1];
    const isSelfRefetch =
      ev.action === "view" &&
      prev &&
      prev.action !== "view" &&
      prev.entity_id === ev.entity_id &&
      prev.performer?.id === ev.performer?.id;
    if (!isSelfRefetch) filtered.push(ev);
  }

  // Collapse remaining consecutive "view" events on the same entity into one row.
  const result: DisplayAuditEvent[] = [];
  let i = 0;
  while (i < filtered.length) {
    const ev = filtered[i];
    if (ev.action !== "view") {
      result.push({ kind: "single", event: ev });
      i++;
      continue;
    }
    let j = i;
    const performers = new Set<string>();
    while (j < filtered.length && filtered[j].action === "view" && filtered[j].entity_id === ev.entity_id) {
      performers.add(filtered[j].performer?.full_name ?? "Unknown");
      j++;
    }
    const count = j - i;
    if (count === 1) {
      result.push({ kind: "single", event: ev });
    } else {
      result.push({
        kind: "view-group",
        id: `view-group-${ev.id}`,
        entity_type: ev.entity_type,
        entity_label: ev.entity_label,
        count,
        performers: Array.from(performers),
        last_created_at: filtered[j - 1].created_at,
      });
    }
    i = j;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────────────────────

export default function PurchaseRequestDetailPage() {
  const { user } = useCurrentUser();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const userRole = user?.role ?? "";
  const [pr, setPr] = useState<PurchaseRequest | null>(null);
  const [approvalThreshold, setApprovalThreshold] = useState<number>(PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog state
  const [actionDialog, setActionDialog] = useState<ActionType | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  // Admin-only override for approving without a vendor quotation attached (repeat / pre-approved orders)
  const [quotationOverrideReason, setQuotationOverrideReason] = useState("");
  // Edit-prices-and-resubmit (only available on rejected MRs)
  const [editPricesOpen, setEditPricesOpen] = useState(false);
  // Bill Customer (reimbursement department only)
  const [billCustomerOpen, setBillCustomerOpen] = useState(false);
  // Correct Department (admin-only)
  const [correctDeptOpen, setCorrectDeptOpen] = useState(false);
  // Keyed by line item id → string (so empty input is preserved)
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});

  // Lifecycle state
  const [lifecycle, setLifecycle] = useState<LifecycleData | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);

  // Budget check state
  type CenterBudgetCheck = {
    location_id: string;
    location_name: string | null;
    monthly_budget: number;
    spent_so_far: number;
    this_mr_amount: number;
    projected_total: number;
    remaining_before_mr: number;
    is_over_budget: boolean;
    over_by: number;
    utilisation_before: number;
    utilisation_after: number;
  };
  type BudgetCheck = {
    has_budget: boolean;
    monthly_budget?: number;
    spent_so_far?: number;
    this_mr_amount?: number;
    projected_total?: number;
    remaining_before_mr?: number;
    is_over_budget?: boolean;
    over_by?: number;
    utilisation_before?: number;
    utilisation_after?: number;
    center?: CenterBudgetCheck | null;
  };
  const [budgetCheck, setBudgetCheck] = useState<BudgetCheck | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);

  const fetchPr = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/requests/${id}`);
    if (res.ok) {
      const json = await res.json();
      setPr(json.data);
      if (typeof json.approval_threshold === "number") setApprovalThreshold(json.approval_threshold);
    } else {
      toast.error("Failed to load material request");
      router.push("/procurement/requests");
    }
    setLoading(false);
  }, [id, router]);

  // Only admins and managers are approvers — budget info is never shown to MR creators/requesters
  const isApprover = ["admin", "manager"].includes(userRole);
  const hasNoQuotations = (pr?.material_request_quotations?.length ?? 0) === 0;
  const canBillCustomer =
    pr?.department === "reimbursement" &&
    !!pr?.approved_at &&
    ["admin", "manager", "accounts"].includes(userRole);

  const openApproveDialog = useCallback(async () => {
    setActionDialog("approve");
    // AMC MRs bypass budget — no need to fetch budget check
    if (!pr || !isApprover || pr.expenditure_type === "amc") return;
    setBudgetLoading(true);
    const locationParam = pr.location_id ? `&location_id=${pr.location_id}` : "";
    const res = await fetch(
      `/api/procurement/budget/check?department=${pr.department}&amount=${pr.total_estimated_amount ?? 0}${locationParam}`
    );
    if (res.ok) {
      const data = await res.json();
      setBudgetCheck(data);
    }
    setBudgetLoading(false);
  }, [pr, isApprover]);

  useEffect(() => { fetchPr(); }, [fetchPr]);

  // Fetch lifecycle after PR loads
  useEffect(() => {
    if (!pr) return;
    setLifecycleLoading(true);
    fetch(`/api/procurement/requests/${id}/lifecycle`)
      .then((r) => r.json())
      .then((j) => { if (j.mr) setLifecycle(j); })
      .finally(() => setLifecycleLoading(false));
  }, [pr, id]);

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
        if (json.budget_exceeded) {
          toast.error(`Budget exceeded — only admin can approve. ${json.error}`);
        } else {
          toast.error(json.error || "Action failed");
        }
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
      setQuotationOverrideReason("");
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

  const canSeePrices = ["admin", "manager"].includes(userRole);
  // Everything on an MR stays editable until it's approved — see MR_EDITABLE_STATUSES.
  const canEditRequest =
    MR_EDITABLE_STATUSES.includes(pr.status) &&
    ["admin", "manager", "office_admin"].includes(userRole);
  const isLargeAmount = pr.total_estimated_amount > approvalThreshold;
  const showOrderedCols = ["approved", "partially_ordered", "po_created"].includes(pr.status);

  // Lifecycle derived data
  const displayAuditEvents = lifecycle ? buildDisplayAuditEvents(lifecycle.audit_trail) : [];
  const stageStatuses = lifecycle ? computeStageStatuses(lifecycle) : null;
  const nextStageIdx = stageStatuses ? stageStatuses.indexOf("current") : -1;
  const isMrTerminated = pr.status === "rejected" || pr.status === "cancelled";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <PageBreadcrumb
        current={{ label: pr.pr_number }}
        fallbackParent={{ href: "/procurement/requests", label: "Material Requests" }}
      />
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
              <QueryButton entityType="purchase_request" entityId={pr.id} />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className={PROCUREMENT_DEPARTMENT_COLORS[pr.department]}>
                {PROCUREMENT_DEPARTMENT_LABELS[pr.department]}
              </Badge>
              {/* Quick department fix for approved MRs. Before approval the full
                  "Edit Request" editor covers this, so don't offer two paths. */}
              {userRole === "admin" && !canEditRequest && !["cancelled", "rejected"].includes(pr.status) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-muted-foreground hover:text-foreground"
                  title="Correct department"
                  onClick={() => setCorrectDeptOpen(true)}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
              {pr.expenditure_type && pr.expenditure_type !== "operational" && (
                <Badge variant="secondary" className={EXPENDITURE_TYPE_COLORS[pr.expenditure_type] ?? "bg-gray-100 text-gray-800"}>
                  {EXPENDITURE_TYPE_LABELS[pr.expenditure_type]}
                </Badge>
              )}
              {canSeePrices && isLargeAmount && pr.status === "submitted" && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs">
                  Requires admin approval
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* An approved multi-cycle AMC is the point people get stuck: the request is
            done, but nothing about it says the recurring invoices live on the PO. */}
        {pr.department === "amc" && ["approved", "partially_ordered"].includes(pr.status) && (() => {
          const amcItem = pr.purchase_request_items?.[0];
          const cycle = cycleFromUnit(amcItem?.unit);
          const cycles = Number(amcItem?.quantity ?? 1);
          if (cycles <= 1) return null;
          return (
            <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-2.5 text-sm">
              <p className="font-medium text-blue-900">
                Next step: create the Purchase Order
              </p>
              <p className="text-xs text-blue-800 mt-0.5">
                This is a {CYCLE_UNIT_LABEL[cycle]}ly contract — {cycles} payments of{" "}
                {amcItem?.estimated_price ? formatCurrency(Number(amcItem.estimated_price)) : "the agreed amount"}{" "}
                per {CYCLE_UNIT_LABEL[cycle]}. Service reports and vendor invoices are
                recorded on the Purchase Order, once per {CYCLE_UNIT_LABEL[cycle]} — not on this request.
              </p>
            </div>
          );
        })()}

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap justify-end">
          {["approved", "partially_ordered"].includes(pr.status) && (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => router.push(
                pr.department === "amc"
                  ? `/procurement/orders/new-service?from_mr=${pr.id}`
                  : `/procurement/orders/new?pr_id=${pr.id}`
              )}
            >
              <ShoppingCart className="h-4 w-4 mr-1" /> Create PO
            </Button>
          )}
          {["partially_ordered", "po_created"].includes(pr.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/procurement/orders?pr_id=${pr.id}`)}
            >
              <ShoppingCart className="h-4 w-4 mr-1" /> View Orders
            </Button>
          )}
          {canEditRequest && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/procurement/requests/${pr.id}/edit`)}
              disabled={actionLoading}
            >
              <Pencil className="h-4 w-4 mr-1" /> Edit Request
            </Button>
          )}
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
          {canBillCustomer && (
            <Button
              size="sm"
              variant="default"
              className="bg-pink-600 hover:bg-pink-700"
              onClick={() => setBillCustomerOpen(true)}
            >
              <Receipt className="h-4 w-4 mr-1" /> Bill Customer
            </Button>
          )}
          {pr.status === "submitted" && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700"
                onClick={openApproveDialog}
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
              onClick={() => {
                // Seed the editor with current prices so the user only changes what's wrong.
                const seed: Record<string, string> = {};
                for (const it of pr.purchase_request_items ?? []) {
                  seed[it.id] = it.estimated_price != null ? String(it.estimated_price) : "";
                }
                setPriceEdits(seed);
                setEditPricesOpen(true);
              }}
              disabled={actionLoading}
            >
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCcw className="h-4 w-4 mr-1" />}
              Edit prices & resubmit
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
        <Card className="border-red-300 bg-red-50 ring-1 ring-red-200">
          <CardContent className="pt-4 pb-4 flex gap-3">
            <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-800 uppercase tracking-wide">
                ⚠ Request Rejected
              </p>
              <p className="text-sm text-red-900 mt-1.5 font-medium leading-relaxed">
                {pr.rejection_reason}
              </p>
              {pr.approver && (
                <p className="text-xs text-red-600 mt-2">
                  Rejected by{" "}
                  <span className="font-medium">
                    {pr.approver.full_name ?? pr.approver.email}
                  </span>
                  {pr.approved_at ? ` on ${formatDate(pr.approved_at)}` : ""}
                </p>
              )}
              <p className="text-xs text-red-600 mt-1">
                Please address the issue and resubmit the request.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Approval callout */}
      {(["approved", "partially_ordered", "po_created"].includes(pr.status)) && pr.approver && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="pt-4 flex gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-green-800">Approved</p>
              <p className="text-sm text-green-700 mt-0.5">
                By {pr.approver.full_name ?? pr.approver.email}
                {pr.approved_at ? ` on ${formatDate(pr.approved_at)}` : ""}
              </p>
              {pr.approval_code && (
                <p className="text-xs text-green-700 mt-1 font-mono font-medium">
                  Approval Ref: {pr.approval_code}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reimbursement: billed-to-customer rollup */}
      {pr.department === "reimbursement" && (
        <Card className="border-pink-200 bg-pink-50/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-pink-800">
              <Receipt className="h-4 w-4" /> Billed to Customer
              {pr.billable_contract && (
                <span className="font-normal text-pink-700">
                  — {pr.billable_contract.contract_number}
                  {pr.billable_contract.lead
                    ? ` (${pr.billable_contract.lead.company || `${pr.billable_contract.lead.first_name} ${pr.billable_contract.lead.last_name}`})`
                    : ""}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(() => {
              const activeStatements = (pr.reimbursement_statements ?? []).filter((s) => !s.voided_at);
              const totalBilled = activeStatements.reduce((sum, s) => sum + Number(s.total_amount ?? 0), 0);
              return (
                <>
                  <p className="text-sm text-pink-900">
                    <span className="font-semibold">{formatCurrency(totalBilled)}</span> billed so far
                    {" · "}MR estimate: {formatCurrency(pr.total_estimated_amount)}
                  </p>
                  {activeStatements.length > 0 ? (
                    <div className="space-y-1">
                      {activeStatements.map((s) => (
                        <div key={s.id} className="flex items-center justify-between text-xs bg-white/70 rounded px-2 py-1.5 border border-pink-100">
                          <Link
                            href={`/api/billing-statements/${s.id}/${s.gst_invoice_number ? "gst-invoice-pdf" : "proforma-pdf"}`}
                            target="_blank"
                            className="font-mono text-pink-900 hover:underline"
                          >
                            {s.statement_number}
                          </Link>
                          <Badge className={BILLING_STATEMENT_STATUS_COLORS[s.status] ?? ""} variant="secondary">
                            {BILLING_STATEMENT_STATUS_LABELS[s.status] ?? s.status}
                          </Badge>
                          <ReimbursementSupportingDocuments
                            statementId={s.id}
                            count={s.supporting_documents?.length ?? 0}
                          />
                          <span className="font-medium">{formatCurrency(s.total_amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-pink-600">Not billed yet.</p>
                  )}
                </>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Partially Ordered callout */}
      {pr.status === "partially_ordered" && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="pt-4 flex gap-3">
            <ShoppingCart className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">Partially Ordered</p>
              <p className="text-sm text-amber-700 mt-0.5">
                Some items have been ordered. Remaining approved quantities are available for additional purchase orders.{" "}
                <Link href={`/procurement/orders?pr_id=${pr.id}`} className="underline font-medium">
                  View existing orders
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* PO created callout */}
      {pr.status === "po_created" && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="pt-4 flex gap-3">
            <ShoppingCart className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-blue-800">Purchase Order Created</p>
              <p className="text-sm text-blue-700 mt-0.5">
                All approved quantities have been ordered.{" "}
                <Link href={`/procurement/orders?pr_id=${pr.id}`} className="underline font-medium">
                  View Orders
                </Link>
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
            {pr.approval_code && (
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Approval Code: </span>
                  <span className="font-mono font-medium">{pr.approval_code}</span>
                </span>
              </div>
            )}
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

        {canSeePrices ? (
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
                  Amount exceeds ₹{approvalThreshold.toLocaleString()} — admin approval required
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Line items</span>
                <span>{pr.purchase_request_items?.length ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Line items</span>
                <span>{pr.purchase_request_items?.length ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Vendor Quotations / Estimates */}
      <MaterialRequestQuotations prId={pr.id} prStatus={pr.status} />

      {/* AMC Service Block — replaces Items Requested when department=amc */}
      {pr.department === "amc" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">AMC Service Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              <div>
                <p className="text-xs text-muted-foreground">Asset</p>
                <p className="font-medium">
                  {pr.linked_asset
                    ? `${pr.linked_asset.name}${pr.linked_asset.asset_code ? ` (${pr.linked_asset.asset_code})` : ""}`
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Service / Contract</p>
                <p className="font-medium">{pr.service_item_name ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Coverage</p>
                <p className="font-medium">{pr.amc_coverage_type === "labour_only" ? "Labour-only" : pr.amc_coverage_type === "comprehensive" ? "Comprehensive (labour + parts)" : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Visits Covered</p>
                <p className="font-medium">{pr.amc_visits_covered ?? "Unlimited"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Start Date</p>
                <p className="font-medium">{pr.amc_start_date ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">End Date</p>
                <p className="font-medium">{pr.amc_end_date ?? "—"}</p>
              </div>
              {(() => {
                const amcItem = pr.purchase_request_items?.[0];
                const cycle = cycleFromUnit(amcItem?.unit);
                const cycles = Number(amcItem?.quantity ?? 1);
                return (
                  <div>
                    <p className="text-xs text-muted-foreground">Billing Cycle</p>
                    <p className="font-medium">
                      {BILLING_CYCLE_LABELS[cycle]}
                      {cycles > 1 && ` · ${cycles} cycles`}
                    </p>
                  </div>
                );
              })()}
              {canSeePrices && (
                <div className="sm:col-span-2">
                  <p className="text-xs text-muted-foreground">
                    {(() => {
                      const cycles = Number(pr.purchase_request_items?.[0]?.quantity ?? 1);
                      return cycles > 1 ? "Total Contract Value (pre-GST)" : "Annual Amount (pre-GST)";
                    })()}
                  </p>
                  <p className="font-bold text-base">{formatCurrency(pr.total_estimated_amount ?? 0)}</p>
                </div>
              )}
            </div>

            <div className="border-t pt-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Vendor Service Contacts</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">L1 Primary</p>
                  <p className="font-medium">{pr.amc_contact_name ?? "—"}</p>
                  <p className="text-xs">{pr.amc_helpline_number ?? ""}</p>
                  <p className="text-xs text-muted-foreground">{pr.amc_contact_email ?? ""}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">L2 Escalation</p>
                  <p className="font-medium">{pr.amc_escalation_name ?? "—"}</p>
                  <p className="text-xs">{pr.amc_escalation_phone ?? ""}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">L3 Escalation</p>
                  <p className="font-medium">{pr.amc_escalation2_name ?? "—"}</p>
                  <p className="text-xs">{pr.amc_escalation2_phone ?? ""}</p>
                </div>
              </div>
            </div>

            {(pr.advance_amount ?? 0) > 0 && (
              <div className="border-t pt-3">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Advance Requested</p>
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span className="text-sm">Amount: <span className="font-semibold">{formatCurrency(pr.advance_amount ?? 0)}</span></span>
                  <span className="text-sm">Mode: <span className="font-medium">{pr.advance_payment_mode?.toUpperCase() ?? "—"}</span></span>
                </div>
                {pr.advance_notes && <p className="text-xs text-muted-foreground mt-1">{pr.advance_notes}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Line Items — hidden for AMC; AMC has its own block above */}
      {pr.department !== "amc" && (
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
                    {canSeePrices && <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Est. Price</th>}
                    {canSeePrices && <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Line Total</th>}
                    {showOrderedCols && (
                      <>
                        <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Ordered</th>
                        <th className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">Remaining</th>
                      </>
                    )}
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
                          {item.procurement_items?.description && (
                            <p className="text-xs text-blue-600 mt-0.5 italic">
                              {item.procurement_items.description}
                            </p>
                          )}
                          {item.item_id && (
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">
                                Catalog
                              </Badge>
                              <ItemHistoryDialog itemId={item.item_id} itemName={item.item_name} />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">{item.quantity}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{item.unit}</td>
                      {canSeePrices && (
                        <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                          {item.estimated_price ? formatCurrency(item.estimated_price) : "—"}
                        </td>
                      )}
                      {canSeePrices && (
                        <td className="px-3 py-2.5 text-right font-medium hidden sm:table-cell">
                          {item.total_estimated ? formatCurrency(item.total_estimated) : "—"}
                        </td>
                      )}
                      {showOrderedCols && (
                        <>
                          <td className="px-3 py-2.5 text-right hidden sm:table-cell text-blue-700 font-medium">
                            {item.already_ordered_qty ?? 0}
                          </td>
                          <td className="px-3 py-2.5 text-right hidden sm:table-cell">
                            <span className={(item.remaining_qty ?? 0) <= 0 ? "text-muted-foreground" : "text-green-700 font-medium"}>
                              {item.remaining_qty ?? 0}
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                {canSeePrices && pr.total_estimated_amount > 0 && (
                  <tfoot>
                    <tr className="bg-muted/30">
                      <td colSpan={4} className="px-3 py-2.5 text-sm font-medium text-right hidden sm:table-cell">
                        Total
                      </td>
                      <td colSpan={showOrderedCols ? 4 : 2} className="px-3 py-2.5 text-sm font-bold text-right hidden sm:table-cell">
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
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          Section A: Linked Purchase Orders
      ════════════════════════════════════════════════════════════════════ */}
      {lifecycle && lifecycle.linked_pos.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Linked Purchase Orders</CardTitle>
              <Badge variant="secondary" className="ml-auto text-xs">
                {lifecycle.linked_pos.length} PO{lifecycle.linked_pos.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {lifecycle.linked_pos.map((po) => {
                const hasDelivery = (po.po_delivery_receipts ?? []).some((dr) => dr.status === "received");
                const hasService = (po.po_service_reports ?? []).length > 0;
                const bills = po.vendor_bills ?? [];

                return (
                  <div
                    key={po.id}
                    className="rounded-lg border bg-card p-4 space-y-3 hover:shadow-sm transition-shadow"
                  >
                    {/* PO header row */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/procurement/orders/${po.id}`}
                          className="font-mono font-semibold text-sm text-blue-700 hover:underline"
                        >
                          {po.po_number}
                        </Link>
                        {/* PO type badge */}
                        <Badge
                          variant="secondary"
                          className={
                            po.po_type === "goods"
                              ? "bg-blue-100 text-blue-800 text-xs"
                              : "bg-purple-100 text-purple-800 text-xs"
                          }
                        >
                          {po.po_type === "goods" ? "Goods" : "Service"}
                        </Badge>
                        {/* Status badge */}
                        <Badge
                          variant="secondary"
                          className={`text-xs ${PO_STATUS_COLORS[po.status] ?? "bg-gray-100 text-gray-700"}`}
                        >
                          {PO_STATUS_LABELS[po.status] ?? po.status}
                        </Badge>
                      </div>
                      {canSeePrices && po.total_amount != null && (
                        <span className="text-sm font-semibold tabular-nums whitespace-nowrap">
                          {formatCurrency(po.total_amount)}
                        </span>
                      )}
                    </div>

                    {/* Vendor */}
                    {po.procurement_vendors?.name && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                        <Building2 className="h-3.5 w-3.5 flex-shrink-0" />
                        {po.procurement_vendors.name}
                      </p>
                    )}

                    {/* Status chips */}
                    {(hasDelivery || hasService) && (
                      <div className="flex flex-wrap gap-1.5">
                        {hasDelivery && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800">
                            <CheckCircle className="h-3 w-3" /> Delivered
                          </span>
                        )}
                        {hasService && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-800">
                            <CheckCircle className="h-3 w-3" /> Service Logged
                          </span>
                        )}
                      </div>
                    )}

                    {/* Vendor bills */}
                    {bills.length > 0 && (
                      <div className="space-y-1.5 pt-1 border-t">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Bills</p>
                        {bills.map((bill) => (
                          <div key={bill.id} className="flex items-center gap-2 flex-wrap">
                            <Link
                              href="/accounting?tab=vendor-payments"
                              className="font-mono text-xs text-purple-700 hover:underline font-medium"
                            >
                              {bill.bill_number}
                            </Link>
                            <Badge
                              variant="secondary"
                              className={`text-xs ${BILL_APPROVAL_STATUS_COLORS[bill.approval_status] ?? "bg-gray-100 text-gray-700"}`}
                            >
                              {BILL_APPROVAL_STATUS_LABELS[bill.approval_status] ?? bill.approval_status}
                            </Badge>
                            <Badge
                              variant="secondary"
                              className={`text-xs ${BILL_PAYMENT_STATUS_COLORS[bill.payment_status] ?? "bg-gray-100 text-gray-700"}`}
                            >
                              {BILL_PAYMENT_STATUS_LABELS[bill.payment_status] ?? bill.payment_status}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          Section B: Lifecycle Tracker
      ════════════════════════════════════════════════════════════════════ */}
      {lifecycle && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Lifecycle Tracker</CardTitle>
              {isMrTerminated && (
                <Badge variant="secondary" className="ml-auto text-xs bg-red-100 text-red-800">
                  {pr.status === "rejected" ? "Rejected" : "Cancelled"}
                </Badge>
              )}
              {!isMrTerminated && nextStageIdx !== -1 && stageStatuses && (
                <Badge variant="secondary" className="ml-auto text-xs bg-amber-100 text-amber-800">
                  Next: {LIFECYCLE_STAGES[nextStageIdx]}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {lifecycleLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading lifecycle…
              </div>
            ) : stageStatuses ? (
              <>
                {/* Desktop: horizontal stepper */}
                <div className="hidden sm:flex items-start gap-0 overflow-x-auto pb-2">
                  {LIFECYCLE_STAGES.map((stage, idx) => {
                    const status = stageStatuses[idx];
                    return (
                      <div key={stage} className="flex items-start flex-1 min-w-0">
                        <div className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
                          {/* Node */}
                          <div
                            className={`
                              flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
                              ${status === "completed" ? "bg-green-500 border-green-500 text-white" : ""}
                              ${status === "current" ? "bg-amber-400 border-amber-500 text-white animate-pulse" : ""}
                              ${status === "pending" ? "bg-white border-gray-300 text-gray-400" : ""}
                              ${status === "stopped" ? "bg-red-400 border-red-400 text-white" : ""}
                            `}
                          >
                            {status === "completed" && <CheckCircle className="h-3.5 w-3.5" />}
                            {status === "current" && <span>{idx + 1}</span>}
                            {status === "pending" && <span>{idx + 1}</span>}
                            {status === "stopped" && <XCircle className="h-3.5 w-3.5" />}
                          </div>
                          {/* Label */}
                          <p
                            className={`text-center text-xs leading-tight px-1 ${
                              status === "completed" ? "text-green-700 font-medium" :
                              status === "current" ? "text-amber-700 font-semibold" :
                              status === "stopped" ? "text-red-600" :
                              "text-muted-foreground"
                            }`}
                          >
                            {stage}
                          </p>
                        </div>
                        {/* Connector line (not after last) */}
                        {idx < LIFECYCLE_STAGES.length - 1 && (
                          <div
                            className={`h-0.5 flex-shrink-0 w-4 mt-3.5 ${
                              stageStatuses[idx] === "completed" ? "bg-green-400" :
                              stageStatuses[idx] === "stopped" ? "bg-red-300" :
                              "bg-gray-200"
                            }`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Mobile: vertical list */}
                <div className="flex flex-col gap-0 sm:hidden">
                  {LIFECYCLE_STAGES.map((stage, idx) => {
                    const status = stageStatuses[idx];
                    const isLast = idx === LIFECYCLE_STAGES.length - 1;
                    return (
                      <div key={stage} className="flex items-start gap-3">
                        <div className="flex flex-col items-center">
                          <div
                            className={`
                              flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
                              ${status === "completed" ? "bg-green-500 border-green-500 text-white" : ""}
                              ${status === "current" ? "bg-amber-400 border-amber-500 text-white animate-pulse" : ""}
                              ${status === "pending" ? "bg-white border-gray-300 text-gray-400" : ""}
                              ${status === "stopped" ? "bg-red-400 border-red-400 text-white" : ""}
                            `}
                          >
                            {status === "completed" && <CheckCircle className="h-3.5 w-3.5" />}
                            {status === "current" && <span>{idx + 1}</span>}
                            {status === "pending" && <span>{idx + 1}</span>}
                            {status === "stopped" && <XCircle className="h-3.5 w-3.5" />}
                          </div>
                          {!isLast && (
                            <div
                              className={`w-0.5 h-6 ${
                                status === "completed" ? "bg-green-300" :
                                status === "stopped" ? "bg-red-200" :
                                "bg-gray-200"
                              }`}
                            />
                          )}
                        </div>
                        <p
                          className={`pt-1 text-sm leading-tight ${
                            status === "completed" ? "text-green-700 font-medium" :
                            status === "current" ? "text-amber-700 font-semibold" :
                            status === "stopped" ? "text-red-600" :
                            "text-muted-foreground"
                          }`}
                        >
                          {stage}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          Section C: Activity Log (Audit Trail)
      ════════════════════════════════════════════════════════════════════ */}
      {lifecycle && displayAuditEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Activity Log</CardTitle>
              <Badge variant="secondary" className="ml-auto text-xs">
                {displayAuditEvents.length} event{displayAuditEvents.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {displayAuditEvents.map((d, idx) => {
                const isLast = idx === displayAuditEvents.length - 1;

                if (d.kind === "view-group") {
                  return (
                    <div key={d.id} className="flex gap-3">
                      <div className="flex flex-col items-center flex-shrink-0">
                        <div className="w-2.5 h-2.5 rounded-full mt-1.5 bg-gray-300" />
                        {!isLast && <div className="w-0.5 flex-1 bg-border mt-1" />}
                      </div>
                      <div className="pb-4 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`inline-block text-xs font-mono font-semibold px-1.5 py-0.5 rounded opacity-70 ${entityBadgeClass(d.entity_type)}`}
                          >
                            {d.entity_label}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Viewed {d.count} times
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {d.performers.join(", ")} · {formatDateTime(d.last_created_at)}
                        </p>
                      </div>
                    </div>
                  );
                }

                const event = d.event;
                const changesEntries = event.changes
                  ? Object.entries(event.changes).filter(([, v]) => v !== null && v !== undefined)
                  : [];

                return (
                  <div key={event.id} className="flex gap-3">
                    {/* Left: dot + connector */}
                    <div className="flex flex-col items-center flex-shrink-0">
                      <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${entityDotClass(event.entity_type)}`} />
                      {!isLast && <div className="w-0.5 flex-1 bg-border mt-1" />}
                    </div>

                    {/* Right: content */}
                    <div className={`pb-4 flex-1 min-w-0 ${isLast ? "" : ""}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`inline-block text-xs font-mono font-semibold px-1.5 py-0.5 rounded ${entityBadgeClass(event.entity_type)}`}
                        >
                          {event.entity_label}
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {humanizeAction(event.action)}
                        </span>
                      </div>

                      {/* Changed fields */}
                      {changesEntries.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {changesEntries.map(([key, change]) => {
                            const label = FIELD_LABELS[key] ?? key.replace(/_/g, " ");
                            const oldVal = (change as { old: unknown; new: unknown }).old;
                            const newVal = (change as { old: unknown; new: unknown }).new;
                            if (oldVal === null && newVal === null) return null;
                            return (
                              <span
                                key={key}
                                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
                              >
                                <span className="font-medium text-foreground">{label}:</span>
                                {oldVal !== null && oldVal !== undefined && (
                                  <>
                                    <span className="line-through opacity-60">{humanizeValue(oldVal)}</span>
                                    <ArrowRight className="h-2.5 w-2.5 opacity-50" />
                                  </>
                                )}
                                <span>{humanizeValue(newVal)}</span>
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {/* Performer + time */}
                      <p className="text-xs text-muted-foreground mt-1">
                        {event.performer?.full_name ?? "System"} · {formatDateTime(event.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          Dialogs
      ════════════════════════════════════════════════════════════════════ */}

      {/* Approve confirm dialog */}
      <Dialog
        open={actionDialog === "approve"}
        onOpenChange={() => { setActionDialog(null); setQuotationOverrideReason(""); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Material Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              You are about to approve <strong>{pr.pr_number}</strong> for{" "}
              <strong>{formatCurrency(pr.total_estimated_amount)}</strong>.
            </p>
            {/* Quotation gate — no vendor quotation attached */}
            {hasNoQuotations && (
              userRole === "admin" ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-800">
                    No vendor quotation attached. As admin you can approve anyway — provide a reason
                    (e.g. repeat / pre-approved order at an already-agreed price).
                  </p>
                  <Textarea
                    value={quotationOverrideReason}
                    onChange={(e) => setQuotationOverrideReason(e.target.value)}
                    placeholder="Reason for approving without a quotation…"
                    rows={2}
                    className="bg-white"
                  />
                </div>
              ) : (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  ⛔ No vendor quotation attached. Only admin can approve without one.
                </div>
              )
            )}
            {/* Budget check panel — approvers only (admin / manager) */}
            {isApprover && budgetLoading && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking department budget…
              </div>
            )}
            {isApprover && !budgetLoading && budgetCheck?.has_budget && (
              <div className={`rounded-lg border p-3 space-y-2 ${budgetCheck.is_over_budget ? "border-red-200 bg-red-50" : budgetCheck.utilisation_after! >= 80 ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50"}`}>
                <p className={`text-xs font-semibold uppercase tracking-wide ${budgetCheck.is_over_budget ? "text-red-700" : budgetCheck.utilisation_after! >= 80 ? "text-amber-700" : "text-green-700"}`}>
                  {PROCUREMENT_DEPARTMENT_LABELS[pr.department]} — Monthly Budget
                </p>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Monthly Budget</span>
                    <span className="font-medium">{formatCurrency(budgetCheck.monthly_budget!)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Spent so far</span>
                    <span>{formatCurrency(budgetCheck.spent_so_far!)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">This MR</span>
                    <span className="font-medium">+ {formatCurrency(budgetCheck.this_mr_amount!)}</span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-2 rounded-full bg-muted/60 mt-1 overflow-hidden">
                    {/* Already-spent portion */}
                    <div className="h-full flex">
                      <div
                        className="h-full bg-green-400 rounded-l-full"
                        style={{ width: `${Math.min(budgetCheck.utilisation_before!, 100)}%` }}
                      />
                      <div
                        className={`h-full ${budgetCheck.is_over_budget ? "bg-red-500" : "bg-amber-400"} rounded-r-full`}
                        style={{ width: `${Math.min(Math.max((budgetCheck.utilisation_after! - budgetCheck.utilisation_before!), 0), 100 - budgetCheck.utilisation_before!)}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex justify-between border-t pt-1 mt-1">
                    <span className={`font-semibold ${budgetCheck.is_over_budget ? "text-red-700" : "text-muted-foreground"}`}>
                      After approval: {formatCurrency(budgetCheck.projected_total!)} ({budgetCheck.utilisation_after}%)
                    </span>
                    {budgetCheck.is_over_budget && (
                      <span className="text-red-700 font-bold text-xs">
                        ↑ Over by {formatCurrency(budgetCheck.over_by!)}
                      </span>
                    )}
                  </div>
                </div>
                {budgetCheck.is_over_budget && (
                  <div className={`text-xs rounded px-2 py-1.5 mt-1 ${userRole === "admin" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                    {userRole === "admin"
                      ? "⚠ This approval will exceed the department budget. As admin you can still approve."
                      : "⛔ Manager approval is not permitted when the department budget is exceeded. Only admin can approve over-budget requests."}
                  </div>
                )}
              </div>
            )}
            {isApprover && !budgetLoading && budgetCheck?.has_budget === false && (
              <p className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1.5">
                No monthly budget configured for {PROCUREMENT_DEPARTMENT_LABELS[pr.department]}. All managers and admins can approve.
              </p>
            )}
            {isApprover && !budgetLoading && budgetCheck?.center && (
              <div className={`rounded-lg border p-3 space-y-2 ${budgetCheck.center.is_over_budget ? "border-red-200 bg-red-50" : budgetCheck.center.utilisation_after >= 80 ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50"}`}>
                <p className={`text-xs font-semibold uppercase tracking-wide ${budgetCheck.center.is_over_budget ? "text-red-700" : budgetCheck.center.utilisation_after >= 80 ? "text-amber-700" : "text-green-700"}`}>
                  {budgetCheck.center.location_name ?? "This center"} — Monthly Budget
                </p>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Center budget</span>
                    <span className="font-medium">{formatCurrency(budgetCheck.center.monthly_budget)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Spent so far</span>
                    <span>{formatCurrency(budgetCheck.center.spent_so_far)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-1 mt-1">
                    <span className={`font-semibold ${budgetCheck.center.is_over_budget ? "text-red-700" : "text-muted-foreground"}`}>
                      After approval: {formatCurrency(budgetCheck.center.projected_total)} ({budgetCheck.center.utilisation_after}%)
                    </span>
                    {budgetCheck.center.is_over_budget && (
                      <span className="text-red-700 font-bold text-xs">
                        ↑ Over by {formatCurrency(budgetCheck.center.over_by)}
                      </span>
                    )}
                  </div>
                </div>
                {budgetCheck.center.is_over_budget && (
                  <div className={`text-xs rounded px-2 py-1.5 mt-1 ${userRole === "admin" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800"}`}>
                    {userRole === "admin"
                      ? "⚠ This approval will exceed this center's budget. As admin you can still approve."
                      : "⛔ Manager approval is not permitted when the center budget is exceeded. Only admin can approve over-budget requests."}
                  </div>
                )}
              </div>
            )}
            {isLargeAmount && (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                This amount exceeds ₹{approvalThreshold.toLocaleString()}. Only admin users can approve this.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() =>
                performAction(
                  "approve",
                  hasNoQuotations && userRole === "admin"
                    ? { quotation_override_reason: quotationOverrideReason.trim() }
                    : undefined
                )
              }
              disabled={
                actionLoading ||
                (budgetCheck?.is_over_budget === true && userRole === "manager") ||
                (budgetCheck?.center?.is_over_budget === true && userRole === "manager") ||
                (hasNoQuotations && userRole !== "admin") ||
                (hasNoQuotations && userRole === "admin" && !quotationOverrideReason.trim())
              }
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
            <DialogTitle>Reject Material Request</DialogTitle>
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
            <DialogTitle>Cancel Material Request</DialogTitle>
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

      {/* Edit prices & resubmit — rejected MRs only. Price-only edits; item identity locked. */}
      <Dialog open={editPricesOpen} onOpenChange={setEditPricesOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit prices & resubmit</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-xs text-muted-foreground">
              Fix any line item prices below (enter <strong>pre-GST amounts only</strong>) and resubmit.
              Item, quantity, and unit cannot be changed here — if those are wrong, cancel the request and create a new one.
            </p>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium text-right">Qty</th>
                    <th className="px-3 py-2 font-medium">Unit</th>
                    <th className="px-3 py-2 font-medium text-right w-40">Price per Unit (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {(pr.purchase_request_items ?? []).map((it) => (
                    <tr key={it.id} className="border-t">
                      <td className="px-3 py-2">{it.item_name}</td>
                      <td className="px-3 py-2 text-right">{it.quantity}</td>
                      <td className="px-3 py-2 text-muted-foreground">{it.unit}</td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="pre-GST"
                          value={priceEdits[it.id] ?? ""}
                          onChange={(e) =>
                            setPriceEdits((prev) => ({ ...prev, [it.id]: e.target.value }))
                          }
                          className="h-8 text-sm text-right"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPricesOpen(false)} disabled={actionLoading}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                // Build line_items payload — only send items whose price actually changed,
                // and validate each.
                const edits: { id: string; estimated_price: number }[] = [];
                for (const it of pr.purchase_request_items ?? []) {
                  const raw = priceEdits[it.id];
                  if (raw === undefined || raw === "") continue;
                  const n = parseFloat(raw);
                  if (isNaN(n) || n < 0) {
                    toast.error(`Invalid price on "${it.item_name}"`);
                    return;
                  }
                  if (Number(it.estimated_price ?? 0) !== n) edits.push({ id: it.id, estimated_price: n });
                }
                setActionLoading(true);
                try {
                  const res = await fetch(`/api/procurement/requests/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "resubmit", line_items: edits }),
                  });
                  const json = await res.json();
                  if (!res.ok) { toast.error(json.error || "Resubmit failed"); return; }
                  toast.success(edits.length > 0 ? "Prices updated & resubmitted" : "Request resubmitted");
                  setEditPricesOpen(false);
                  await fetchPr();
                } finally {
                  setActionLoading(false);
                }
              }}
              disabled={actionLoading}
              className="bg-green-600 hover:bg-green-700"
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save & resubmit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pr.department === "reimbursement" && pr.billable_contract && (
        <BillCustomerDialog
          open={billCustomerOpen}
          onOpenChange={setBillCustomerOpen}
          prId={pr.id}
          prNumber={pr.pr_number}
          contractLabel={`${pr.billable_contract.contract_number}${
            pr.billable_contract.lead
              ? ` — ${pr.billable_contract.lead.company || `${pr.billable_contract.lead.first_name} ${pr.billable_contract.lead.last_name}`}`
              : ""
          }`}
          taxPercentage={pr.billable_contract.tax_percentage ?? 18}
          billingMode={pr.billable_contract.billing_mode}
          seedItems={(pr.purchase_request_items ?? []).map((it) => ({ item_name: it.item_name, quantity: Number(it.quantity) }))}
          onSuccess={fetchPr}
        />
      )}

      {userRole === "admin" && (
        <CorrectDepartmentDialog
          open={correctDeptOpen}
          onOpenChange={setCorrectDeptOpen}
          prId={pr.id}
          prNumber={pr.pr_number}
          currentDepartment={pr.department}
          onSuccess={fetchPr}
        />
      )}
    </div>
  );
}
