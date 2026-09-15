"use client";

/**
 * UsageCurrentCycleCard
 *
 * One expandable row per contract for the "Current cycle — ready to send"
 * usage category. Replaces the old flat "amount + Open statement" row with
 * an inline review: every line item on the draft statement, waive/add-charge
 * where the backing data supports it, a live total, and a Finalize & Send
 * step that previews the exact email + invoice PDF before dispatch.
 *
 * Waive is only wired for ad-hoc usage_charges (via
 * POST .../waive-charge) — that's the only source with a persisted,
 * individually-toggleable "waived" flag. Facility/service/booking usage are
 * rolled into the statement as aggregate amounts with no per-record billed
 * flag (see unbilled-queue.ts's usage_gap doc comment), so they render
 * read-only here rather than offering a waive button that would silently
 * do nothing.
 */

import { useState, useCallback } from "react";
import { Loader2, ChevronRight, Send, Plus, Eye, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { UnbilledRow } from "@/lib/unbilled-queue";

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  is_waived: boolean;
  waive_reason: string | null;
}
interface FacilityCharge {
  id: string; name: string; unit: string;
  billable_quantity: number; unit_price: number; total_charge: number;
}
interface ServiceCharge {
  id: string; service_name: string; overage: number; rate: number; amount: number;
}
interface BookingCharge {
  id: string; booking_number: string; date: string; space: string; amount: number;
}
interface StatementDetail {
  id: string;
  status: string;
  total_amount: number;
  usage_charges: UsageCharge[];
  facility_charges: FacilityCharge[];
  service_charges: ServiceCharge[];
  booking_charges: BookingCharge[];
}
interface PreviewEmail {
  subject: string;
  to: string[];
  html: string;
  no_contact: boolean;
}

interface Props {
  row: UnbilledRow;
  canBill: boolean;
  onSent: () => void | Promise<void>;
}

