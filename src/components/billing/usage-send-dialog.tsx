"use client";

/**
 * Review & send for one or more contract-month usage invoices.
 *
 *   1. On open, each invoice is prepared (POST /api/usage-billing/prepare):
 *      a draft is created and its charges locked to it. Nothing is sent.
 *   2. Any prepared invoice can be previewed exactly as the customer gets it,
 *      using the existing preview-send and proforma-pdf?preview=1 routes.
 *   3. Confirm sends them one at a time (POST /api/usage-billing/send), by each
 *      contract's route, and shows the result per invoice.
 *   Closing before sending cancels every prepared draft (POST /cancel), which
 *   returns the charges to the list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, Loader2, Send, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";

export interface UsageInvoiceToSend {
  contractId: string;
  contractNumber: string;
  customerName: string;
  billingMode: "proforma_first" | "gst_direct";
  year: number;
  month: number;
  label: string;
  chargeKeys: string[];
  subtotal: number;
  total: number;
  lines: Array<{ key: string; description: string; amount: number }>;
}

type RowState =
  | { kind: "preparing" }
  | { kind: "ready"; statementId: string }
  | { kind: "prepare_failed"; message: string }
  | { kind: "sending"; statementId: string }
  | { kind: "sent"; statementNumber: string; emailedTo: string | null }
  | { kind: "handed_off"; statementNumber: string }
  | { kind: "not_sent"; message: string }
  | { kind: "kept"; statementNumber: string; message: string }
  | { kind: "send_failed"; statementId: string; message: string };

interface PreviewEmail { subject: string; to: string[]; html: string; no_contact: boolean }

const keyOf = (inv: UsageInvoiceToSend) => `${inv.contractId}:${inv.year}-${inv.month}`;

export function UsageSendDialog({ invoices, onClose }: { invoices: UsageInvoiceToSend[]; onClose: (changed: boolean) => void }) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => Object.fromEntries(invoices.map((i) => [keyOf(i), { kind: "preparing" } as RowState])));
  const [phase, setPhase] = useState<"preparing" | "review" | "sending" | "done">("preparing");
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<"invoice" | "email">("invoice");
  const [previewEmail, setPreviewEmail] = useState<PreviewEmail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const started = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const setRow = (k: string, s: RowState) => setRows((prev) => ({ ...prev, [k]: s }));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      for (const inv of invoices) {
        try {
          const res = await fetch("/api/usage-billing/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contract_id: inv.contractId, year: inv.year, month: inv.month, charge_keys: inv.chargeKeys, expected_subtotal: inv.subtotal }),
          });
          const json = await res.json().catch(() => ({}));
          setRow(keyOf(inv), res.ok ? { kind: "ready", statementId: json.statement_id } : { kind: "prepare_failed", message: json.error || "Couldn't prepare this invoice" });
        } catch {
          setRow(keyOf(inv), { kind: "prepare_failed", message: "Network error — couldn't prepare this invoice" });
        }
      }
      setPhase("review");
    })();
  }, [invoices]);

  const readyInvoices = invoices.filter((i) => rows[keyOf(i)].kind === "ready");
  const readyTotal = readyInvoices.reduce((s, i) => s + i.total, 0);

  const cancelPrepared = useCallback(async () => {
    const ready = Object.values(rowsRef.current).filter((r): r is { kind: "ready"; statementId: string } => r.kind === "ready");
    await Promise.all(ready.map((r) => fetch("/api/usage-billing/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statement_id: r.statementId }),
    }).catch(() => null)));
  }, []);

  const close = async () => {
    if (phase === "preparing" || phase === "sending") return;
    const anyPrepared = Object.values(rowsRef.current).some((r) => r.kind === "ready");
    if (anyPrepared) await cancelPrepared();
    onClose(phase === "done" || anyPrepared);
  };

  const sendAll = async () => {
    setPhase("sending");
    setPreviewKey(null);
    for (const inv of readyInvoices) {
      const k = keyOf(inv);
      const current = rowsRef.current[k];
      if (current.kind !== "ready") continue;
      setRow(k, { kind: "sending", statementId: current.statementId });
      try {
        const res = await fetch("/api/usage-billing/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statement_id: current.statementId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setRow(k, { kind: "send_failed", statementId: current.statementId, message: json.error || "Send failed" });
          continue;
        }
        const o = json.outcome;
        setRow(k,
          o.kind === "sent" ? { kind: "sent", statementNumber: o.statementNumber, emailedTo: o.emailedTo }
          : o.kind === "handed_off" ? { kind: "handed_off", statementNumber: o.statementNumber }
          : o.kind === "not_sent_released" ? { kind: "not_sent", message: o.reason }
          : { kind: "kept", statementNumber: o.statementNumber, message: o.reason });
      } catch {
        setRow(k, { kind: "send_failed", statementId: current.statementId, message: "Network error — check the statement before retrying" });
      }
    }
    setPhase("done");
  };

  const openPreview = async (inv: UsageInvoiceToSend) => {
    const r = rows[keyOf(inv)];
    if (r.kind !== "ready") return;
    setPreviewKey(keyOf(inv));
    setPreviewTab("invoice");
    setPreviewEmail(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${r.statementId}/preview-send`);
      const json = await res.json();
      if (res.ok) setPreviewEmail(json.data);
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewInv = previewKey ? invoices.find((i) => keyOf(i) === previewKey) : null;
  const previewRow = previewKey ? rows[previewKey] : null;
  const previewStatementId = previewRow && previewRow.kind === "ready" ? previewRow.statementId : null;

  const counts = Object.values(rows).reduce((acc, r) => { acc[r.kind] = (acc[r.kind] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void close(); }}>
      <DialogContent className={previewInv ? "sm:max-w-3xl max-h-[90vh] flex flex-col" : "sm:max-w-xl max-h-[90vh] flex flex-col"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4" />
            {phase === "done" ? "Send results" : invoices.length === 1 ? `Send ${invoices[0].label} usage invoice` : `Send ${invoices.length} usage invoices`}
          </DialogTitle>
          <DialogDescription>
            {phase === "preparing" && "Preparing invoices and locking their charges…"}
            {phase === "review" && "Check each invoice. Nothing has been sent yet — closing this cancels them and returns the charges to the list."}
            {phase === "sending" && "Sending one at a time — keep this window open."}
            {phase === "done" && `${counts.sent ?? 0} sent${counts.handed_off ? ` · ${counts.handed_off} passed to the Tally Inbox` : ""}${(counts.not_sent ?? 0) + (counts.prepare_failed ?? 0) + (counts.send_failed ?? 0) + (counts.kept ?? 0) ? ` · ${(counts.not_sent ?? 0) + (counts.prepare_failed ?? 0) + (counts.send_failed ?? 0) + (counts.kept ?? 0)} need attention` : ""}`}
          </DialogDescription>
        </DialogHeader>

        {previewInv && previewStatementId ? (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                <span className="font-mono text-xs text-teal-700">{previewInv.contractNumber}</span> · {previewInv.label}
              </p>
              <Button size="sm" variant="ghost" onClick={() => setPreviewKey(null)}>← Back to list</Button>
            </div>
            <div className="flex gap-1 border-b">
              {(["invoice", "email"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setPreviewTab(t)}
                  className={`text-xs font-semibold px-3 py-2 border-b-2 ${previewTab === t ? "border-teal-700 text-teal-800" : "border-transparent text-muted-foreground"}`}>
                  {t === "invoice" ? "Invoice PDF" : "Email"}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-muted/30">
              {previewTab === "invoice" ? (
                <iframe title="Invoice preview" src={`/api/billing-statements/${previewStatementId}/proforma-pdf?preview=1`} className="w-full h-[55vh] bg-white rounded" />
              ) : previewLoading || !previewEmail ? (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10">
                  {previewLoading ? <><Loader2 className="h-4 w-4 animate-spin" />Loading email…</> : "Email preview unavailable"}
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  <div className="bg-white rounded border text-xs px-3 py-2 space-y-0.5">
                    <p><span className="text-muted-foreground">To:</span> {previewEmail.to.join(", ") || <span className="italic text-red-600">no email on file</span>}</p>
                    <p><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{previewEmail.subject}</span></p>
                  </div>
                  <iframe title="Email preview" srcDoc={previewEmail.html} className="w-full h-[45vh] bg-white rounded border" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 overflow-y-auto rounded-md border divide-y text-sm">
            {invoices.map((inv) => {
              const r = rows[keyOf(inv)];
              return (
                <li key={keyOf(inv)} className="px-3 py-2.5 space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate"><span className="font-mono text-xs text-teal-700">{inv.contractNumber}</span> · {inv.customerName}</p>
                      <p className="text-xs text-muted-foreground">{inv.label} · {inv.lines.length} charge{inv.lines.length === 1 ? "" : "s"}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {inv.billingMode === "gst_direct"
                        ? <Badge variant="outline" className="bg-green-50 text-green-800 border-green-200 text-[10px]">GST direct</Badge>
                        : <Badge variant="outline" className="bg-blue-50 text-blue-800 border-blue-200 text-[10px]">Proforma first</Badge>}
                      <span className="font-semibold tabular-nums">{formatCurrency(inv.total)}</span>
                    </div>
                  </div>
                  {phase !== "done" && r.kind !== "sent" && (
                    <ul className="text-xs text-muted-foreground pl-3 space-y-0.5">
                      {inv.lines.map((l) => (
                        <li key={l.key} className="flex justify-between gap-3"><span className="truncate">{l.description}</span><span className="tabular-nums shrink-0">{formatCurrency(l.amount)}</span></li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5">
                      {r.kind === "preparing" && <><Loader2 className="h-3 w-3 animate-spin" />Preparing…</>}
                      {r.kind === "ready" && <span className="text-teal-700">Ready</span>}
                      {r.kind === "sending" && <><Loader2 className="h-3 w-3 animate-spin" />Sending…</>}
                      {r.kind === "sent" && <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />Sent {r.statementNumber}{r.emailedTo ? ` to ${r.emailedTo}` : ""}</span>}
                      {r.kind === "handed_off" && <span className="text-green-700 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />{r.statementNumber} passed to the Tally Inbox for the GST invoice</span>}
                      {r.kind === "prepare_failed" && <span className="text-red-600 flex items-center gap-1"><XCircle className="h-3.5 w-3.5" />{r.message}</span>}
                      {r.kind === "not_sent" && <span className="text-amber-700 flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />Not sent — {r.message}. Charges are back in the list.</span>}
                      {r.kind === "kept" && <span className="text-amber-700 flex items-center gap-1"><AlertCircle className="h-3.5 w-3.5" />{r.statementNumber} was created but not delivered — {r.message}. Open the statement to resend.</span>}
                      {r.kind === "send_failed" && <span className="text-red-600 flex items-center gap-1"><XCircle className="h-3.5 w-3.5" />{r.message}</span>}
                    </span>
                    {phase === "review" && r.kind === "ready" && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void openPreview(inv)}>
                        <Eye className="h-3.5 w-3.5 mr-1" />Preview
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {phase === "review" && readyInvoices.length > 0 && !previewInv && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 flex gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>This emails {readyInvoices.length === 1 ? "the customer" : `${readyInvoices.length} customers`} and can&rsquo;t be undone from here. Void an invoice from its statement if needed.</span>
          </div>
        )}

        <DialogFooter>
          {phase === "done" ? (
            <Button className="bg-teal-700 hover:bg-teal-800" onClick={() => void close()}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => void close()} disabled={phase !== "review"}>Cancel</Button>
              <Button className="bg-teal-700 hover:bg-teal-800" onClick={() => void sendAll()} disabled={phase !== "review" || readyInvoices.length === 0}>
                {phase === "sending" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {phase === "preparing" ? "Preparing…" : phase === "sending" ? "Sending…" : `Confirm & send ${readyInvoices.length} · ${formatCurrency(readyTotal)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
