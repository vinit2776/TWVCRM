"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, ExternalLink, FileText, Receipt, FileCheck, Zap, AlertTriangle } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { StatementLifecycleBadge, StatementQuickActions } from "@/components/accounting/statement-lifecycle";

interface Statement {
  id: string;
  statement_number: string;
  period_start: string;
  period_end: string;
  total_amount: number;
  status: string;
  payment_status: string | null;
  gst_invoice_number: string | null;
  gst_invoice_path: string | null;
  razorpay_payment_link_url: string | null;
  finalized_at: string | null;
  pi_cancelled_at: string | null;
}

const STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
  voided: "Voided",
};

const STATEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  finalized: "bg-blue-50 text-blue-700 border-blue-200",
  exported: "bg-purple-50 text-purple-700 border-purple-200",
  voided: "bg-red-50 text-red-600 border-red-200",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partial",
  paid: "Paid",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-green-50 text-green-700 border-green-200",
};

function periodLabel(start: string, end: string) {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const month = s.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  const year = s.getUTCFullYear();
  // If period spans a single calendar month, show "Jun 2025"; otherwise show date range
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${month} ${year}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

interface ContractInvoicesSectionProps {
  contractId: string;
  billingMode?: 'proforma_first' | 'gst_direct' | null;
  contractStatus?: string;
  /** Proposal linked to this contract — the pro-rata invoice that was
   *  collected before activation lives on the proposal, not the contract,
   *  so it needs its own lookup rather than showing up in `statements`. */
  proposalId?: string;
  proposalNumber?: string;
  prorataPaymentStatus?: string;
  prorataPaymentReceivedAt?: string;
}

export function ContractInvoicesSection({
  contractId,
  billingMode,
  contractStatus,
  proposalId,
  proposalNumber,
  prorataPaymentStatus,
  prorataPaymentReceivedAt,
}: ContractInvoicesSectionProps) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [currentMode, setCurrentMode] = useState<'proforma_first' | 'gst_direct'>(billingMode || 'proforma_first');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [pendingModeDialogOpen, setPendingModeDialogOpen] = useState(false);
  const [convertReason, setConvertReason] = useState(
    "Contract billing mode switched to GST Direct — clearing pending proforma."
  );
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [prorataStatement, setProrataStatement] = useState<Statement | null>(null);

  useEffect(() => {
    setCurrentMode(billingMode || 'proforma_first');
  }, [billingMode]);

  const refreshStatements = () => {
    return fetch(`/api/billing-statements?contract_id=${contractId}&limit=100`)
      .then((r) => r.json())
      .then((d) => setStatements((d.data || []) as Statement[]))
      .catch(() => setStatements([]));
  };

  useEffect(() => {
    refreshStatements().finally(() => setLoading(false));
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => setUserRole(d.role ?? null))
      .catch(() => setUserRole(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  // The pro-rata invoice (generated via the proposal's "Preview & Send GST
  // Invoice" step) is a billing_statements row keyed by proposal_id, not
  // contract_id — the contract didn't exist yet when it was sent.
  useEffect(() => {
    if (!proposalId) {
      setProrataStatement(null);
      return;
    }
    fetch(`/api/billing-statements?proposal_id=${proposalId}&limit=1`)
      .then((r) => r.json())
      .then((d) => setProrataStatement(((d.data || []) as Statement[])[0] || null))
      .catch(() => setProrataStatement(null));
  }, [proposalId]);

  // Proformas still open under the old Proforma First flow — switching to
  // GST Direct only affects future cycles, so these are left behind unless
  // resolved via the GST override (convert-to-gst-early).
  const pendingUnpaidStatements = useMemo(
    () =>
      statements.filter(
        (s) =>
          s.status === "finalized" &&
          s.payment_status !== "paid" &&
          !s.gst_invoice_number &&
          !s.pi_cancelled_at
      ),
    [statements]
  );

  const applyModeChange = async (newMode: 'proforma_first' | 'gst_direct') => {
    setSavingMode(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: newMode }),
      });
      if (res.ok) {
        setCurrentMode(newMode);
        toast.success(newMode === 'gst_direct' ? "GST Direct billing enabled from next cycle" : "Proforma First billing restored from next cycle");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update billing mode");
      }
    } catch {
      toast.error("Failed to update billing mode");
    } finally {
      setSavingMode(false);
    }
  };

  const handleModeChange = async (newMode: 'proforma_first' | 'gst_direct') => {
    if (newMode === currentMode) return;
    if (newMode === 'gst_direct' && pendingUnpaidStatements.length > 0) {
      setPendingModeDialogOpen(true);
      return;
    }
    await applyModeChange(newMode);
  };

  const handleConvertToGst = async (statementId: string) => {
    setConvertingId(statementId);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/convert-to-gst-early`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: convertReason }),
      });
      if (res.ok) {
        toast.success("PI cancelled — queued for GST invoice in Tally Inbox");
        await refreshStatements();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to convert to GST");
      }
    } catch {
      toast.error("Failed to convert to GST");
    } finally {
      setConvertingId(null);
    }
  };

  // Show toggle for active/live contracts — locked for terminated/expired/completed/renewed
  const canEditMode = !contractStatus || ["active", "renewal_in_progress", "draft", "sent", "accepted"].includes(contractStatus);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Monthly Invoices
        </CardTitle>
        <Link href={`/billing?contract_id=${contractId}`}>
          <Button variant="ghost" size="sm">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            Billing
          </Button>
        </Link>
      </CardHeader>

      {/* Pro-rata invoice — collected via the proposal before the contract
          existed, so it never shows up in the monthly statements table below. */}
      {proposalId && (
        <div className="px-6 pb-3">
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-muted-foreground">Pro-rata Invoice</span>
              {prorataStatement ? (
                <Link
                  href={`/api/billing-statements/${prorataStatement.id}/proforma-pdf`}
                  target="_blank"
                  className="font-mono text-primary hover:underline"
                >
                  {prorataStatement.statement_number}
                </Link>
              ) : proposalNumber ? (
                <Link href={`/proposals/${proposalId}`} className="text-primary hover:underline">
                  via {proposalNumber}
                </Link>
              ) : null}
              {(prorataStatement?.total_amount ?? undefined) !== undefined && (
                <span className="text-muted-foreground">· {formatCurrency(prorataStatement!.total_amount)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const paid = prorataStatement ? prorataStatement.payment_status === "paid" : prorataPaymentStatus === "paid";
                const paidAt = prorataStatement ? undefined : prorataPaymentReceivedAt;
                return (
                  <>
                    {paid && paidAt && (
                      <span className="text-[10px] text-muted-foreground">{formatDate(paidAt)}</span>
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${paid ? PAYMENT_STATUS_COLORS.paid : PAYMENT_STATUS_COLORS.unpaid}`}
                    >
                      {paid ? "Paid" : "Unpaid"}
                    </Badge>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Billing mode toggle */}
      {canEditMode && (
        <div className="px-6 pb-3">
          <p className="text-xs text-muted-foreground mb-2 font-medium">Invoice Type (from next billing cycle)</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleModeChange('proforma_first')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'proforma_first'
                  ? 'bg-[#015E65] text-white border-[#015E65]'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <FileCheck className="h-3.5 w-3.5 shrink-0" />
              Proforma First
            </button>
            <button
              onClick={() => handleModeChange('gst_direct')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'gst_direct'
                  ? 'bg-violet-700 text-white border-violet-700'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <Zap className="h-3.5 w-3.5 shrink-0" />
              GST Direct
            </button>
          </div>
          {currentMode === 'gst_direct' && (
            <p className="text-[10px] text-violet-700 mt-1.5">
              Tax invoice issued directly each cycle · Due date = issue date + 7 days · No proforma
            </p>
          )}
        </div>
      )}

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : statements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No invoices generated yet. Statements are created automatically each month after contract activation.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-4">Period</th>
                  <th className="text-left font-medium pb-2 pr-4">Proforma #</th>
                  <th className="text-right font-medium pb-2 pr-4">Amount</th>
                  <th className="text-left font-medium pb-2 pr-4">Status</th>
                  <th className="text-left font-medium pb-2 pr-4">Payment</th>
                  <th className="text-left font-medium pb-2 pr-4">GST Invoice</th>
                  <th className="text-left font-medium pb-2">Tally Lifecycle</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {statements.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {periodLabel(s.period_start, s.period_end)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/api/billing-statements/${s.id}/proforma-pdf`}
                        target="_blank"
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {s.statement_number}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium whitespace-nowrap">
                      {formatCurrency(s.total_amount)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${STATEMENT_STATUS_COLORS[s.status] ?? ""}`}
                      >
                        {STATEMENT_STATUS_LABELS[s.status] ?? s.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.payment_status ? (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${PAYMENT_STATUS_COLORS[s.payment_status] ?? ""}`}
                        >
                          {PAYMENT_STATUS_LABELS[s.payment_status] ?? s.payment_status}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.gst_invoice_number ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-green-700">{s.gst_invoice_number}</span>
                          {s.gst_invoice_path && (
                            <Button variant="ghost" size="icon" className="h-5 w-5" asChild>
                              <a href={s.gst_invoice_path} target="_blank" rel="noopener noreferrer" title="Download GST Invoice">
                                <FileText className="h-3 w-3" />
                              </a>
                            </Button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">
                          {s.payment_status === "paid" ? "Generating…" : "Issued on payment"}
                        </span>
                      )}
                    </td>
                    {/* Tally lifecycle: handoff_state badge + quick-action buttons.
                        Each component self-fetches /api/accounting/inbox?id=… via a
                        shared 30s SWR cache, so badges + actions in the same row
                        share one request. */}
                    <td className="py-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatementLifecycleBadge statementId={s.id} compact />
                        <StatementQuickActions statementId={s.id} compact />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={pendingModeDialogOpen} onOpenChange={setPendingModeDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {pendingUnpaidStatements.length} pending proforma{pendingUnpaidStatements.length > 1 ? "s" : ""} on Proforma First
            </DialogTitle>
            <DialogDescription>
              Switching to GST Direct only changes future billing cycles — it won&apos;t touch these
              existing unpaid proformas. Use the GST override below to cancel a PI and queue it for a
              direct tax invoice instead, or switch now and resolve them later from Accounting → Tally Inbox.
            </DialogDescription>
          </DialogHeader>

          <div className="border rounded-md max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left font-medium py-2 px-3">Period</th>
                  <th className="text-left font-medium py-2 px-3">PI #</th>
                  <th className="text-right font-medium py-2 px-3">Amount</th>
                  <th className="text-left font-medium py-2 px-3">Payment</th>
                  <th className="py-2 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {pendingUnpaidStatements.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 px-3 whitespace-nowrap">{periodLabel(s.period_start, s.period_end)}</td>
                    <td className="py-2 px-3 font-mono text-xs">{s.statement_number}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(s.total_amount)}</td>
                    <td className="py-2 px-3">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${PAYMENT_STATUS_COLORS[s.payment_status ?? ""] ?? ""}`}
                      >
                        {PAYMENT_STATUS_LABELS[s.payment_status ?? ""] ?? s.payment_status}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      {userRole && ["admin", "manager"].includes(userRole) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={convertingId === s.id}
                          onClick={() => handleConvertToGst(s.id)}
                        >
                          {convertingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Convert to GST"}
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">Admin/manager only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Reason (used for any override triggered above)
            </label>
            <Textarea
              value={convertReason}
              onChange={(e) => setConvertReason(e.target.value)}
              className="text-xs"
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingModeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-violet-700 hover:bg-violet-800 text-white"
              disabled={savingMode}
              onClick={async () => {
                setPendingModeDialogOpen(false);
                await applyModeChange("gst_direct");
              }}
            >
              {savingMode ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Switch to GST Direct anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