export function UsageCurrentCycleCard({ row, canBill, onSent }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [waivingId, setWaivingId] = useState<string | null>(null);
  const [waiveReasonKey, setWaiveReasonKey] = useState<string | null>(null);
  const [waiveReasonText, setWaiveReasonText] = useState("");
  const [waiveReasonError, setWaiveReasonError] = useState(false);

  const [showAddCharge, setShowAddCharge] = useState(false);
  const [addDesc, setAddDesc] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [addUnitPrice, setAddUnitPrice] = useState(0);
  const [savingCharge, setSavingCharge] = useState(false);
  const [unsavedChargeWarning, setUnsavedChargeWarning] = useState(false);

  const [dialogStep, setDialogStep] = useState<"confirm" | "preview" | "sending" | "sent" | null>(null);
  const [previewTab, setPreviewTab] = useState<"email" | "invoice">("email");
  const [previewEmail, setPreviewEmail] = useState<PreviewEmail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendResultMsg, setSendResultMsg] = useState("");
  const [sendNoContact, setSendNoContact] = useState(false);
  const [sent, setSent] = useState(false);

  const statementId = row.statementId!;

  const loadDetail = useCallback(async (): Promise<StatementDetail | null> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      const next: StatementDetail = {
        id: json.data.id,
        status: json.data.status,
        total_amount: Number(json.data.total_amount),
        usage_charges: json.data.usage_charges || [],
        facility_charges: json.data.facility_charges || [],
        service_charges: json.data.service_charges || [],
        booking_charges: json.data.booking_charges || [],
      };
      setDetail(next);
      return next;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load statement");
      return null;
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) void loadDetail();
  };

  /** Un-waive needs no reason — fires immediately. Waive opens the inline
   *  reason input below the row instead of a blocking window.prompt(). */
  const startWaive = (chargeId: string) => {
    setWaiveReasonKey(chargeId);
    setWaiveReasonText("");
    setWaiveReasonError(false);
  };

  const applyWaive = async (charge: UsageCharge, willWaive: boolean, reason?: string) => {
    if (willWaive && !reason?.trim()) { setWaiveReasonError(true); return; }
    setWaiveReasonError(false);
    setWaivingId(charge.id);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/waive-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charge_id: charge.id, waive: willWaive, reason: reason || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update");
      setDetail((prev) => prev ? {
        ...prev,
        total_amount: Number(json.data.total_amount),
        usage_charges: prev.usage_charges.map((c) => c.id === charge.id ? { ...c, is_waived: willWaive, waive_reason: reason || null } : c),
      } : prev);
      setWaiveReasonKey(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update charge");
    } finally {
      setWaivingId(null);
    }
  };

  const saveCharge = async () => {
    if (!addDesc.trim()) { toast.error("Description is required"); return; }
    if (addQty <= 0) { toast.error("Quantity must be positive"); return; }
    if (addUnitPrice < 0) { toast.error("Unit price must be ≥ 0"); return; }
    setSavingCharge(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/add-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: addDesc.trim(), quantity: addQty, unit_price: addUnitPrice }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to add charge");
      // Re-fetch rather than patch total_amount locally — the add-charge
      // response only returns the new charge, not the statement's
      // recalculated (GST-inclusive) total, and this is money: always take
      // the server's number, never approximate it client-side.
      await loadDetail();
      toast.success("Charge added");
      setShowAddCharge(false);
      setUnsavedChargeWarning(false);
      setAddDesc(""); setAddQty(1); setAddUnitPrice(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add charge");
    } finally {
      setSavingCharge(false);
    }
  };

  const openFinalizeDialog = async () => {
    // Don't silently lose a half-typed charge — surface it instead of
    // opening the send dialog underneath it.
    if (showAddCharge) {
      if (!expanded) setExpanded(true);
      setUnsavedChargeWarning(true);
      return;
    }
    setDialogStep("confirm");
    setPreviewEmail(null);
    setPreviewTab("email");
    if (!expanded) setExpanded(true);
    if (!detail) await loadDetail();
  };

  const discardUnsavedCharge = () => {
    setShowAddCharge(false);
    setAddDesc(""); setAddQty(1); setAddUnitPrice(0);
    setUnsavedChargeWarning(false);
  };

  const openPreview = async () => {
    setDialogStep("preview");
    if (!previewEmail) {
      setPreviewLoading(true);
      try {
        const res = await fetch(`/api/billing-statements/${statementId}/preview-send`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load preview");
        setPreviewEmail(json.data);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load preview");
      } finally {
        setPreviewLoading(false);
      }
    }
  };

  // A current_cycle row can already be "finalized" (locked, not yet sent) —
  // e.g. finalized from the statement view and never dispatched.
  // finalize-and-send requires status="draft"; an already-finalized
  // statement is sent via send-proforma instead — same dispatchProforma()
  // under the hood, just skipping the (already-done) finalize step.
  const alreadyFinalized = detail?.status === "finalized";
  // Every item waived (or nothing generated at all) — nothing left to bill.
  // finalize-and-send/send-proforma would reject this server-side anyway;
  // catching it here means the user sees why before they even try.
  const nothingToBill = !!detail && detail.total_amount <= 0;

  const confirmFinalize = async () => {
    if (nothingToBill) return;
    setDialogStep("sending");
    try {
      const endpoint = alreadyFinalized ? "send-proforma" : "finalize-and-send";
      const res = await fetch(`/api/billing-statements/${statementId}/${endpoint}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to send");
      const emailedTo = json.emailed_to ?? json.emailedTo;
      const noContact = json.no_contact ?? json.noContact;
      setSendNoContact(!!noContact);
      setSendResultMsg(
        noContact
          ? "This customer has no email on file, so nothing went out. Add one on the contract, then use Send on this row to try again — it's already finalized, no need to redo the review."
          : `Sent to ${emailedTo || "customer"}.`,
      );
      // A no-contact finalize is still genuinely unsent (proforma_sent_at
      // stays null) — keep the row interactive so Send is retryable here,
      // rather than marking it done like a real send.
      if (noContact) {
        await loadDetail();
      } else {
        setSent(true);
      }
      setDialogStep("sent");
      await onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
      setDialogStep("confirm");
    }
  };

  const closeDialog = () => setDialogStep(null);

  const items = detail ? [
    ...detail.usage_charges.map((c) => ({ key: `uc:${c.id}`, desc: c.description, source: "Ad-hoc / Print", amount: c.total, waived: c.is_waived, waivable: true, charge: c })),
    ...detail.facility_charges.map((f) => ({ key: `fc:${f.id}`, desc: `${f.name} — ${f.billable_quantity} ${f.unit} over quota`, source: "Facility usage", amount: f.total_charge, waived: false, waivable: false, charge: null })),
    ...detail.service_charges.map((s) => ({ key: `sc:${s.id}`, desc: `${s.service_name} — ${s.overage} over quota`, source: "Print / service log", amount: s.amount, waived: false, waivable: false, charge: null })),
    ...detail.booking_charges.filter((b) => b.amount > 0).map((b) => ({ key: `bc:${b.id}`, desc: `Booking ${b.booking_number} — ${b.space}`, source: "Booking overage", amount: b.amount, waived: false, waivable: false, charge: null })),
  ] : [];

  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/30" onClick={toggle}>
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              <span className="font-mono text-xs text-teal-700">{row.contractNumber}</span>
              {" → "}{row.customerName}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {row.periodLabel}{items.length > 0 ? ` · ${items.length} item${items.length > 1 ? "s" : ""}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm font-mono">
            {sent ? formatCurrency(detail?.total_amount ?? row.amount ?? 0) : (detail ? formatCurrency(detail.total_amount) : (row.amount != null ? formatCurrency(row.amount) : "—"))}
          </span>
          {sent ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 text-xs font-semibold">✓ Sent</span>
          ) : canBill ? (
            <Button
              size="sm"
              className="h-7 bg-teal-700 hover:bg-teal-800 text-xs"
              onClick={(e) => { e.stopPropagation(); void openFinalizeDialog(); }}
            >
              <Send className="h-3 w-3 mr-1" />{detail?.status === "finalized" ? "Send" : "Finalize & Send"}
            </Button>
          ) : null}
        </div>
      </div>

      {expanded && !sent && (
        <div className="px-4 pb-3">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-3"><Loader2 className="h-3 w-3 animate-spin" /> Loading items…</div>
          ) : detail ? (
            <>
              {detail.status === "finalized" && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 mb-2">
                  Already finalized — items are locked. Click Send to dispatch it.
                </p>
              )}
              <div className="rounded-md border divide-y text-sm mb-2">
                {items.map((it) => (
                  <div key={it.key} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className={`truncate ${it.waived ? "line-through text-muted-foreground" : ""}`}>{it.desc}</p>
                        <p className="text-[10.5px] text-muted-foreground mt-0.5">
                          {it.source}
                          {it.waived && it.charge?.waive_reason ? ` · waived: ${it.charge.waive_reason}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`font-mono text-xs ${it.waived ? "text-muted-foreground line-through" : ""}`}>{formatCurrency(it.amount)}</span>
                        {it.waivable && canBill && detail.status === "draft" && (
                          <button
                            className={`text-[11px] font-semibold underline underline-offset-2 ${it.waived ? "text-slate-500 hover:text-slate-700" : "text-red-600 hover:text-red-800"}`}
                            onClick={() => it.charge && (it.waived ? applyWaive(it.charge, false) : startWaive(it.charge.id))}
                            disabled={waivingId === it.charge?.id}
                          >
                            {waivingId === it.charge?.id ? <Loader2 className="h-3 w-3 animate-spin" /> : it.waived ? "Un-waive" : "Waive"}
                          </button>
                        )}
                      </div>
                    </div>
                    {waiveReasonKey === it.charge?.id && (
                      <div>
                        <div className="flex items-center gap-2 mt-1.5">
                          <Input
                            autoFocus
                            placeholder="Reason for waiving (required)"
                            value={waiveReasonText}
                            onChange={(e) => { setWaiveReasonText(e.target.value); if (waiveReasonError) setWaiveReasonError(false); }}
                            onKeyDown={(e) => { if (e.key === "Enter" && it.charge) void applyWaive(it.charge, true, waiveReasonText); }}
                            className={`h-7 text-xs flex-1 ${waiveReasonError ? "border-red-400 bg-red-50 focus-visible:ring-red-400" : ""}`}
                          />
                          <Button size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700" onClick={() => it.charge && applyWaive(it.charge, true, waiveReasonText)} disabled={waivingId === it.charge?.id}>
                            {waivingId === it.charge?.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm waive"}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setWaiveReasonKey(null)}>Cancel</Button>
                        </div>
                        {waiveReasonError && (
                          <p className="text-[11px] text-red-600 mt-1">⚠ Enter a reason before confirming — it shows up on the customer&rsquo;s statement history.</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {items.length === 0 && <p className="text-xs text-muted-foreground px-3 py-3 text-center">No line items.</p>}
              </div>

              {canBill && detail.status === "draft" && (
                showAddCharge ? (
                  <div className={`rounded-md border border-teal-200 bg-teal-50/50 p-2.5 space-y-2 mb-2 ${unsavedChargeWarning ? "ring-2 ring-amber-300" : ""}`}>
                    <Input placeholder="Description" value={addDesc} onChange={(e) => setAddDesc(e.target.value)} className="h-7 text-sm" />
                    <div className="flex items-center gap-2">
                      <Input type="number" min="1" className="h-7 w-16 text-sm" value={addQty} onChange={(e) => setAddQty(Math.max(1, Number(e.target.value)))} />
                      <span className="text-xs text-muted-foreground">×</span>
                      <Input type="number" min="0" className="h-7 flex-1 text-sm" value={addUnitPrice} onChange={(e) => setAddUnitPrice(Math.max(0, Number(e.target.value)))} />
                      <span className="text-sm font-semibold w-20 text-right">{formatCurrency(addQty * addUnitPrice)}</span>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => { setShowAddCharge(false); setUnsavedChargeWarning(false); }} disabled={savingCharge}>Cancel</Button>
                      <Button size="sm" className="h-6 text-xs bg-teal-700 hover:bg-teal-800" onClick={saveCharge} disabled={savingCharge}>
                        {savingCharge ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
                      </Button>
                    </div>
                    {unsavedChargeWarning && (
                      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 flex gap-2">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          You have an unsaved charge above —{" "}
                          <button className="underline font-semibold" onClick={() => setUnsavedChargeWarning(false)}>finish adding it</button>
                          {" "}or{" "}
                          <button className="underline font-semibold" onClick={discardUnsavedCharge}>discard it</button>
                          {" "}before sending, so it isn&rsquo;t lost.
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <button className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900" onClick={() => setShowAddCharge(true)}>
                    <Plus className="h-3 w-3" />Add charge
                  </button>
                )
              )}
            </>
          ) : null}
        </div>
      )}

      <Dialog open={!!dialogStep} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className={dialogStep === "preview" ? "sm:max-w-2xl max-h-[85vh] flex flex-col" : "sm:max-w-md"}>
          {dialogStep === "confirm" && (
            loading || !detail ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-10">
                <Loader2 className="h-4 w-4 animate-spin" />Loading…
              </div>
            ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-base">{alreadyFinalized ? "Send this statement?" : "Finalize & send this statement?"}</DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground -mt-2">
                <span className="font-mono text-teal-700">{row.contractNumber}</span> → {row.customerName} · {row.periodLabel}
              </p>
              <div className="rounded-md border divide-y text-sm">
                {items.filter((i) => !i.waived).map((it) => (
                  <div key={it.key} className="flex items-center justify-between px-3 py-1.5">
                    <span className="truncate pr-2">{it.desc}</span>
                    <span className="font-mono text-xs shrink-0">{formatCurrency(it.amount)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t pt-2 text-sm">
                <span className="font-semibold uppercase text-xs text-muted-foreground">Total</span>
                <span className={`font-mono font-bold ${nothingToBill ? "text-red-600" : ""}`}>{formatCurrency(detail.total_amount)}</span>
              </div>
              {nothingToBill ? (
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800 flex gap-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Nothing left to bill — every item is waived. Un-waive at least one item, or skip this contract for this cycle.</span>
                </div>
              ) : (
                <>
                  <button
                    onClick={openPreview}
                    className="w-full flex items-center justify-center gap-1.5 rounded-md border border-teal-200 bg-teal-50 text-teal-800 text-xs font-semibold py-2 hover:bg-teal-100"
                  >
                    <Eye className="h-3.5 w-3.5" />Preview invoice &amp; email — exactly as the customer will receive it
                  </button>
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 flex gap-2">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      {alreadyFinalized
                        ? "This statement is already finalized — sending emails the customer a payment link. This can’t be undone from here — void it from the statement view if needed."
                        : "This creates a finalized statement and emails the customer a payment link. This can’t be undone from here — void it from the statement view if needed."}
                    </span>
                  </div>
                </>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={closeDialog}>Cancel</Button>
                <Button className="bg-teal-700 hover:bg-teal-800" onClick={confirmFinalize} disabled={nothingToBill} title={nothingToBill ? "Nothing to bill after waivers" : undefined}>
                  <Send className="h-4 w-4 mr-2" />Confirm &amp; Send
                </Button>
              </DialogFooter>
            </>
            )
          )}

          {dialogStep === "preview" && (
            <>
              <DialogHeader>
                <DialogTitle className="text-base flex items-center gap-2">
                  <button onClick={() => setDialogStep("confirm")} className="text-muted-foreground hover:text-foreground">←</button>
                  Preview — exactly what the customer gets
                </DialogTitle>
              </DialogHeader>
              <div className="flex gap-1 border-b">
                <button
                  className={`text-xs font-semibold px-3 py-2 border-b-2 ${previewTab === "email" ? "border-teal-700 text-teal-800" : "border-transparent text-muted-foreground"}`}
                  onClick={() => setPreviewTab("email")}
                >Email</button>
                <button
                  className={`text-xs font-semibold px-3 py-2 border-b-2 ${previewTab === "invoice" ? "border-teal-700 text-teal-800" : "border-transparent text-muted-foreground"}`}
                  onClick={() => setPreviewTab("invoice")}
                >Invoice PDF</button>
              </div>
              <div className="flex-1 overflow-y-auto bg-muted/30 rounded-md">
                {previewTab === "email" ? (
                  previewLoading || !previewEmail ? (
                    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10"><Loader2 className="h-4 w-4 animate-spin" />Loading preview…</div>
                  ) : (
                    <div className="p-3">
                      <div className="bg-white rounded border text-xs px-3 py-2 mb-2 space-y-0.5">
                        <p><span className="text-muted-foreground">To:</span> {previewEmail.to.join(", ") || <span className="italic text-red-600">no email on file</span>}</p>
                        <p><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{previewEmail.subject}</span></p>
                      </div>
                      <iframe title="Email preview" srcDoc={previewEmail.html} className="w-full h-[420px] bg-white rounded border" />
                    </div>
                  )
                ) : (
                  <iframe title="Invoice preview" src={`/api/billing-statements/${statementId}/proforma-pdf?preview=1`} className="w-full h-[500px] rounded border bg-white" />
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogStep("confirm")}>← Back</Button>
                <Button className="bg-teal-700 hover:bg-teal-800" onClick={confirmFinalize} disabled={nothingToBill}>
                  <Send className="h-4 w-4 mr-2" />Confirm &amp; Send
                </Button>
              </DialogFooter>
            </>
          )}

          {dialogStep === "sending" && (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <Loader2 className="h-6 w-6 animate-spin text-teal-700" />
              <p className="text-sm text-muted-foreground">Generating statement and sending…</p>
            </div>
          )}

          {dialogStep === "sent" && (
            <>
              <div className="flex flex-col items-center text-center gap-2 py-4">
                {sendNoContact ? (
                  <>
                    <div className="h-10 w-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-lg">!</div>
                    <h3 className="text-sm font-bold">Finalized — not sent</h3>
                  </>
                ) : (
                  <>
                    <div className="h-10 w-10 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-lg">✓</div>
                    <h3 className="text-sm font-bold">Sent</h3>
                  </>
                )}
                <p className="text-xs text-muted-foreground max-w-xs">{sendResultMsg}</p>
              </div>
              <DialogFooter>
                <Button className="bg-teal-700 hover:bg-teal-800" onClick={closeDialog}>Done</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
