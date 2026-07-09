"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, Send, ExternalLink, CheckCircle2, AlertTriangle, FileText, X, Mail, Copy, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Contract } from "@/types";

interface StatementState {
  payment_status: string | null;
  proforma_sent_at: string | null;
  handoff_state: string | null;
  gst_invoice_number: string | null;
  issuance_channel: string | null;
  razorpay_payment_link_url: string | null;
}

interface Props {
  contract: Contract;
  userRole: string | null;
  onSuccess: () => void;
}

export function ContractProrataSection({ contract, userRole, onSuccess }: Props) {
  const [sending, setSending] = useState(false);
  const [piPreviewOpen, setPiPreviewOpen] = useState(false);
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  const [gstConfirmOpen, setGstConfirmOpen] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const [waiving, setWaiving] = useState(false);
  const [stmtState, setStmtState] = useState<StatementState | null>(null);

  const fetchStmtState = useCallback(async () => {
    if (!contract.prorata_billing_statement_id) return;
    const res = await fetch(
      `/api/billing-statements/${contract.prorata_billing_statement_id}?fields=payment_status,proforma_sent_at,handoff_state,gst_invoice_number,razorpay_payment_link_url`
    );
    if (res.ok) {
      const json = await res.json();
      setStmtState(json.data || null);
    }
  }, [contract.prorata_billing_statement_id]);

  useEffect(() => { fetchStmtState(); }, [fetchStmtState]);

  if (!contract.is_renewal || contract.prorata_payment_status === "not_applicable") {
    return null;
  }

  // Calculate display values
  const startDate = new Date(contract.start_date + "T00:00:00Z");
  const startDay = startDate.getUTCDate();
  const startMonth = startDate.getUTCMonth();
  const startYear = startDate.getUTCFullYear();
  const daysInMonth = new Date(Date.UTC(startYear, startMonth + 1, 0)).getUTCDate();
  const prorataDays = daysInMonth - startDay + 1;
  const periodEndDate = new Date(Date.UTC(startYear, startMonth + 1, 0)).toISOString().slice(0, 10);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const monthlySubtotal = Number(contract.subtotal || 0);
  const taxPercentage = Number(contract.tax_percentage || 18);
  const prorataSubtotal = Math.round((monthlySubtotal / daysInMonth) * prorataDays * 100) / 100;
  const prorataTotal = Math.round(prorataSubtotal * (1 + taxPercentage / 100) * 100) / 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract.lead as any;
  const primaryEmail = lead?.email as string | undefined;
  const leadName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "";
  const company = lead?.company as string | undefined;

  const contractStatus = contract.prorata_payment_status as string;

  type DisplayState = "unsent" | "pi_sent" | "gst_in_tally" | "paid" | "waived";
  let displayState: DisplayState = "unsent";
  if (contractStatus === "paid") {
    displayState = "paid";
  } else if (contractStatus === "waived") {
    displayState = "waived";
  } else if (stmtState) {
    if (stmtState.payment_status === "paid") {
      displayState = "paid";
    } else if (
      stmtState.issuance_channel === "tally" ||
      stmtState.handoff_state === "direct_gst_requested" ||
      stmtState.handoff_state === "name_check_pending" ||
      stmtState.handoff_state === "ready_to_send" ||
      stmtState.handoff_state === "gst_sent" ||
      stmtState.handoff_state === "gst_sent_awaiting_payment"
    ) {
      displayState = "gst_in_tally";
    } else if (stmtState.proforma_sent_at) {
      displayState = "pi_sent";
    }
  }

  const canSendGst = ["admin", "accounts"].includes(userRole ?? "");

  const addCcEmail = () => {
    const email = ccInput.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
    setCcEmails(prev => [...prev, email]);
    setCcInput("");
  };

  const handleDispatch = async (mode: "proforma" | "gst_direct", cc: string[] = []) => {
    setSending(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/prorata-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, cc }),
      });
      if (res.ok) {
        const data = await res.json();
        if (mode === "gst_direct") {
          toast.success(data.routedToTally ? "Routed to Tally inbox — accounts will issue the GST invoice" : "GST invoice dispatched");
        } else if (data.noContact) {
          toast.warning("PI created but no email/phone on file — contact client manually.");
        } else {
          toast.success(`PI sent to ${data.emailedTo}`);
        }
        await fetchStmtState();
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to send");
      }
    } finally {
      setSending(false);
    }
  };

  const handleSendPI = async () => {
    setPiPreviewOpen(false);
    await handleDispatch("proforma", ccEmails);
    setCcEmails([]);
  };

  const handleWaive = async () => {
    if (!waiveReason.trim()) { toast.error("Waiver reason is required"); return; }
    setWaiving(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/prorata-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waive: true, waive_reason: waiveReason.trim() }),
      });
      if (res.ok) {
        toast.success("Pro-rata collection waived");
        setWaiveOpen(false);
        setWaiveReason("");
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to waive");
      }
    } finally {
      setWaiving(false);
    }
  };

  const borderColor =
    displayState === "paid" ? "border-green-300" :
    displayState === "waived" ? "border-gray-200" :
    displayState === "gst_in_tally" ? "border-blue-300" :
    "border-amber-300";

  return (
    <>
      <Card className={borderColor}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Pro-Rata Collection</span>
            {displayState === "unsent" && <Badge className="bg-amber-100 text-amber-800 border-amber-300">Pending</Badge>}
            {displayState === "pi_sent" && <Badge className="bg-amber-100 text-amber-800 border-amber-300">PI Sent — Awaiting Payment</Badge>}
            {displayState === "gst_in_tally" && <Badge className="bg-blue-100 text-blue-800 border-blue-300">GST Invoice in Tally</Badge>}
            {displayState === "paid" && (
              <Badge className="bg-green-100 text-green-800 border-green-300">
                <CheckCircle2 className="h-3 w-3 mr-1" />Paid
              </Badge>
            )}
            {displayState === "waived" && <Badge className="bg-gray-100 text-gray-700 border-gray-300">Waived</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Period</span>
            <span>{formatDate(contract.start_date)} – {formatDate(periodEndDate)}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Days</span>
            <span>{prorataDays} of {daysInMonth} days</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCurrency(prorataSubtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">GST ({taxPercentage}%)</span>
            <span>{formatCurrency(prorataTotal - prorataSubtotal)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCurrency(prorataTotal)}</span>
          </div>

          {displayState === "unsent" && (
            <>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <p>Contract cannot be activated until pro-rata is paid or waived.</p>
              </div>
              <Button size="sm" className="w-full" onClick={() => setPiPreviewOpen(true)} disabled={sending}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Send PI
              </Button>
              {canSendGst && (
                <Button size="sm" variant="outline" className="w-full text-blue-700 border-blue-300 hover:bg-blue-50" onClick={() => setGstConfirmOpen(true)} disabled={sending}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Send GST Direct → Tally Inbox
                </Button>
              )}
              {userRole === "admin" && (
                <Button size="sm" variant="ghost" className="w-full text-muted-foreground" onClick={() => setWaiveOpen(true)}>
                  Waive Collection
                </Button>
              )}
            </>
          )}

          {displayState === "pi_sent" && (
            <>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <p>PI sent. Contract activates once payment is received.</p>
                </div>
                {stmtState?.proforma_sent_at && (
                  <div className="flex items-center gap-1.5 text-amber-700">
                    <Clock className="h-3 w-3 shrink-0" />
                    <span>Sent on {new Date(stmtState.proforma_sent_at).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                )}
                {stmtState?.razorpay_payment_link_url && (
                  <div className="space-y-1">
                    <p className="text-amber-700 font-medium">Payment link (for WhatsApp / manual share):</p>
                    <div className="flex items-center gap-1.5">
                      <span className="flex-1 truncate font-mono text-[10px] bg-white border border-amber-200 rounded px-2 py-1 select-all">
                        {stmtState.razorpay_payment_link_url}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(stmtState.razorpay_payment_link_url!);
                          toast.success("Payment link copied");
                        }}
                        className="shrink-0 p-1.5 rounded hover:bg-amber-100 text-amber-700"
                        title="Copy link"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <Button size="sm" variant="outline" className="w-full" onClick={() => setPiPreviewOpen(true)} disabled={sending}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Resend PI (fresh link)
              </Button>
              {canSendGst && (
                <Button size="sm" variant="outline" className="w-full text-blue-700 border-blue-300 hover:bg-blue-50" onClick={() => setGstConfirmOpen(true)} disabled={sending}>
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Switch to GST Direct → Tally Inbox
                </Button>
              )}
            </>
          )}

          {displayState === "gst_in_tally" && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <p className="font-semibold mb-1">GST invoice in Tally inbox</p>
              <p>Accounts is issuing the GST invoice. Once sent and paid, contract will be activatable.</p>
            </div>
          )}

          {displayState === "paid" && (
            <p className="text-xs text-green-700 font-medium">✓ Payment received — contract can be activated</p>
          )}

          {displayState === "waived" && (
            <p className="text-xs text-muted-foreground">Admin waived pro-rata collection for this renewal.</p>
          )}

          {contract.prorata_billing_statement_id && displayState !== "paid" && displayState !== "waived" && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full text-xs text-muted-foreground"
              onClick={() => window.open(`/api/billing-statements/${contract.prorata_billing_statement_id}/proforma-pdf`, "_blank")}
            >
              <ExternalLink className="mr-1.5 h-3 w-3" />
              View Statement
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Send PI Preview Dialog */}
      <Dialog open={piPreviewOpen} onOpenChange={(open) => { setPiPreviewOpen(open); if (!open) { setCcEmails([]); setCcInput(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Proforma Invoice</DialogTitle>
            <DialogDescription>
              Review the recipient and amount before sending. A Razorpay payment link will be included.
            </DialogDescription>
          </DialogHeader>

          {/* What's being sent */}
          <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
            <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">Invoice Summary</p>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pro-Rata Workspace Fee</span>
              <span>{monthNames[startMonth]} {startDay}–{daysInMonth}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCurrency(prorataSubtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">GST ({taxPercentage}%)</span>
              <span>{formatCurrency(prorataTotal - prorataSubtotal)}</span>
            </div>
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>Total Due</span>
              <span>{formatCurrency(prorataTotal)}</span>
            </div>
          </div>

          {/* Recipients */}
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">To (primary — cannot be removed)</p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="text-sm min-w-0">
                  {primaryEmail ? (
                    <>
                      <span className="font-medium">{leadName}{company ? ` · ${company}` : ""}</span>
                      <span className="text-muted-foreground ml-1.5 truncate">&lt;{primaryEmail}&gt;</span>
                    </>
                  ) : (
                    <span className="text-amber-600 text-xs">No email on file — PI will be created but not emailed</span>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">CC (optional)</p>
              {ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ccEmails.map(email => (
                    <span key={email} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                      {email}
                      <button onClick={() => setCcEmails(prev => prev.filter(e => e !== email))} className="text-muted-foreground hover:text-foreground">
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
                  onChange={e => setCcInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCcEmail(); } }}
                  placeholder="Add CC email and press Enter"
                  className="flex-1 text-sm border rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button size="sm" variant="outline" onClick={addCcEmail} type="button">Add</Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setPiPreviewOpen(false); setCcEmails([]); setCcInput(""); }}>
              Cancel
            </Button>
            <Button disabled={sending} onClick={handleSendPI}>
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {displayState === "pi_sent" ? "Resend PI" : "Send PI"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* GST Direct Confirm Dialog */}
      <Dialog open={gstConfirmOpen} onOpenChange={setGstConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send GST Invoice Direct?</DialogTitle>
            <DialogDescription>
              This skips the Proforma Invoice and routes the pro-rata directly to the
              Tally inbox. The accounts team will issue a GST tax invoice which is then
              sent to the client with a payment link.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
            <p className="font-semibold">Only use this when the client specifically requests a GST invoice upfront.</p>
            <p>For most renewals, use <strong>Send PI</strong> instead — it is faster and does not require accounts team involvement.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGstConfirmOpen(false)}>
              Cancel — use Send PI instead
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              disabled={sending}
              onClick={async () => {
                setGstConfirmOpen(false);
                await handleDispatch("gst_direct");
              }}
            >
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Yes, route to Tally Inbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Waive Dialog */}
      <Dialog open={waiveOpen} onOpenChange={setWaiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Waive Pro-Rata Collection</DialogTitle>
            <DialogDescription>
              This will allow the renewal contract to be activated without collecting the{" "}
              {formatCurrency(prorataTotal)} pro-rata for {formatDate(contract.start_date)} – {formatDate(periodEndDate)}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Reason <span className="text-destructive">*</span></label>
            <input
              type="text"
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              placeholder="e.g. Collected offline / included in deposit"
              className="w-full text-sm border rounded px-3 py-1.5"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={!waiveReason.trim() || waiving} onClick={handleWaive}>
              {waiving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Waive Collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
