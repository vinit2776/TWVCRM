"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Loader2, FileText, ExternalLink, FileCheck, Zap, Ban, Send, Mail, X, ChevronDown, ChevronUp, Receipt } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, voBillParty, type HandoffState } from "@/lib/tally-handoff";
import { TallyStatusBadge } from "@/components/billing/tally-status-badge";
import { CreditNoteUploadDialog } from "@/components/billing/credit-note-upload-dialog";

interface CaseBillingTabProps {
  caseId: string;
}

interface CaseBillingInfo {
  case_source: "aggregator" | "direct";
  bill_to: "aggregator" | "client" | null;
  billing_mode: "proforma_first" | "gst_direct";
  client_name: string | null;
  client_company_name: string | null;
  client_email: string | null;
  aggregator: { billing_method?: string; billing_mode?: "proforma_first" | "gst_direct"; name?: string; company_name?: string; primary_email?: string | null } | null;
}

interface CaseStatement {
  id: string;
  created_at: string | null;
  statement_number: string | null;
  total_amount: number;
  payment_status: string;
  status: string;
  handoff_state: HandoffState | null;
  voided_at: string | null;
  issuance_channel: string | null;
  lifecycle_stage: string | null;
  tally_invoice_number: string | null;
  tally_irn: string | null;
  tally_credit_note_number: string | null;
  tally_last_error: string | null;
  tally_delivered_at: string | null;
  proforma_sent_at: string | null;
  gst_invoice_number: string | null;
}

interface InvoicePreview {
  statementId: string | null;
  statementNumber: string | null;
  totalAmount: number;
}

/** What was actually raised — read back from the statement itself, so the
 *  case owner can see the details that went to accounts without needing
 *  Tally Inbox access (which sales and case-handling roles do not have). */
interface StatementDetails {
  buyerName: string;
  buyerGstin: string | null;
  billToAggregator: boolean;
  endClientName: string | null;
  caseNumber: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  placeOfSupply: string | null;
  isInterstate: boolean;
  subtotal: number;
  taxPercentage: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  lines: { description: string; quantity: number; rate: number; amount: number }[];
}

/** Mirrors CaseInvoicePreview from src/lib/case-invoicing.ts, returned by
 *  GET /api/cases/[id]/invoice. */
interface GeneratePreview {
  billTo: "aggregator" | "client";
  buyerName: string;
  buyerGstin: string | null;
  buyerEmail: string | null;
  endClientName: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  tenureMonths: number;
  subtotal: number;
  gstRate: number;
  gstAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  isInterstate: boolean;
  placeOfSupply: string;
  billingMode: "proforma_first" | "gst_direct";
}

