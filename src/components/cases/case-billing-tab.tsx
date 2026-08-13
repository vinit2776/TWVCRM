"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Loader2, FileText, ExternalLink, FileCheck, Zap, Ban, Send, Mail, X } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency, formatDate } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, type HandoffState } from "@/lib/tally-handoff";
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
  aggregator: { billing_method?: string; billing_mode?: "proforma_first" | "gst_direct"; name?: string; primary_email?: string | null } | null;
}

interface CaseStatement {
  id: string;
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
  statementNumber: string | null;
  totalAmount: number;
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
    ? caseInfo?.aggregator?.name ?? ""
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

  // "Generate Invoice" (or "Send Invoice" for an already-created-but-unsent
  // statement — see isUnsentPi). For proforma_first this creates the
  // statement without dispatching and opens the preview dialog; the actual
  // send happens from there via handleConfirmSend. gst_direct is unaffected
  // — it never dispatches from this route, so the whole preview step is
  // skipped and it goes straight to the Tally Inbox as before.
  const handleGenerateInvoice = async () => {
    if (isUnsentPi && statement) {
      setPreview({ statementNumber: statement.statement_number, totalAmount: statement.total_amount });
      setPreviewOpen(true);
      return;
    }
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
              <Button onClick={handleGenerateInvoice} disabled={generating || needsBillTo}>
                {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
              {(() => {
                const viewHref = statement.gst_invoice_number
                  ? `/api/billing-statements/${statement.id}/gst-invoice-pdf`
                  : statement.proforma_sent_at
                    ? `/api/billing-statements/${statement.id}/proforma-pdf`
                    : null;
                return viewHref ? (
                  <a
                    href={viewHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    View Invoice <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null;
              })()}
              {statement.handoff_state ? (
                <Link
                  href={`/accounting/inbox?id=${statement.id}`}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  View in Tally Inbox <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : statement.proforma_sent_at ? (
                <p className="text-xs text-muted-foreground">
                  Proforma invoice sent to the customer on {formatDate(statement.proforma_sent_at)} — awaiting payment via the payment link.
                </p>
              ) : isUnsentPi ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Invoice created but not yet sent to the customer.
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Awaiting payment — this invoice will route to the Tally Inbox once paid.
                </p>
              )}
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
