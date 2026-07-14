"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Zap, CheckCircle2, ChevronDown, ChevronUp, Trash2, AlertTriangle, Send, Eye, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { BillingModeTag } from "@/components/billing/billing-mode-tag";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";

interface EbLine {
  line_type: "utility" | "generator" | "other";
  meter_label?: string | null;
  label?: string | null;
  units?: number | null;
  rate?: number | null;
  amount?: number | null;
  sort_order: number;
  // client-only: true once the user has typed a Total for this line, meaning
  // Rate should be derived from Amount/Units instead of driving Amount
  amountMode?: boolean;
}

interface VendorBillInfo {
  id: string;
  invoice_number: string | null;
  total_amount: number;
  amount_paid: number;
  payment_status: string;
  approval_status: string;
  due_date: string | null;
  vendor?: { id: string; name: string } | null;
}

interface CustomerBillInfo {
  id: string;
  contract_id: string;
  status: "draft" | "invoiced" | "revised" | "dispatched";
  customer_total: number | null;
  billing_statement_id: string | null;
  created_by: string;
  customer_units_billed: number | null;
  customer_utility_pct: number | null;
  customer_generator_pct: number | null;
  customer_utility_rate: number | null;
  customer_generator_rate: number | null;
  customer_subtotal: number | null;
  customer_cgst: number | null;
  customer_sgst: number | null;
  customer_round_off: number | null;
  gst_rate: number | null;
  contract?: {
    id: string;
    contract_number: string;
    billing_mode: string | null;
    lead?: { id: string; first_name: string; last_name: string; company: string | null } | null;
  } | null;
  billing_statement?: {
    id: string;
    statement_number: string;
    status: "draft" | "finalized" | "exported" | "voided";
    payment_status: string;
    total_amount: number;
    handoff_state: string | null;
  } | null;
}

// Read-only dry run of approve_electricity_landlord_bill() — see
// GET /api/electricity-bills/[id]/approval-preview. Same shape as the
// customer-side numbers a real customer bill would carry, minus the
// row id/status that only exist once one is actually generated.
interface ApprovalPreviewItem {
  contract_id: string;
  contract_number: string;
  billing_mode: string | null;
  customer_name: string;
  customer_utility_units: number;
  customer_generator_units: number;
  customer_utility_rate: number;
  customer_generator_rate: number;
  customer_subtotal: number;
  customer_cgst: number;
  customer_sgst: number;
  customer_total: number;
  gst_rate: number;
}

interface EbBill {
  id: string;
  location_id: string;
  bill_side: string;
  bill_month: number;
  bill_year: number;
  status: "draft" | "invoiced" | "revised";
  landlord_bill_number?: string | null;
  landlord_bill_date?: string | null;
  landlord_total_amount: number;
  landlord_gst_applicable?: boolean;
  landlord_gst_rate?: number | null;
  landlord_gst_amount?: number;
  vendor_bill_id?: string | null;
  notes?: string | null;
  created_at: string;
  electricity_bill_lines: EbLine[];
  locations?: { id: string; name: string; code: string };
  vendor_bill?: VendorBillInfo | null;
  customer_bills?: CustomerBillInfo[];
}

interface LocationConfig {
  service_number: string | null;
  landlord_utility_rate: number;
  landlord_generator_rate: number;
  enabled: boolean;
  landlord_gst_applicable: boolean;
  landlord_gst_rate: number | null;
}

interface Location { id: string; name: string; code: string }

interface MappedContract { contract_id: string; contract_number: string; customer_name: string }

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const STATUS_COLORS: Record<string, string> = {
  draft:    "bg-amber-100 text-amber-800",
  invoiced: "bg-emerald-100 text-emerald-800",
  revised:  "bg-slate-100 text-slate-600",
};

const emptyLine = (): EbLine => ({ line_type: "utility", units: 0, rate: 0, sort_order: 0 });