const CREDIT_NOTE_ROLES = ["accounts", "admin"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CaseBillingTab({ caseId }: CaseBillingTabProps) {
  const [caseInfo, setCaseInfo] = useState<CaseBillingInfo | null>(null);
  const [statement, setStatement] = useState<CaseStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingBillTo, setSavingBillTo] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [showCreditNoteCancel, setShowCreditNoteCancel] = useState(false);
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidSubmitting, setVoidSubmitting] = useState(false);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [details, setDetails] = useState<StatementDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPreview, setConfirmPreview] = useState<GeneratePreview | null>(null);
  const [loadingConfirm, setLoadingConfirm] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((j) => setUserRole(j.role ?? null)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [caseRes, stmtRes] = await Promise.all([
        fetch(`/api/cases/${caseId}`).then((r) => r.json()),
        fetch(`/api/billing-statements?case_id=${caseId}&statement_type=vo_case&limit=1`).then((r) => r.json()),
      ]);
      setCaseInfo(caseRes.data ?? null);
      const rows = (stmtRes.data ?? []) as CaseStatement[];
      setStatement(rows.find((s) => !s.voided_at) ?? null);
    } catch {
      toast.error("Failed to load billing info");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const eligible = caseInfo && (caseInfo.case_source === "direct" || caseInfo.aggregator?.billing_method === "prepaid");
  const needsBillTo = caseInfo?.case_source === "aggregator" && !caseInfo.bill_to;

  // Mirrors the billingMode resolution in src/lib/case-invoicing.ts — aggregator-
  // sourced cases honor the aggregator's choice, direct-client cases carry their own.
  const resolvedBillingMode: "proforma_first" | "gst_direct" = caseInfo?.case_source === "aggregator"
    ? (caseInfo.aggregator?.billing_mode === "proforma_first" ? "proforma_first" : "gst_direct")
    : (caseInfo?.billing_mode === "gst_direct" ? "gst_direct" : "proforma_first");

  const billToAggregator = caseInfo?.case_source === "aggregator" && caseInfo.bill_to === "aggregator";
  const primaryEmail = billToAggregator ? caseInfo?.aggregator?.primary_email ?? null : caseInfo?.client_email ?? null;
  const primaryName = billToAggregator
    ? caseInfo?.aggregator?.company_name || caseInfo?.aggregator?.name || ""
    : caseInfo?.client_company_name || caseInfo?.client_name || "";

  // A statement that exists, isn't voided, and has had nothing happen to it
  // yet (no GST issuance, no Tally handoff, never dispatched) — the state
  // left behind by the "preview before send" flow when the operator closes
  // the dialog without sending, or a dispatch attempt fails.
  const isUnsentPi = !!statement
    && statement.status !== "voided"
    && !statement.gst_invoice_number
    && !statement.handoff_state
    && !statement.proforma_sent_at
    && resolvedBillingMode === "proforma_first";

  // Void covers everything the Tally-only "Cancel Invoice" flow above
  // doesn't — a finalized/exported proforma that never went through Tally
  // (sent-but-unpaid, or the isUnsentPi state). Blocked server-side if any
  // payment is already recorded.
  const canVoid = !!statement
    && userRole === "admin"
    && ["finalized", "exported"].includes(statement.status)
    && statement.issuance_channel !== "tally";

  const handleBillToChange = async (value: string) => {
    setSavingBillTo(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_to: value }),
      });
      if (!res.ok) throw new Error();
      setCaseInfo((prev) => (prev ? { ...prev, bill_to: value as "aggregator" | "client" } : prev));
      toast.success("Bill-to updated");
    } catch {
      toast.error("Failed to update bill-to");
    } finally {
      setSavingBillTo(false);
    }
  };

  const [savingBillingMode, setSavingBillingMode] = useState(false);
  const handleBillingModeChange = async (value: "proforma_first" | "gst_direct") => {
    if (caseInfo?.billing_mode === value) return;
    setSavingBillingMode(true);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: value }),
      });
      if (!res.ok) throw new Error();
      setCaseInfo((prev) => (prev ? { ...prev, billing_mode: value } : prev));
      toast.success(value === "gst_direct" ? "GST Direct billing enabled" : "Proforma First billing enabled");
    } catch {
      toast.error("Failed to update billing mode");
    } finally {
      setSavingBillingMode(false);
    }
  };

  const addCcEmail = () => {
    const email = ccInput.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      toast.error("Invalid email address");
      return;
    }
    if (email === primaryEmail?.toLowerCase()) {
      toast.error("That is already the primary recipient");
      return;
    }
    if (ccEmails.includes(email)) {
      toast.error("Already added");
      return;
    }
    setCcEmails((prev) => [...prev, email]);
    setCcInput("");
  };

  const resetPreviewState = () => {
    setPreviewOpen(false);
    setPreview(null);
    setCcEmails([]);
    setCcInput("");
  };

  // Step 1 of "Generate Invoice": show what would be billed, to whom, for
  // what period, with the tax breakup — before anything is created. Nothing
  // is written until the operator confirms. A gst_direct invoice previously
  // went straight into the Tally Inbox on this one click with no review, and
  // undoing it needs an admin void.
  const handleGenerateInvoice = async () => {
    if (isUnsentPi && statement) {
      setPreview({ statementId: statement.id, statementNumber: statement.statement_number, totalAmount: statement.total_amount });
      setPreviewOpen(true);
      return;
    }
    setLoadingConfirm(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/invoice`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Could not prepare the invoice");
        return;
      }
      setConfirmPreview(json.data as GeneratePreview);
      setConfirmOpen(true);
    } catch {
      toast.error("Could not prepare the invoice");
    } finally {
      setLoadingConfirm(false);
    }
  };

  // Step 2: actually create it. For proforma_first the statement is created
  // without dispatching and the send dialog opens; the send happens there via
  // handleConfirmSend. gst_direct creates it and routes it to the Tally Inbox.
  const handleConfirmGenerate = async () => {
    setConfirmOpen(false);
    setGenerating(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to generate invoice");
        return;
      }
      if (json.data?.requires_send) {
        setPreview({
          statementId: json.data.statement_id ?? null,
          statementNumber: json.data.preview?.statement_number ?? null,
          totalAmount: Number(json.data.preview?.total_amount ?? 0),
        });
        setPreviewOpen(true);
        await load();
      } else {
        toast.success("Invoice generated — it now sits in the Tally Inbox for accounts to process");
        await load();
      }
    } catch {
      toast.error("Failed to generate invoice");
    } finally {
      setGenerating(false);
      setConfirmPreview(null);
    }
  };

  const handleConfirmSend = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/invoice/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cc: ccEmails }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to send invoice");
        return;
      }
      if (json.data?.no_contact) {
        toast.warning("Invoice created but no email/phone on file — contact the customer manually.");
      } else {
        toast.success(`Invoice sent to ${json.data?.emailed_to ?? "customer"}`);
      }
      resetPreviewState();
      await load();
    } catch {
      toast.error("Failed to send invoice");
    } finally {
      setSending(false);
    }
  };

  // Reads the raised statement back and flattens it into the same summary
  // the Tally Inbox puts in front of accounts: who is billed, for what, over
  // what period, with the tax split. Lazy — only fetched when opened.
  const handleToggleDetails = async () => {
    if (detailsOpen) { setDetailsOpen(false); return; }
    setDetailsOpen(true);
    if (details || !statement) return;
    setDetailsLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${statement.id}`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Could not load invoice details");
        setDetailsOpen(false);
        return;
      }
      const d = json.data ?? json;
      const party = voBillParty({ case: d.case ?? null, aggregator: d.aggregator ?? null });
      // line_items is a JSONB array of sections, each holding the real
      // per-charge rows — same shape proforma-pdf renders from.
      const lines: StatementDetails["lines"] = [];
      for (const section of (d.line_items ?? []) as { items?: unknown[] }[]) {
        for (const item of (section.items ?? []) as Record<string, unknown>[]) {
          lines.push({
            description: String(item.description ?? ""),
            quantity: Number(item.quantity ?? 1),
            rate: Number(item.rate ?? 0),
            amount: Number(item.amount ?? 0),
          });
        }
      }
      setDetails({
        buyerName: party?.name ?? "—",
        buyerGstin: party?.gstin ?? null,
        billToAggregator: d.case?.bill_to === "aggregator",
        endClientName: d.case ? (d.case.client_company_name || d.case.client_name) : null,
        caseNumber: d.case?.case_number ?? null,
        periodStart: d.period_start ?? null,
        periodEnd: d.period_end ?? null,
        placeOfSupply: d.place_of_supply ?? null,
        isInterstate: !!d.is_interstate,
        subtotal: Number(d.subtotal ?? 0),
        taxPercentage: Number(d.tax_percentage ?? 0),
        cgst: Number(d.cgst_amount ?? 0),
        sgst: Number(d.sgst_amount ?? 0),
        igst: Number(d.igst_amount ?? 0),
        total: Number(d.total_amount ?? 0),
        lines,
      });
    } catch {
      toast.error("Could not load invoice details");
      setDetailsOpen(false);
    } finally {
      setDetailsLoading(false);
    }
  };

  const handleVoid = async () => {
    if (!statement || !voidReason.trim()) return;
    setVoidSubmitting(true);
    try {
      const res = await fetch(`/api/billing-statements/${statement.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to void invoice");
      toast.success(json.message || "Invoice voided");
      setShowVoidConfirm(false);
      setVoidReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to void invoice");
    } finally {
      setVoidSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!eligible) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          This case is billed via the aggregator&apos;s consolidated monthly invoice, not individually.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {caseInfo?.case_source === "direct" && (
        <Card>
          <CardContent className="py-4 space-y-2">
            <p className="text-sm font-medium">Invoice Type</p>
            <div className="flex gap-2">
              <button
                onClick={() => handleBillingModeChange("proforma_first")}
                disabled={savingBillingMode || !!statement}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-60 ${
                  caseInfo.billing_mode === "proforma_first"
                    ? "bg-[#015E65] text-white border-[#015E65]"
                    : "bg-background text-muted-foreground border-border hover:bg-muted/30"
                }`}
              >
                <FileCheck className="h-3.5 w-3.5 shrink-0" />
                Proforma First
              </button>
              <button
                onClick={() => handleBillingModeChange("gst_direct")}
                disabled={savingBillingMode || !!statement}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-60 ${
                  caseInfo.billing_mode === "gst_direct"
                    ? "bg-violet-700 text-white border-violet-700"
                    : "bg-background text-muted-foreground border-border hover:bg-muted/30"
                }`}
              >
                <Zap className="h-3.5 w-3.5 shrink-0" />
                GST Direct
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {caseInfo.billing_mode === "gst_direct"
                ? "Tax invoice issued directly · Accountant creates it in Tally, then the customer is billed · No proforma"
                : "Proforma invoice sent immediately with a payment link · Real GST invoice issued once paid"}
            </p>
          </CardContent>
        </Card>
      )}

      {caseInfo?.case_source === "aggregator" && (
        <Card>
          <CardContent className="py-4 space-y-2">
            <p className="text-sm font-medium">Bill To</p>
            <p className="text-xs text-muted-foreground">
              Who this case&apos;s invoice bills — varies case by case for prepaid aggregators.
            </p>
            <Select value={caseInfo.bill_to ?? undefined} onValueChange={handleBillToChange} disabled={savingBillTo || !!statement}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select bill-to" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="aggregator">Aggregator</SelectItem>
                <SelectItem value="client">End Client</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-6">
          {!statement ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <FileText className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No invoice generated yet for this case.</p>
              <Button onClick={handleGenerateInvoice} disabled={generating || loadingConfirm || needsBillTo}>
                {(generating || loadingConfirm) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate Invoice
              </Button>
              {needsBillTo && (
                <p className="text-xs text-amber-600">Select who to bill before generating the invoice.</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{statement.statement_number ?? "—"}</p>
                  <p className="text-lg font-semibold">{formatCurrency(statement.total_amount)}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant={statement.payment_status === "paid" ? "default" : "outline"}>
                    {statement.payment_status === "paid" ? "Paid" : "Unpaid"}
                  </Badge>
                  {statement.handoff_state && (
                    <Badge variant="outline" className="text-xs">
                      {HANDOFF_STATE_LABELS[statement.handoff_state] ?? statement.handoff_state}
                    </Badge>
                  )}
                  <TallyStatusBadge
                    variant="compact"
                    issuance_channel={statement.issuance_channel}
                    lifecycle_stage={statement.lifecycle_stage}
                    tally_invoice_number={statement.tally_invoice_number}
                    tally_irn={statement.tally_irn}
                    tally_credit_note_number={statement.tally_credit_note_number}
                    tally_last_error={statement.tally_last_error}
                    tally_delivered_at={statement.tally_delivered_at}
                  />
                </div>
              </div>
              {/* Where this invoice actually stands, in the terms of whichever
                  mode raised it — a proforma is about payment, a gst_direct
                  invoice is about whether accounts have issued it in Tally. */}
              {(() => {
                const gstIssued = !!(statement.gst_invoice_number || statement.tally_invoice_number);
                const gstNumber = statement.tally_invoice_number || statement.gst_invoice_number;
                const isPaid = statement.payment_status === "paid";
                const requestedAt = statement.created_at;

                if (isUnsentPi) {
                  return (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Proforma created{requestedAt ? ` on ${formatDate(requestedAt)}` : ""} but not yet sent to the customer.
                    </div>
                  );
                }

                if (resolvedBillingMode === "proforma_first" && !gstIssued) {
                  return (
                    <div className="space-y-2">
                      <div className={`rounded-md border px-3 py-2 text-xs ${isPaid ? "border-green-200 bg-green-50 text-green-900" : "border-blue-200 bg-blue-50 text-blue-900"}`}>
                        {statement.proforma_sent_at
                          ? `Proforma sent to the customer on ${formatDate(statement.proforma_sent_at)}.`
                          : "Proforma raised."}{" "}
                        {isPaid
                          ? "Paid — it now routes to the Tally Inbox for the GST invoice."
                          : "Awaiting payment via the payment link."}
                      </div>
                      {statement.proforma_sent_at && (
                        <a
                          href={`/api/billing-statements/${statement.id}/proforma-pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          View proforma invoice <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  );
                }

                if (gstIssued) {
                  return (
                    <div className="space-y-2">
                      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
                        GST invoice issued by accounts{gstNumber ? <> — <span className="font-mono">{gstNumber}</span></> : null}
                        {statement.tally_delivered_at ? ` on ${formatDate(statement.tally_delivered_at)}` : ""}.
                        {statement.tally_irn && <> IRN on file.</>}
                      </div>
                      <a
                        href={`/api/billing-statements/${statement.id}/gst-invoice-pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <FileCheck className="h-3.5 w-3.5" />
                        View GST invoice <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  );
                }

                return (
                  <div className="space-y-2">
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Pending with accounts — requested{requestedAt ? ` on ${formatDate(requestedAt)}` : ""}, waiting for the GST invoice to be issued in Tally.
                    </div>
                    <Link
                      href={`/accounting/inbox?id=${statement.id}`}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      View in Tally Inbox <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                );
              })()}
              {/* What went to accounts. The Tally Inbox link above is useless
                  to sales and case-handling roles — they have no access to
                  that page — so the same details are readable here. */}
              <div className="rounded-md border">
                <button
                  type="button"
                  onClick={handleToggleDetails}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/40"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                    View invoice details
                  </span>
                  {detailsLoading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : detailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {detailsOpen && details && (
                  <div className="border-t px-3 py-2.5 space-y-2.5 text-sm">
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Billed to</p>
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-medium min-w-0">{details.buyerName}</span>
                        <Badge variant="outline" className="shrink-0 text-xs">
                          {details.billToAggregator ? "Aggregator" : "Client"}
                        </Badge>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">GSTIN</span>
                        <span className="font-mono">{details.buyerGstin || "— (B-series, no IRN)"}</span>
                      </div>
                      {details.billToAggregator && details.endClientName && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">On behalf of</span>
                          <span>{details.endClientName}{details.caseNumber ? ` · ${details.caseNumber}` : ""}</span>
                        </div>
                      )}
                    </div>

                    <Separator />

                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Charges</p>
                      {details.lines.length > 0 ? (
                        details.lines.map((l, i) => (
                          <div key={i} className="flex justify-between gap-3 text-xs">
                            <span className="min-w-0">
                              {l.description}
                              {l.quantity !== 1 && (
                                <span className="text-muted-foreground"> · {l.quantity} × {formatCurrency(l.rate)}</span>
                              )}
                            </span>
                            <span className="tabular-nums shrink-0">{formatCurrency(l.amount)}</span>
                          </div>
                        ))
                      ) : (
                        <div className="flex justify-between gap-3 text-xs">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span className="tabular-nums">{formatCurrency(details.subtotal)}</span>
                        </div>
                      )}
                      {details.periodStart && details.periodEnd && (
                        <div className="flex justify-between text-xs pt-1">
                          <span className="text-muted-foreground">Period</span>
                          <span>{formatDate(details.periodStart)} → {formatDate(details.periodEnd)}</span>
                        </div>
                      )}
                      {details.placeOfSupply && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Place of supply</span>
                          <span>
                            {details.placeOfSupply}
                            {details.isInterstate && <span className="text-amber-700"> (interstate · IGST)</span>}
                          </span>
                        </div>
                      )}
                    </div>

                    <Separator />

                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span className="tabular-nums">{formatCurrency(details.subtotal)}</span>
                      </div>
                      {details.isInterstate ? (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">IGST @ {details.taxPercentage}%</span>
                          <span className="tabular-nums">{formatCurrency(details.igst)}</span>
                        </div>
                      ) : (
                        <>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">CGST @ {details.taxPercentage / 2}%</span>
                            <span className="tabular-nums">{formatCurrency(details.cgst)}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">SGST @ {details.taxPercentage / 2}%</span>
                            <span className="tabular-nums">{formatCurrency(details.sgst)}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-between font-semibold pt-0.5">
                        <span>Total</span>
                        <span className="tabular-nums">{formatCurrency(details.total)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {isUnsentPi && (
                <Button size="sm" onClick={handleGenerateInvoice} disabled={generating}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  Send Invoice
                </Button>
              )}
              {statement.issuance_channel === "tally" &&
                statement.status !== "voided" &&
                !!userRole &&
                CREDIT_NOTE_ROLES.includes(userRole) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-700 border-red-200 hover:bg-red-50"
                    onClick={() => setShowCreditNoteCancel(true)}
                  >
                    <Ban className="mr-1.5 h-3.5 w-3.5" />
                    Cancel Invoice
                  </Button>
                )}
              {canVoid && !showVoidConfirm && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-700 border-red-200 hover:bg-red-50"
                  onClick={() => setShowVoidConfirm(true)}
                >
                  <Ban className="mr-1.5 h-3.5 w-3.5" />
                  Void Invoice
                </Button>
              )}
              {canVoid && showVoidConfirm && (
                <div className="w-full space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-xs text-red-800">
                    This voids the statement and un-links it back to pending — blocked if any payment has already been recorded.
                  </p>
                  <Textarea
                    placeholder="Reason for void / cancellation (required)"
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    rows={2}
                    className="bg-background"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setShowVoidConfirm(false); setVoidReason(""); }}
                      disabled={voidSubmitting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleVoid}
                      disabled={voidSubmitting || !voidReason.trim()}
                    >
                      {voidSubmitting ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Ban className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Confirm Void
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {statement && showCreditNoteCancel && (
        <CreditNoteUploadDialog
          statement={{
            id: statement.id,
            statement_number: statement.statement_number,
            tally_invoice_number: statement.tally_invoice_number,
            total_amount: statement.total_amount,
            payment_status: statement.payment_status,
          }}
          onCancelled={() => {
            setShowCreditNoteCancel(false);
            load();
          }}
          onClose={() => setShowCreditNoteCancel(false)}
        />
      )}

      {/* Confirm-before-generate: nothing has been created at this point. */}
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!open) { setConfirmOpen(false); setConfirmPreview(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm invoice</DialogTitle>
            <DialogDescription>
              {confirmPreview?.billingMode === "gst_direct"
                ? "Nothing has been created yet. On confirm, this invoice is raised and sent to accounts in the Tally Inbox for the GST invoice to be issued."
                : "Nothing has been created yet. On confirm, a proforma invoice is prepared — you will review the recipient before it is emailed."}
            </DialogDescription>
          </DialogHeader>

          {confirmPreview && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Bill to</p>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{confirmPreview.buyerName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {confirmPreview.buyerEmail || "No email on file"}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {confirmPreview.billTo === "aggregator" ? "Aggregator" : "Client"}
                  </Badge>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">GSTIN</span>
                  <span className="font-mono">{confirmPreview.buyerGstin || "— (B-series, no IRN)"}</span>
                </div>
                {confirmPreview.billTo === "aggregator" && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">On behalf of</span>
                    <span>{confirmPreview.endClientName}</span>
                  </div>
                )}
              </div>

              <div className="rounded-md border p-3 space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">For</p>
                <div className="flex justify-between gap-3">
                  <span className="min-w-0">{confirmPreview.description}</span>
                  <span className="tabular-nums shrink-0">{formatCurrency(confirmPreview.subtotal)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Period</span>
                  <span>
                    {formatDate(confirmPreview.periodStart)} → {formatDate(confirmPreview.periodEnd)}
                    <span className="text-muted-foreground"> · {confirmPreview.tenureMonths} mo</span>
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Place of supply</span>
                  <span>
                    {confirmPreview.placeOfSupply}
                    {confirmPreview.isInterstate && <span className="text-amber-700"> (interstate · IGST)</span>}
                  </span>
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="tabular-nums">{formatCurrency(confirmPreview.subtotal)}</span>
                </div>
                {confirmPreview.isInterstate ? (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">IGST @ {confirmPreview.gstRate}%</span>
                    <span className="tabular-nums">{formatCurrency(confirmPreview.igst)}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">CGST @ {confirmPreview.gstRate / 2}%</span>
                      <span className="tabular-nums">{formatCurrency(confirmPreview.cgst)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">SGST @ {confirmPreview.gstRate / 2}%</span>
                      <span className="tabular-nums">{formatCurrency(confirmPreview.sgst)}</span>
                    </div>
                  </>
                )}
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(confirmPreview.total)}</span>
                </div>
              </div>

              {!confirmPreview.buyerEmail && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  No email on file for {confirmPreview.buyerName} — the invoice will be created but cannot be emailed.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmPreview(null); }}>
              Cancel
            </Button>
            <Button onClick={handleConfirmGenerate} disabled={generating}>
              {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCheck className="mr-2 h-4 w-4" />}
              {confirmPreview?.billingMode === "gst_direct" ? "Raise & send to accounts" : "Create proforma"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Invoice Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={(open) => { if (!open) resetPreviewState(); else setPreviewOpen(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Proforma Invoice</DialogTitle>
            <DialogDescription>
              Review the recipient and amount before sending. A Razorpay payment link will be included.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
            <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">Invoice Summary</p>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reference</span>
              <span className="font-mono">{preview?.statementNumber ?? "—"}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>Total Due</span>
              <span>{formatCurrency(preview?.totalAmount ?? 0)}</span>
            </div>
          </div>

          {preview?.statementId && (
            <a
              href={`/api/billing-statements/${preview.statementId}/proforma-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              Preview invoice PDF — exactly what the customer will receive
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">To (primary — cannot be removed)</p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="text-sm min-w-0">
                  {primaryEmail ? (
                    <>
                      <span className="font-medium">{primaryName}</span>
                      <span className="text-muted-foreground ml-1.5 truncate">&lt;{primaryEmail}&gt;</span>
                    </>
                  ) : (
                    <span className="text-amber-600 text-xs">No email on file — invoice will be created but not emailed</span>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">CC (optional)</p>
              {ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ccEmails.map((email) => (
                    <span key={email} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                      {email}
                      <button onClick={() => setCcEmails((prev) => prev.filter((e) => e !== email))} className="text-muted-foreground hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="email"
                  value={ccInput}
                  onChange={(e) => setCcInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCcEmail(); } }}
                  placeholder="Add CC email and press Enter"
                  className="flex-1 text-sm border rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button size="sm" variant="outline" onClick={addCcEmail} type="button">Add</Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetPreviewState}>
              Cancel
            </Button>
            <Button disabled={sending} onClick={handleConfirmSend}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send Invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