export default function ElectricityBillsPage() {
  const { user } = useCurrentUser();
  const [bills, setBills] = useState<EbBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"open" | "completed">("open");
  const [listLocationFilter, setListLocationFilter] = useState("");
  const [tallyHandoffV2Enabled, setTallyHandoffV2Enabled] = useState(false);
  // Draft bills (awaiting approval) default to expanded — the full line-item
  // breakdown, lifecycle, and inward/outward preview should be visible to an
  // approver without an extra click. Everything else defaults to collapsed.
  // Two override sets track manual toggles away from each default.
  const [collapsedDraftIds, setCollapsedDraftIds] = useState<Set<string>>(new Set());
  const [expandedOtherIds, setExpandedOtherIds] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBillId, setEditingBillId] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [revising, setRevising] = useState<string | null>(null);
  const [deletingBillId, setDeletingBillId] = useState<string | null>(null);
  const [actingOnCustomerBill, setActingOnCustomerBill] = useState<string | null>(null);
  const [previewsByBillId, setPreviewsByBillId] = useState<Record<string, ApprovalPreviewItem[] | "loading">>({});

  // Form state
  const [locations, setLocations] = useState<Location[]>([]);
  const [locCfg, setLocCfg] = useState<LocationConfig | null>(null);
  const [mappedContracts, setMappedContracts] = useState<MappedContract[] | null>(null);
  const [form, setForm] = useState({
    location_id: "",
    bill_month: new Date().getMonth() + 1,
    bill_year: new Date().getFullYear(),
    landlord_bill_number: "",
    landlord_bill_date: "",
    notes: "",
    landlord_gst_applicable: false,
    landlord_gst_rate: 18 as number | null,
  });
  const [lines, setLines] = useState<EbLine[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);

  const fetchBills = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/electricity-bills?bill_side=landlord");
    if (res.ok) {
      const json = await res.json();
      setBills(json.data ?? []);
    }
    setLoading(false);
  }, []);

  const fetchLocations = useCallback(async () => {
    const res = await fetch("/api/locations?limit=50");
    if (res.ok) {
      const json = await res.json();
      setLocations(json.data ?? []);
    }
  }, []);

  // Drives the accuracy of the Bill & Send "next step" hint — GST-direct
  // bills route to Tally Inbox instead of sending directly when this is on.
  const fetchTallyHandoffSetting = useCallback(async () => {
    const res = await fetch("/api/settings/public");
    if (res.ok) {
      const json = await res.json();
      setTallyHandoffV2Enabled(json.data?.tally_handoff_v2_enabled === "true");
    }
  }, []);

  useEffect(() => { fetchBills(); fetchLocations(); fetchTallyHandoffSetting(); }, [fetchBills, fetchLocations, fetchTallyHandoffSetting]);

  const fetchApprovalPreview = useCallback(async (billId: string) => {
    setPreviewsByBillId((prev) => ({ ...prev, [billId]: "loading" }));
    const res = await fetch(`/api/electricity-bills/${billId}/approval-preview`);
    const json = await res.json();
    setPreviewsByBillId((prev) => ({ ...prev, [billId]: res.ok ? (json.data ?? []) : [] }));
  }, []);

  // Fetch the customer-bill preview for every draft bill currently expanded
  // (drafts default to expanded — see collapsedDraftIds) — cached per bill id
  // so re-collapsing/re-expanding doesn't refetch.
  useEffect(() => {
    for (const bill of bills) {
      if (bill.status !== "draft") continue;
      if (collapsedDraftIds.has(bill.id)) continue;
      if ((bill.customer_bills?.length ?? 0) > 0) continue;
      if (previewsByBillId[bill.id] !== undefined) continue;
      fetchApprovalPreview(bill.id);
    }
  }, [bills, collapsedDraftIds, previewsByBillId, fetchApprovalPreview]);

  const isExpanded = useCallback(
    (bill: EbBill) => (bill.status === "draft" ? !collapsedDraftIds.has(bill.id) : expandedOtherIds.has(bill.id)),
    [collapsedDraftIds, expandedOtherIds],
  );

  const toggleExpanded = (bill: EbBill) => {
    if (bill.status === "draft") {
      setCollapsedDraftIds((prev) => {
        const next = new Set(prev);
        if (next.has(bill.id)) next.delete(bill.id); else next.add(bill.id);
        return next;
      });
    } else {
      setExpandedOtherIds((prev) => {
        const next = new Set(prev);
        if (next.has(bill.id)) next.delete(bill.id); else next.add(bill.id);
        return next;
      });
    }
  };

  const handleLocationChange = async (locId: string) => {
    setForm((f) => ({ ...f, location_id: locId }));
    if (!locId) { setLocCfg(null); setMappedContracts(null); return; }
    const res = await fetch(`/api/locations/${locId}/electricity-config`);
    if (res.ok) {
      const json = await res.json();
      const cfg = json.data as LocationConfig | null;
      setLocCfg(cfg);
      setMappedContracts((json.mapped_contracts as MappedContract[] | undefined) ?? []);
      // Pre-fill line rates from location config
      if (cfg) {
        setLines([
          { line_type: "utility",   units: 0, rate: cfg.landlord_utility_rate,   sort_order: 0 },
          { line_type: "generator", units: 0, rate: cfg.landlord_generator_rate, sort_order: 1 },
        ]);
        // Pre-fill GST from the location default — still editable per bill
        setForm((f) => ({
          ...f,
          landlord_gst_applicable: cfg.landlord_gst_applicable,
          landlord_gst_rate: cfg.landlord_gst_rate ?? 18,
        }));
      }
    }
  };

  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  const lineAmount = (l: EbLine) => {
    if (l.line_type === "other") return l.amount ?? 0;
    if (l.amountMode) return l.amount ?? 0;
    return (l.units ?? 0) * (l.rate ?? 0);
  };

  // Rate is either what the user typed directly, or — once they've typed a
  // Total instead — derived back from Total / Units.
  const lineRate = (l: EbLine) => {
    if (l.line_type === "other") return 0;
    if (l.amountMode) {
      const units = l.units ?? 0;
      return units > 0 ? round4((l.amount ?? 0) / units) : 0;
    }
    return l.rate ?? 0;
  };

  const grandTotal = lines.reduce((s, l) => s + lineAmount(l), 0);
  const landlordGstAmount = form.landlord_gst_applicable
    ? round4(grandTotal * (Number(form.landlord_gst_rate ?? 0) / 100))
    : 0;
  const landlordPayableTotal = grandTotal + landlordGstAmount;

  const addLine = () =>
    setLines((ls) => [...ls, { line_type: "other", label: "", amount: 0, sort_order: ls.length }]);

  const removeLine = (i: number) =>
    setLines((ls) => ls.filter((_, idx) => idx !== i).map((l, idx) => ({ ...l, sort_order: idx })));

  const updateLine = (i: number, patch: Partial<EbLine>) =>
    setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  // Edit only ever opens on a still-draft landlord bill (the button is
  // hidden past that point), so pre-fill straight from the already-fetched
  // bill — no extra round-trip needed.
  const handleEditClick = (bill: EbBill) => {
    setEditingBillId(bill.id);
    setForm({
      location_id: bill.location_id,
      bill_month: bill.bill_month,
      bill_year: bill.bill_year,
      landlord_bill_number: bill.landlord_bill_number ?? "",
      landlord_bill_date: bill.landlord_bill_date ?? "",
      notes: bill.notes ?? "",
      landlord_gst_applicable: bill.landlord_gst_applicable ?? false,
      landlord_gst_rate: bill.landlord_gst_rate ?? 18,
    });
    setLines(
      bill.electricity_bill_lines.length > 0
        ? bill.electricity_bill_lines.map((l, i) => ({ ...l, sort_order: l.sort_order ?? i }))
        : [emptyLine()],
    );
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingBillId(null);
    setLines([emptyLine()]);
    setForm({ location_id: "", bill_month: new Date().getMonth() + 1, bill_year: new Date().getFullYear(), landlord_bill_number: "", landlord_bill_date: "", notes: "", landlord_gst_applicable: false, landlord_gst_rate: 18 });
  };

  const handleSubmit = async () => {
    if (!form.location_id) { toast.error("Select a location"); return; }
    if (lines.length === 0) { toast.error("Add at least one line"); return; }
    setSubmitting(true);
    const linesPayload = lines.map((l) => ({
      line_type: l.line_type,
      meter_label: l.meter_label ?? null,
      label: l.label ?? null,
      units: l.line_type !== "other" ? (l.units ?? 0) : null,
      rate: l.line_type !== "other" ? lineRate(l) : null,
      amount: l.line_type === "other" ? (l.amount ?? 0) : null,
      sort_order: l.sort_order,
    }));
    const res = editingBillId
      ? await fetch(`/api/electricity-bills/${editingBillId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            landlord_bill_number: form.landlord_bill_number || null,
            landlord_bill_date: form.landlord_bill_date || null,
            notes: form.notes || null,
            landlord_gst_applicable: form.landlord_gst_applicable,
            landlord_gst_rate: form.landlord_gst_rate,
            lines: linesPayload,
          }),
        })
      : await fetch("/api/electricity-bills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            landlord_bill_number: form.landlord_bill_number || null,
            landlord_bill_date: form.landlord_bill_date || null,
            notes: form.notes || null,
            lines: linesPayload,
          }),
        });
    const json = await res.json();
    if (res.ok) {
      toast.success(editingBillId ? "Bill updated" : "Bill captured");
      closeDialog();
      fetchBills();
    } else {
      const msg = typeof json.error === "object" ? Object.values(json.error).flat().join("; ") : json.error;
      toast.error(msg || "Failed to save");
    }
    setSubmitting(false);
  };

  const handleApprove = async (billId: string) => {
    if (!window.confirm("Approving will generate the customer bill from these numbers and lock this landlord bill from further edits. Continue?")) {
      return;
    }
    setApproving(billId);
    const res = await fetch(`/api/electricity-bills/${billId}/approve`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      const count = (json.data as { customer_bills_generated: number }).customer_bills_generated ?? 0;
      toast.success(`Approved — ${count} customer bill${count !== 1 ? "s" : ""} generated`);
      fetchBills();
    } else {
      toast.error(json.error || "Approval failed");
    }
    setApproving(null);
  };

  const handleRevise = async (billId: string) => {
    if (
      !window.confirm(
        "No customer bills were generated when this was approved (the contract wasn't enabled for electricity billing yet). " +
          "Revising will mark this landlord bill as revised and create a fresh draft with the same numbers, which you can then re-approve. Continue?",
      )
    ) {
      return;
    }
    setRevising(billId);
    const res = await fetch(`/api/electricity-bills/${billId}/revise`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      toast.success("Revised — a new draft was created. Approve it to regenerate the customer bill(s).");
      fetchBills();
    } else {
      toast.error(json.error || "Failed to revise");
    }
    setRevising(null);
  };

  const handleDeleteBill = async (billId: string, billSide: "landlord" | "customer") => {
    const warning = billSide === "landlord"
      ? "This will permanently delete this landlord bill AND its linked customer bill(s), billing statement(s), and vendor bill. Blocked if any payment has been recorded. This cannot be undone. Continue?"
      : "This will permanently delete this customer bill and its billing statement. Blocked if any payment has been recorded. This cannot be undone. Continue?";
    if (!window.confirm(warning)) return;

    setDeletingBillId(billId);
    const res = await fetch(`/api/electricity-bills/${billId}`, { method: "DELETE" });
    const json = await res.json();
    if (res.ok) {
      toast.success("Deleted");
      fetchBills();
    } else {
      toast.error(json.error || "Failed to delete");
    }
    setDeletingBillId(null);
  };

  const handleConfirmCustomerBill = async (id: string) => {
    setActingOnCustomerBill(id);
    const res = await fetch(`/api/electricity-bills/${id}/confirm`, { method: "PATCH" });
    const json = await res.json();
    if (res.ok) {
      toast.success("Customer bill confirmed — ready to dispatch");
      fetchBills();
    } else {
      toast.error(json.error || "Failed to confirm");
    }
    setActingOnCustomerBill(null);
  };

  const handleDispatchCustomerBill = async (id: string) => {
    setActingOnCustomerBill(id);
    const res = await fetch(`/api/electricity-bills/${id}/dispatch`, { method: "POST" });
    const json = await res.json();
    if (res.ok) {
      if (json.no_contact) {
        toast.warning(json.message ?? "Statement created — customer has no email/phone on file");
      } else {
        toast.success(json.message ?? `Billing statement ${json.statement_number ?? ""} sent`);
      }
      fetchBills();
    } else {
      toast.error(json.error || "Failed to bill customer");
    }
    setActingOnCustomerBill(null);
  };

  const customerName = (cb: CustomerBillInfo) => {
    const lead = cb.contract?.lead;
    if (!lead) return cb.contract?.contract_number ?? "—";
    return lead.company || `${lead.first_name} ${lead.last_name}`.trim() || cb.contract?.contract_number || "—";
  };

  // Full Utility/DG breakdown for accounts to verify before dispatch — mirrors
  // exactly how the dispatch route reconstructs line items from the same
  // stored split % + rate fields, so what's shown here matches the invoice.
  const customerBillBreakdown = (cb: CustomerBillInfo) => {
    const totalUnits = Number(cb.customer_units_billed ?? 0);
    const utilityUnits = Math.round((totalUnits * Number(cb.customer_utility_pct ?? 0)) / 100 * 100) / 100;
    const generatorUnits = Math.round((totalUnits * Number(cb.customer_generator_pct ?? 0)) / 100 * 100) / 100;
    const utilityRate = Number(cb.customer_utility_rate ?? 0);
    const generatorRate = Number(cb.customer_generator_rate ?? 0);
    return {
      utilityUnits, utilityRate, utilityAmount: Math.round(utilityUnits * utilityRate * 100) / 100,
      generatorUnits, generatorRate, generatorAmount: Math.round(generatorUnits * generatorRate * 100) / 100,
      subtotal: Number(cb.customer_subtotal ?? 0),
      cgst: Number(cb.customer_cgst ?? 0),
      sgst: Number(cb.customer_sgst ?? 0),
      roundOff: Number(cb.customer_round_off ?? 0),
      gstRate: Number(cb.gst_rate ?? 18),
      total: Number(cb.customer_total ?? 0),
    };
  };

  const CUSTOMER_STATUS_COLORS: Record<string, string> = {
    draft: "bg-amber-100 text-amber-800",
    invoiced: "bg-blue-100 text-blue-800",
    dispatched: "bg-emerald-100 text-emerald-800",
    revised: "bg-slate-100 text-slate-600",
  };

  // Display labels only — the underlying "invoiced" status value is unchanged
  // (still what confirm/dispatch check against). "Invoiced" reads as if the
  // invoice already went out; nothing's been sent yet at this point, so it's
  // shown as "Ready for Invoice" instead.
  const CUSTOMER_STATUS_LABELS: Record<string, string> = {
    draft: "Draft",
    invoiced: "Ready for Invoice",
    dispatched: "Dispatched",
    revised: "Revised",
  };

  const daysUntil = (dateStr: string | null) => {
    if (!dateStr) return null;
    const diffMs = new Date(dateStr).getTime() - new Date().setHours(0, 0, 0, 0);
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
  };

  // Overall flow stage for the main card badge — reflects the furthest-behind
  // customer bill's progress (Confirm → Dispatch → Finalize/Send → Paid), not
  // just the landlord bill's own draft/invoiced status.
  const OVERALL_STAGES: { label: string; className: string }[] = [
    { label: "Awaiting confirm", className: "bg-amber-100 text-amber-800" },
    { label: "Ready to dispatch", className: "bg-blue-100 text-blue-800" },
    { label: "Awaiting send", className: "bg-indigo-100 text-indigo-800" },
    { label: "Voided", className: "bg-slate-100 text-slate-600" },
    { label: "Sent — unpaid", className: "bg-orange-100 text-orange-800" },
    { label: "Paid", className: "bg-emerald-100 text-emerald-800" },
  ];

  const customerBillRank = (cb: CustomerBillInfo): number => {
    if (cb.status === "draft") return 0;
    if (cb.status === "invoiced") return 1;
    const stmt = cb.billing_statement;
    if (!stmt || stmt.status === "draft") return 2;
    if (stmt.status === "voided") return 3;
    if (stmt.payment_status === "paid") return 5;
    return 4; // finalized / exported, still unpaid
  };

  const overallStage = (bill: EbBill) => {
    if (bill.status === "draft") return { label: "draft", className: STATUS_COLORS.draft };
    const cbs = bill.customer_bills ?? [];
    if (cbs.length === 0) return { label: bill.status, className: STATUS_COLORS[bill.status] };
    const worst = Math.min(...cbs.map(customerBillRank));
    return OVERALL_STAGES[worst];
  };

  // ── Lifecycle view — full step-by-step picture of where a bill actually is ──
  // Distinct from overallStage()'s single badge: this walks the whole journey
  // (capture → approve → confirm → dispatch → invoice issuance → paid) as
  // discrete steps, and — critically — distinguishes "dispatched" meaning
  // "sent to the customer" from "dispatched" meaning "handed off to Tally,
  // awaiting accounts to issue the signed invoice" (see handleStatementFinalized
  // in the dispatch route). Those look identical as a single status but are
  // very different states of the actual transaction.
  const LIFECYCLE_STEPS = ["Captured", "Approved", "Confirmed", "Dispatched", "Paid"] as const;

  const HANDOFF_PENDING_STATES = new Set([
    "pi_awaiting_payment", "pi_paid_awaiting_gst", "direct_gst_requested",
    "name_check_pending", "ready_to_send",
  ]);

  interface LifecycleResult {
    /** Index of the CURRENT step — everything before it is done, this one is in progress (unless complete). */
    stepIndex: number;
    complete: boolean; // true only once fully paid — the current step itself is also "done"
    voided: boolean;
    subLabel: string | null; // what's being waited on right now
  }

  const resolveLifecycle = (bill: EbBill): LifecycleResult => {
    if (bill.status === "draft") {
      return { stepIndex: 1, complete: false, voided: false, subLabel: "Awaiting approval" };
    }
    if (bill.status === "revised") {
      // Superseded by the draft it was cloned into on Revise — dead-end record,
      // shouldn't linger in the Open worklist even though it has no customer bills.
      return { stepIndex: 4, complete: true, voided: false, subLabel: "Superseded by a revised bill" };
    }

    const cbs = bill.customer_bills ?? [];
    if (cbs.length === 0) {
      return { stepIndex: 2, complete: false, voided: false, subLabel: "No contract billed at this location" };
    }

    // Walk every customer bill and report the one furthest behind — matches
    // the same "worst case wins" convention as overallStage()/customerBillRank.
    let result: LifecycleResult = { stepIndex: 4, complete: true, voided: false, subLabel: null };
    for (const cb of cbs) {
      let r: LifecycleResult;
      if (cb.status === "draft") {
        r = { stepIndex: 2, complete: false, voided: false, subLabel: "Awaiting confirmation" };
      } else if (cb.status === "invoiced") {
        r = { stepIndex: 3, complete: false, voided: false, subLabel: "Ready to dispatch" };
      } else {
        const stmt = cb.billing_statement;
        const handoff = stmt?.handoff_state ?? null;
        if (stmt?.status === "voided") {
          r = { stepIndex: 3, complete: false, voided: true, subLabel: "Statement voided" };
        } else if (handoff && HANDOFF_PENDING_STATES.has(handoff)) {
          r = { stepIndex: 4, complete: false, voided: false, subLabel: "Awaiting Tally GST invoice" };
        } else if (stmt?.payment_status === "paid") {
          r = { stepIndex: 4, complete: true, voided: false, subLabel: null };
        } else {
          r = { stepIndex: 4, complete: false, voided: false, subLabel: "Sent — awaiting payment" };
        }
      }
      const rank = r.stepIndex - (r.complete ? 0 : 0.5); // pending step ranks worse than a completed one at the same index
      const resultRank = result.stepIndex - (result.complete ? 0 : 0.5);
      if (rank < resultRank || (r.voided && !result.voided)) result = r;
    }
    return result;
  };

  // "Next step" hint shown under the action buttons on each customer bill —
  // describes what CLICKING the button will actually do, not just the status,
  // so the person doesn't have to guess (this is exactly the distinction that
  // caused confusion earlier: "dispatched" looks identical whether it went
  // straight to the customer or got routed to Tally Inbox for accounts to
  // issue by hand).
  const customerBillNextStepHint = (cb: CustomerBillInfo): string => {
    if (cb.status === "draft") {
      return "Confirming will lock this amount in and enable Bill & Send.";
    }
    if (cb.status === "invoiced") {
      const isGstDirect = cb.contract?.billing_mode === "gst_direct";
      return isGstDirect && tallyHandoffV2Enabled
        ? "Sending will route this to Tally Inbox — accounts issues the signed GST invoice there, which is what actually reaches the customer."
        : "Sending will generate the invoice and email it to the customer with a payment link.";
    }
    // dispatched
    const handoff = cb.billing_statement?.handoff_state ?? null;
    if (handoff && HANDOFF_PENDING_STATES.has(handoff)) {
      return "Awaiting Tally GST invoice — accounts needs to issue and upload it before the customer receives anything.";
    }
    if (cb.billing_statement?.payment_status === "paid") {
      return "Paid — nothing further needed.";
    }
    return "Sent — awaiting customer payment.";
  };

  // Location filter + Open/Completed bucketing — "Completed" reuses the same
  // resolveLifecycle() the stepper renders, so a bill only leaves the default
  // worklist once every customer bill on it has actually reached Paid (voided
  // and Tally-pending bills correctly stay in Open).
  const listFilteredBills = useMemo(
    () => (listLocationFilter ? bills.filter((b) => b.location_id === listLocationFilter) : bills),
    [bills, listLocationFilter],
  );
  const openBills = useMemo(
    () => listFilteredBills.filter((b) => !resolveLifecycle(b).complete),
    [listFilteredBills],
  );
  const completedBills = useMemo(
    () => listFilteredBills.filter((b) => resolveLifecycle(b).complete),
    [listFilteredBills],
  );
  const visibleBills = activeTab === "open" ? openBills : completedBills;

  const canCapture = ["admin", "manager", "accounts", "office_admin"].includes(user?.role ?? "");
  const canApprove = ["admin", "manager"].includes(user?.role ?? "");
  const canManageCustomerBill = ["admin", "manager", "accounts"].includes(user?.role ?? "");
  // Edit/Delete are corrections tools for mis-entered data — admin only,
  // stricter than who's allowed to capture a bill in the first place.
  const canEditBills = user?.role === "admin";
  const canDeleteBills = user?.role === "admin";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5" /> Electricity Bills
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Capture monthly landlord electricity bills. Approve to auto-generate customer invoices.
          </p>
        </div>
        {canCapture && (
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New Bill
          </Button>
        )}
      </div>

      {!loading && bills.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "open" | "completed")}>
            <TabsList>
              <TabsTrigger value="open">Open ({openBills.length})</TabsTrigger>
              <TabsTrigger value="completed">Completed ({completedBills.length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={listLocationFilter || "all"} onValueChange={(v) => setListLocationFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={4} />
      ) : bills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No electricity bills"
          description="Capture a landlord bill to get started."
        />
      ) : visibleBills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title={activeTab === "open" ? "No open bills" : "No completed bills"}
          description={
            activeTab === "open"
              ? "Everything is fully paid and closed out — you're all caught up."
              : "Nothing has reached Paid yet for this view."
          }
        />
      ) : (
        <div className="space-y-3">
          {visibleBills.map((bill) => (
            <Card key={bill.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      className="text-left"
                      onClick={() => toggleExpanded(bill)}
                    >
                      {isExpanded(bill)
                        ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </button>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {bill.locations?.name ?? bill.location_id} — {MONTH_NAMES[bill.bill_month - 1]} {bill.bill_year}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {bill.landlord_bill_number && `Bill# ${bill.landlord_bill_number} · `}
                        {bill.landlord_bill_date && `${formatDate(bill.landlord_bill_date)} · `}
                        {formatCurrency(bill.landlord_total_amount)}
                        {bill.vendor_bill_id && " · Vendor bill linked"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge className={overallStage(bill).className}>{overallStage(bill).label}</Badge>
                    {canEditBills && bill.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditClick(bill)}
                      >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        Edit
                      </Button>
                    )}
                    {canApprove && bill.status === "draft" && (
                      <Button
                        size="sm"
                        onClick={() => handleApprove(bill.id)}
                        disabled={approving === bill.id}
                      >
                        <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                        {approving === bill.id ? "Approving…" : "Approve & Generate"}
                      </Button>
                    )}
                    {canApprove && bill.status === "invoiced" && (bill.customer_bills ?? []).length === 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRevise(bill.id)}
                        disabled={revising === bill.id}
                      >
                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                        {revising === bill.id ? "Revising…" : "Revise"}
                      </Button>
                    )}
                    {canDeleteBills && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeleteBill(bill.id, "landlord")}
                        disabled={deletingBillId === bill.id}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        {deletingBillId === bill.id ? "Deleting…" : "Delete"}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              {isExpanded(bill) && (
                <CardContent className="pt-0 pb-4 px-4">
                  <Separator className="mb-3" />
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b">
                        <th className="text-left pb-1.5 font-medium">Type</th>
                        <th className="text-left pb-1.5 font-medium">Label</th>
                        <th className="text-right pb-1.5 font-medium">Units</th>
                        <th className="text-right pb-1.5 font-medium">Rate</th>
                        <th className="text-right pb-1.5 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bill.electricity_bill_lines.map((l, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-1.5 capitalize text-muted-foreground">{l.line_type}</td>
                          <td className="py-1.5">{l.meter_label ?? l.label ?? "—"}</td>
                          <td className="py-1.5 text-right">{l.units != null ? l.units : "—"}</td>
                          <td className="py-1.5 text-right">{l.rate != null ? formatCurrency(l.rate) : "—"}</td>
                          <td className="py-1.5 text-right font-medium">{formatCurrency(l.amount ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} className="pt-2 text-right font-medium text-sm">Total</td>
                        <td className="pt-2 text-right font-semibold">{formatCurrency(bill.landlord_total_amount)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  <p className="text-xs text-muted-foreground mt-2">Captured {formatDate(bill.created_at)}</p>

                  {/* Lifecycle view — step-by-step picture of where this transaction actually is */}
                  {(() => {
                    const lc = resolveLifecycle(bill);
                    return (
                      <div className="mt-4 pt-4 border-t">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Lifecycle</p>
                        <div className="flex items-center">
                          {LIFECYCLE_STEPS.map((label, i) => {
                            const done = i < lc.stepIndex || (i === lc.stepIndex && lc.complete);
                            const isCurrentPending = i === lc.stepIndex && !lc.complete;
                            const isVoidedHere = i === lc.stepIndex && lc.voided;
                            return (
                              <div key={label} className="flex items-center flex-1 last:flex-none">
                                <div className="flex flex-col items-center gap-1 shrink-0">
                                  <div
                                    className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
                                      isVoidedHere
                                        ? "bg-red-100 text-red-700 border-2 border-red-300"
                                        : done
                                          ? "bg-emerald-500 text-white"
                                          : isCurrentPending
                                            ? "bg-blue-50 text-blue-700 border-2 border-blue-400"
                                            : "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {isVoidedHere ? "!" : done ? "✓" : i + 1}
                                  </div>
                                  <span className={`text-[10px] whitespace-nowrap ${done || isCurrentPending || isVoidedHere ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                                    {label}
                                  </span>
                                </div>
                                {i < LIFECYCLE_STEPS.length - 1 && (
                                  <div className={`h-0.5 flex-1 mx-1.5 ${i < lc.stepIndex ? "bg-emerald-500" : "bg-muted"}`} />
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {lc.subLabel && (
                          <p className={`text-xs mt-2 ${lc.voided ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                            {lc.voided ? "⚠ " : "→ "}{lc.subLabel}
                          </p>
                        )}
                      </div>
                    );
                  })()}

                  {/* Reconciliation: inward payable + outward receivable, same view —
                      shown even while still draft: the vendor bill (if any) is
                      auto-created at capture time already, and the Outward panel
                      below renders an approval preview in place of real customer
                      bills until Approve actually generates them. */}
                  {(() => {
                    const vb = bill.vendor_bill;
                    const dueInDays = daysUntil(vb?.due_date ?? null);
                    const landlordUnpaid = !!vb && vb.payment_status !== "paid";
                    const landlordAtRisk = landlordUnpaid && dueInDays !== null && dueInDays <= 5;
                    const customerBills = bill.customer_bills ?? [];
                    const anyCustomerUnpaid = customerBills.some(
                      (cb) => !cb.billing_statement || cb.billing_statement.payment_status !== "paid"
                    );

                    return (
                      <div className="mt-4 pt-4 border-t space-y-3">
                        {landlordAtRisk && anyCustomerUnpaid && (
                          <div className="flex items-start gap-2 text-xs bg-red-50 border border-red-200 rounded px-3 py-2 text-red-700">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            Landlord payment {dueInDays! < 0 ? `overdue by ${-dueInDays!} day(s)` : dueInDays === 0 ? "due today" : `due in ${dueInDays} day(s)`}
                            {" "}— customer hasn&apos;t paid yet. Don&apos;t hold the landlord payment on collection.
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {/* Inward — payable */}
                          <div className="bg-orange-50/50 border border-orange-200 rounded-lg p-3 text-xs space-y-1.5">
                            <p className="font-semibold text-orange-800 uppercase tracking-wide">Inward — Payable to Landlord</p>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Base amount</span>
                              <span>{formatCurrency(bill.landlord_total_amount)}</span>
                            </div>
                            {bill.landlord_gst_applicable && (
                              <div className="flex justify-between text-muted-foreground">
                                <span>GST ({bill.landlord_gst_rate}%)</span>
                                <span>{formatCurrency(bill.landlord_gst_amount ?? 0)}</span>
                              </div>
                            )}
                            <div className="flex justify-between font-medium pt-1 border-t border-orange-200/70">
                              <span>{vb?.vendor?.name ?? "Total payable"}</span>
                              <span>{formatCurrency(bill.landlord_total_amount + (bill.landlord_gst_amount ?? 0))}</span>
                            </div>
                            {vb ? (
                              <>
                                <div className="flex justify-between text-muted-foreground">
                                  <span>Due</span>
                                  <span>{vb.due_date ? formatDate(vb.due_date) : "—"}</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Badge className={vb.payment_status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}>
                                    {vb.payment_status}
                                  </Badge>
                                  <Badge variant="outline">{vb.approval_status}</Badge>
                                </div>
                              </>
                            ) : (
                              <p className="text-muted-foreground">No vendor bill — landlord vendor not configured for this location.</p>
                            )}
                          </div>

                          {/* Outward — receivable */}
                          <div className="bg-blue-50/50 border border-blue-200 rounded-lg p-3 text-xs space-y-1.5">
                            <p className="font-semibold text-blue-800 uppercase tracking-wide">Outward — Bill to Customer</p>
                            {customerBills.length === 0 && bill.status === "draft" ? (() => {
                              const preview = previewsByBillId[bill.id];
                              if (preview === undefined || preview === "loading") {
                                return <p className="text-muted-foreground">Loading preview…</p>;
                              }
                              if (preview.length === 0) {
                                return (
                                  <p className="text-muted-foreground">
                                    No contracts are enabled for electricity billing at this location — nothing will be generated on approve.
                                  </p>
                                );
                              }
                              return (
                                <>
                                  <p className="text-muted-foreground text-[10px] italic">Preview — nothing is created until you approve.</p>
                                  {preview.map((p) => (
                                    <div key={p.contract_id} className="py-1 space-y-1">
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span className="font-medium truncate">{p.customer_name}</span>
                                          <BillingModeTag mode={p.billing_mode} />
                                        </div>
                                        <span className="font-medium shrink-0">{formatCurrency(p.customer_total)}</span>
                                      </div>
                                      <div className="rounded border border-blue-200 bg-white/60 px-2 py-1.5 space-y-0.5">
                                        {p.customer_utility_units > 0 && (
                                          <div className="flex justify-between text-muted-foreground">
                                            <span>Utility/Grid: {p.customer_utility_units} units × {formatCurrency(p.customer_utility_rate)}</span>
                                            <span>{formatCurrency(p.customer_utility_units * p.customer_utility_rate)}</span>
                                          </div>
                                        )}
                                        {p.customer_generator_units > 0 && (
                                          <div className="flex justify-between text-muted-foreground">
                                            <span>DG/Generator: {p.customer_generator_units} units × {formatCurrency(p.customer_generator_rate)}</span>
                                            <span>{formatCurrency(p.customer_generator_units * p.customer_generator_rate)}</span>
                                          </div>
                                        )}
                                        <div className="flex justify-between text-muted-foreground border-t border-dashed pt-0.5 mt-0.5">
                                          <span>Subtotal</span>
                                          <span>{formatCurrency(p.customer_subtotal)}</span>
                                        </div>
                                        <div className="flex justify-between text-muted-foreground">
                                          <span>GST ({p.gst_rate}%): CGST {formatCurrency(p.customer_cgst)} + SGST {formatCurrency(p.customer_sgst)}</span>
                                          <span>{formatCurrency(p.customer_cgst + p.customer_sgst)}</span>
                                        </div>
                                        <div className="flex justify-between font-medium pt-0.5 border-t">
                                          <span>Total</span>
                                          <span>{formatCurrency(p.customer_total)}</span>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </>
                              );
                            })() : customerBills.length === 0 ? (
                              <p className="text-muted-foreground">No customer bills generated for this bill.</p>
                            ) : (
                              customerBills.map((cb) => (
                                <div key={cb.id} className="py-1 space-y-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="font-medium truncate">{customerName(cb)}</span>
                                      <BillingModeTag mode={cb.contract?.billing_mode} />
                                    </div>
                                    <span className="font-medium shrink-0">{formatCurrency(cb.customer_total ?? 0)}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <Badge className={CUSTOMER_STATUS_COLORS[cb.status] ?? ""}>{CUSTOMER_STATUS_LABELS[cb.status] ?? cb.status}</Badge>
                                    {cb.billing_statement && (
                                      <span className="text-muted-foreground">
                                        Stmt {cb.billing_statement.statement_number} · {cb.billing_statement.status} · {cb.billing_statement.payment_status}
                                      </span>
                                    )}
                                  </div>

                                  {/* Full breakup for accounts to verify before dispatch */}
                                  {(() => {
                                    const b = customerBillBreakdown(cb);
                                    return (
                                      <div className="rounded border border-blue-200 bg-white/60 px-2 py-1.5 space-y-0.5">
                                        {b.utilityUnits > 0 && (
                                          <div className="flex justify-between text-muted-foreground">
                                            <span>Utility/Grid: {b.utilityUnits} units × {formatCurrency(b.utilityRate)}</span>
                                            <span>{formatCurrency(b.utilityAmount)}</span>
                                          </div>
                                        )}
                                        {b.generatorUnits > 0 && (
                                          <div className="flex justify-between text-muted-foreground">
                                            <span>DG/Generator: {b.generatorUnits} units × {formatCurrency(b.generatorRate)}</span>
                                            <span>{formatCurrency(b.generatorAmount)}</span>
                                          </div>
                                        )}
                                        <div className="flex justify-between text-muted-foreground border-t border-dashed pt-0.5 mt-0.5">
                                          <span>Subtotal</span>
                                          <span>{formatCurrency(b.subtotal)}</span>
                                        </div>
                                        <div className="flex justify-between text-muted-foreground">
                                          <span>GST ({b.gstRate}%): CGST {formatCurrency(b.cgst)} + SGST {formatCurrency(b.sgst)}</span>
                                          <span>{formatCurrency(b.cgst + b.sgst)}</span>
                                        </div>
                                        {b.roundOff !== 0 && (
                                          <div className="flex justify-between text-muted-foreground">
                                            <span>Round off</span>
                                            <span>{formatCurrency(b.roundOff)}</span>
                                          </div>
                                        )}
                                        <div className="flex justify-between font-medium pt-0.5 border-t">
                                          <span>Total</span>
                                          <span>{formatCurrency(b.total)}</span>
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  <div className="flex items-center gap-2">
                                    {canManageCustomerBill && (cb.status === "draft" || cb.status === "invoiced") && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => window.open(`/api/electricity-bills/${cb.id}/preview`, "_blank")}
                                      >
                                        <Eye className="mr-1 h-3 w-3" />
                                        Preview
                                      </Button>
                                    )}
                                    {canManageCustomerBill && cb.status === "draft" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-xs"
                                        disabled={actingOnCustomerBill === cb.id}
                                        onClick={() => handleConfirmCustomerBill(cb.id)}
                                      >
                                        <CheckCircle2 className="mr-1 h-3 w-3" />
                                        Confirm
                                      </Button>
                                    )}
                                    {canManageCustomerBill && cb.status === "invoiced" && (
                                      <Button
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        disabled={actingOnCustomerBill === cb.id}
                                        onClick={() => handleDispatchCustomerBill(cb.id)}
                                      >
                                        <Send className="mr-1 h-3 w-3" />
                                        {actingOnCustomerBill === cb.id ? "Sending…" : "Bill & Send"}
                                      </Button>
                                    )}
                                    {canDeleteBills && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                        disabled={deletingBillId === cb.id}
                                        onClick={() => handleDeleteBill(cb.id, "customer")}
                                      >
                                        <Trash2 className="mr-1 h-3 w-3" />
                                        {deletingBillId === cb.id ? "Deleting…" : "Delete"}
                                      </Button>
                                    )}
                                  </div>
                                  {canManageCustomerBill && (
                                    <p className="text-muted-foreground text-[11px]">{customerBillNextStepHint(cb)}</p>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                      </div>
                    );
                  })()}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* New bill dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingBillId ? "Edit Electricity bill - Landlord" : "New Electricity bill - Landlord"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Location + period */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1 col-span-3">
                <Label>Location</Label>
                <Select
                  value={form.location_id || "none"}
                  onValueChange={(v) => handleLocationChange(v === "none" ? "" : v)}
                  disabled={!!editingBillId}
                >
                  <SelectTrigger><SelectValue placeholder="Select location…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— Select —</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {locCfg?.service_number && (
                  <p className="text-xs text-muted-foreground">Meter: <span className="font-mono">{locCfg.service_number}</span></p>
                )}
                {locCfg && !locCfg.enabled && (
                  <p className="text-xs text-destructive">Electricity billing is not enabled for this location.</p>
                )}
                {mappedContracts && mappedContracts.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Bills: {mappedContracts.map((c) => `${c.contract_number} — ${c.customer_name}`).join(", ")}
                  </p>
                )}
                {mappedContracts && mappedContracts.length === 0 && (
                  <p className="text-xs text-muted-foreground">No contract mapped — will route to Accounts Payable on approval.</p>
                )}
                {editingBillId && (
                  <p className="text-xs text-muted-foreground">Location, month, and year can&apos;t be changed once captured.</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Month</Label>
                <Select
                  value={String(form.bill_month)}
                  onValueChange={(v) => setForm((f) => ({ ...f, bill_month: parseInt(v) }))}
                  disabled={!!editingBillId}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Year</Label>
                <Input
                  type="number" min={2020} max={2099}
                  value={form.bill_year}
                  onChange={(e) => setForm((f) => ({ ...f, bill_year: parseInt(e.target.value) || new Date().getFullYear() }))}
                  disabled={!!editingBillId}
                />
              </div>
              <div className="space-y-1">
                <Label>Bill number</Label>
                <Input
                  placeholder="Optional"
                  value={form.landlord_bill_number}
                  onChange={(e) => setForm((f) => ({ ...f, landlord_bill_number: e.target.value }))}
                />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>Bill date</Label>
                <Input
                  type="date"
                  value={form.landlord_bill_date}
                  onChange={(e) => setForm((f) => ({ ...f, landlord_bill_date: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            {/* Lines */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Bill Line Items</p>
                <Button variant="outline" size="sm" onClick={addLine}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add line
                </Button>
              </div>
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Label / Meter</th>
                      <th className="px-3 py-2 text-right font-medium">Units</th>
                      <th className="px-3 py-2 text-right font-medium">Rate (₹)</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-1 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          <Select
                            value={l.line_type}
                            onValueChange={(v) => updateLine(i, { line_type: v as EbLine["line_type"] })}
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="utility">Grid / Utility</SelectItem>
                              <SelectItem value="generator">DG / Generator</SelectItem>
                              <SelectItem value="other">Other charge</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-3 py-1.5">
                          <Input
                            className="h-8 text-xs"
                            placeholder={l.line_type === "other" ? "Label" : "Meter label (opt.)"}
                            value={l.line_type === "other" ? (l.label ?? "") : (l.meter_label ?? "")}
                            onChange={(e) => updateLine(i, l.line_type === "other"
                              ? { label: e.target.value }
                              : { meter_label: e.target.value }
                            )}
                          />
                        </td>
                        <td className="px-3 py-1.5">
                          {l.line_type !== "other" ? (
                            <Input
                              className="h-8 text-xs text-right"
                              type="number" min={0} step={0.01}
                              value={l.units ?? 0}
                              onChange={(e) => updateLine(i, { units: parseFloat(e.target.value) || 0 })}
                            />
                          ) : <span className="text-muted-foreground text-xs px-1">—</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          {l.line_type !== "other" ? (
                            <Input
                              className="h-8 text-xs text-right"
                              type="number" min={0} step={0.01}
                              title={l.amountMode ? "Auto-calculated from Total ÷ Units" : undefined}
                              value={lineRate(l)}
                              onChange={(e) => updateLine(i, { rate: parseFloat(e.target.value) || 0, amountMode: false })}
                            />
                          ) : <span className="text-muted-foreground text-xs px-1">—</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          <Input
                            className="h-8 text-xs text-right font-medium"
                            type="number" min={0} step={0.01}
                            title={l.line_type !== "other" && !l.amountMode ? "Auto-calculated from Units × Rate — edit to derive Rate instead" : undefined}
                            value={lineAmount(l)}
                            onChange={(e) => updateLine(i, l.line_type === "other"
                              ? { amount: parseFloat(e.target.value) || 0 }
                              : { amount: parseFloat(e.target.value) || 0, amountMode: true }
                            )}
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          {lines.length > 1 && (
                            <button onClick={() => removeLine(i)} className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/30">
                      <td colSpan={4} className="px-3 py-2 text-right text-sm font-medium">Total</td>
                      <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums">
                        {formatCurrency(grandTotal)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <Separator />

            {/* Landlord GST — some landlords charge it, some don't; overridable per bill */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Landlord charges GST on this bill</p>
                  <p className="text-xs text-muted-foreground">Defaults from the location&apos;s electricity config — adjust here if this month differs.</p>
                </div>
                <Switch
                  checked={form.landlord_gst_applicable}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, landlord_gst_applicable: v }))}
                />
              </div>
              {form.landlord_gst_applicable && (
                <div className="flex items-center gap-2 max-w-[200px]">
                  <Label className="text-xs whitespace-nowrap">GST rate (%)</Label>
                  <Input
                    type="number" min={0} step={0.01}
                    value={form.landlord_gst_rate ?? 18}
                    onChange={(e) => setForm((f) => ({ ...f, landlord_gst_rate: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
              )}
              <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Base amount</span>
                  <span className="tabular-nums">{formatCurrency(grandTotal)}</span>
                </div>
                {form.landlord_gst_applicable && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>GST ({form.landlord_gst_rate ?? 18}%)</span>
                    <span className="tabular-nums">{formatCurrency(landlordGstAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold pt-1 border-t">
                  <span>Total payable to landlord</span>
                  <span className="tabular-nums">{formatCurrency(landlordPayableTotal)}</span>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                placeholder="Optional"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Saving…" : editingBillId ? "Save Changes" : "Save as Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
