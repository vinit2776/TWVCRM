"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Banknote, Copy, Download, Layers, Loader2, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { canRecordPayments } from "@/lib/constants";
import {
  canOverrideDepositFloor,
  canRequestDepositInstalment,
  checkAsk,
  DEPOSIT_INSTALMENT_STATUS_COLORS,
  DEPOSIT_INSTALMENT_STATUS_LABELS,
  minFirstPart,
  type DepositInstalmentStatus,
  type DepositPosition,
} from "@/lib/deposit-instalments";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { DepositInstalment } from "@/types";

interface PanelData {
  instalments: DepositInstalment[];
  position: DepositPosition;
  has_open_ask: boolean;
  enabled: boolean;
  min_first_part_percent: number;
}

interface Props {
  proposalId: string;
  proposalStatus: string;
  depositPaymentStatus: string | undefined;
  userId: string | null;
  role: string | null;
  /** Refetch the proposal after money or state changed. */
  onChanged: () => void;
  /** Tells the page that parts exist, so it can stand its single-deposit buttons down. */
  onPartsActive: (active: boolean) => void;
}

const MEDIA = [
  ["neft", "NEFT"], ["rtgs", "RTGS"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"],
] as const;

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "paid" | "wait" | "bal" }) {
  const toneCls = tone === "paid" ? "text-green-700" : tone === "wait" ? "text-blue-700" : tone === "bal" ? "text-amber-800" : "";
  return (
    <div className={`rounded-md border bg-white/70 px-2.5 py-1.5 ${tone === "bal" ? "border-amber-300" : ""}`}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-base font-bold leading-tight ${toneCls}`}>{formatCurrency(value)}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function DepositPartsPanel({ proposalId, proposalStatus, depositPaymentStatus, userId, role, onChanged, onPartsActive }: Props) {
  const [data, setData] = useState<PanelData | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [recordFor, setRecordFor] = useState<DepositInstalment | null>(null);
  const [cancelFor, setCancelFor] = useState<DepositInstalment | null>(null);
  const [sendFor, setSendFor] = useState<DepositInstalment | null>(null);
  const [pdfFor, setPdfFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments`);
      if (!res.ok) return;
      const json = await res.json();
      setData(json.data);
      onPartsActive((json.data.instalments as DepositInstalment[]).some((i) => i.status !== "cancelled"));
    } catch {
      // The panel is additive; the single-deposit card still works without it.
    }
  }, [proposalId, onPartsActive]);

  useEffect(() => { load(); }, [load]);

  // PDF to share by hand (WhatsApp etc.). Built in the browser — jsPDF loads only on click.
  async function downloadPdf(part: DepositInstalment) {
    setPdfFor(part.id);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments/${part.id}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "download" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not prepare the PDF"); return; }
      const { generateDepositRequestPDF } = await import("@/lib/deposit-request-pdf");
      const doc = await generateDepositRequestPDF({
        proposal_number: json.proposal_number, amount: json.amount, security_deposit_months: 0,
        customer_name: json.customer_name, company: json.company, customer_message: json.customer_message,
        deposit_link_url: json.deposit_link_url, due_date: json.due_date,
        variant: { title: `Security Deposit — Part ${json.seq}`, intro: json.intro, rows: json.rows, paymentReference: json.proposal_number },
      });
      doc.save(`Security-Deposit-${json.proposal_number}-Part-${json.seq}.pdf`);
      toast.success("PDF downloaded — share it with the customer");
    } finally {
      setPdfFor(null);
    }
  }

  const refreshed = useCallback(() => { load(); onChanged(); }, [load, onChanged]);

  if (!data) return null;
  const { instalments, position, has_open_ask: hasOpenAsk, enabled } = data;
  const anyParts = instalments.some((i) => i.status !== "cancelled");
  if (!enabled && !anyParts) return null;

  const open = ["sent", "viewed", "accepted"].includes(proposalStatus);
  const canAsk = enabled && open && depositPaymentStatus === "pending" && !hasOpenAsk && position.balance > 0 && canRequestDepositInstalment(role);
  const canCancel = (i: DepositInstalment) => i.status === "requested" && (i.requested_by === userId || canOverrideDepositFloor(role));
  const barPct = (n: number) => (position.required > 0 ? Math.min(100, (n / position.required) * 100) : 0);

  return (
    <div className="mt-3 space-y-2.5 border-t border-amber-200 pt-3" data-testid="deposit-parts-panel">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
          <Layers className="h-3.5 w-3.5" /> Deposit in parts
        </p>
        {depositPaymentStatus === "pending" && anyParts && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Partly paid</span>
        )}
      </div>

      {anyParts && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Required" value={position.required} />
            <Stat label="Requested so far" value={position.requested} />
            <Stat label="Paid" value={position.paid} tone="paid" hint={`${position.partsPaid} part${position.partsPaid === 1 ? "" : "s"}`} />
            <Stat label="Awaiting payment" value={position.awaiting} tone="wait" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Not yet asked" value={position.notYetAsked} />
            <Stat label="Balance to collect" value={position.balance} tone="bal" />
          </div>
          <div>
            <div className="flex h-2.5 overflow-hidden rounded bg-gray-200" aria-hidden>
              <i className="bg-green-500" style={{ width: `${barPct(position.paid)}%` }} />
              <i className="bg-blue-500" style={{ width: `${barPct(position.awaiting)}%` }} />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Paid {formatCurrency(position.paid)} · asked, awaiting {formatCurrency(position.awaiting)} · not yet asked {formatCurrency(position.notYetAsked)}
            </p>
          </div>
          {depositPaymentStatus === "pending" && (
            <p className="rounded-md border-l-4 border-amber-500 bg-amber-100 px-2.5 py-1.5 text-xs text-amber-900">
              The contract cannot be activated until the full {formatCurrency(position.required)} is paid.
              <b> {formatCurrency(position.balance)} still to collect.</b>
            </p>
          )}

          <ul className="space-y-1.5">
            {instalments.map((i) => {
              const st = i.status as DepositInstalmentStatus;
              return (
                <li key={i.id} className={`rounded-md border bg-white/70 px-2.5 py-2 text-xs ${st === "cancelled" ? "opacity-60" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">Part {i.seq} · {formatCurrency(Number(i.paid_amount ?? i.amount))}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${DEPOSIT_INSTALMENT_STATUS_COLORS[st]}`}>
                      {DEPOSIT_INSTALMENT_STATUS_LABELS[st]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Asked {formatDate(i.requested_at)}
                    {i.due_date && st === "requested" ? ` · due ${formatDate(i.due_date)}` : ""}
                    {st === "paid" && i.paid_at ? ` · paid ${formatDate(i.paid_at)}` : ""}
                    {st === "paid" && i.payment_reference ? ` · ${i.payment_reference}` : ""}
                    {st === "paid" && i.payment_medium ? ` · ${i.payment_medium}` : ""}
                  </p>
                  {st === "cancelled" && i.cancel_reason && <p className="mt-0.5 text-[11px] italic text-muted-foreground">{i.cancel_reason}</p>}
                  {i.floor_override_reason && <p className="mt-0.5 text-[11px] italic text-amber-800">Below minimum, approved: {i.floor_override_reason}</p>}
                  {st === "requested" && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {i.razorpay_link_url && (
                        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                          onClick={() => { navigator.clipboard.writeText(i.razorpay_link_url!); toast.success("Payment link copied"); }}>
                          <Copy className="mr-1 h-3 w-3" /> Copy link
                        </Button>
                      )}
                      {canRequestDepositInstalment(role) && (
                        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setSendFor(i)}>
                          <Mail className="mr-1 h-3 w-3" /> Email customer
                        </Button>
                      )}
                      {canRequestDepositInstalment(role) && (
                        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pdfFor === i.id} onClick={() => downloadPdf(i)}>
                          {pdfFor === i.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />} Download PDF
                        </Button>
                      )}
                      {canRecordPayments(role) && (
                        <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setRecordFor(i)}>
                          <Banknote className="mr-1 h-3 w-3" /> Record bank transfer
                        </Button>
                      )}
                      {canCancel(i) && (
                        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-700" onClick={() => setCancelFor(i)}>
                          <X className="mr-1 h-3 w-3" /> Cancel
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {canAsk && (
        <Button type="button" size="sm" className="w-full" onClick={() => setRequestOpen(true)}>
          {anyParts ? "Request next part" : "Collect deposit in parts"}
        </Button>
      )}
      {enabled && hasOpenAsk && <p className="text-[11px] text-muted-foreground">One part can be open at a time — it needs to be paid or cancelled before the next is requested.</p>}

      <RequestPartDialog
        open={requestOpen} onClose={() => setRequestOpen(false)} proposalId={proposalId}
        position={position} percent={data.min_first_part_percent} role={role}
        onDone={() => { setRequestOpen(false); refreshed(); }}
      />
      <RecordPartDialog part={recordFor} proposalId={proposalId} onClose={() => setRecordFor(null)} onDone={() => { setRecordFor(null); refreshed(); }} />
      <SendPartDialog part={sendFor} proposalId={proposalId} onClose={() => setSendFor(null)} onDone={() => { setSendFor(null); refreshed(); }} />
      <CancelPartDialog part={cancelFor} proposalId={proposalId} onClose={() => setCancelFor(null)} onDone={() => { setCancelFor(null); refreshed(); }} />
    </div>
  );
}

function RequestPartDialog({ open, onClose, proposalId, position, percent, role, onDone }: {
  open: boolean; onClose: () => void; proposalId: string; position: DepositPosition; percent: number; role: string | null; onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [override, setOverride] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setAmount(""); setDueDate(""); setNote(""); setMessage(""); setOverride(""); } }, [open]);

  const firstPart = position.paid === 0;
  const floor = minFirstPart(position.required, percent);
  const amt = Number(amount);
  const check = useMemo(() => (amt > 0 ? checkAsk(amt, position, false, percent) : null), [amt, position, percent]);
  const needsOverride = check?.ok === true && check.needsOverride;
  const mayOverride = canOverrideDepositFloor(role);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          due_date: dueDate || null,
          internal_note: note,
          customer_message: message || undefined,
          floor_override_reason: needsOverride && mayOverride ? override : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not request this part"); return; }
      toast.success(json.data?.razorpay_link_url ? "Part requested — payment link ready to copy" : "Part requested — customer pays by bank transfer");
      onDone();
    } finally {
      setSaving(false);
    }
  }

  const invalid = !(amt > 0) || (check?.ok === false) || note.trim().length < 10 || (needsOverride && (!mayOverride || override.trim().length < 10));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{firstPart ? "Collect deposit in parts" : "Request next part"}</DialogTitle>
          <DialogDescription>
            Balance to collect {formatCurrency(position.balance)}
            {position.paid > 0 ? ` · already paid ${formatCurrency(position.paid)}` : ""}.
            The contract still needs the full deposit before it can start.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {firstPart && (
            <p className="text-xs text-amber-800">
              First part must be at least {percent}% of the deposit ({formatCurrency(floor)}). A manager or admin can approve less with a reason.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dp-amount">Amount to request now (₹)</Label>
            <Input id="dp-amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">
              {firstPart && floor < position.balance && (
                <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setAmount(String(floor))}>
                  Minimum {formatCurrency(floor)}
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setAmount(String(position.balance))}>
                Full balance {formatCurrency(position.balance)}
              </Button>
            </div>
            {check?.ok === false && (
              <p className="text-xs text-red-600">
                {check.code === "amount_exceeds_balance" ? `That is more than the balance (${formatCurrency(check.balance ?? 0)}).` : "Enter a valid amount."}
              </p>
            )}
            {amt > 0 && check?.ok && (
              <p className="text-xs text-muted-foreground">After this ask, {formatCurrency(Math.max(0, position.balance - amt))} would remain to be asked.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dp-due">Pay by (optional)</Label>
            <Input id="dp-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          {needsOverride && (
            <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2.5">
              <Label htmlFor="dp-override">Below the {percent}% minimum — reason for approval</Label>
              {mayOverride ? (
                <Textarea id="dp-override" rows={2} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Why a smaller first part is acceptable (min 10 characters)" />
              ) : (
                <p className="text-xs text-amber-900">Only a manager or admin can approve a first part this small. Ask for at least {formatCurrency(floor)}, or ask a manager to raise it.</p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dp-note">Note for accounts (internal, min 10 characters)</Label>
            <Textarea id="dp-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dp-msg">Message to customer (optional)</Label>
            <Textarea id="dp-msg" rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <p className="text-[11px] text-muted-foreground">This creates the request and its payment link. The customer is not messaged yet.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={submit} disabled={saving || invalid}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Request this part
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordPartDialog({ part, proposalId, onClose, onDone }: {
  part: DepositInstalment | null; proposalId: string; onClose: () => void; onDone: () => void;
}) {
  const [medium, setMedium] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (part) { setMedium(""); setReference(""); setNotes(""); setProof(null); } }, [part]);

  async function submit() {
    if (!part) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("amount", String(part.amount));
      if (medium) fd.append("payment_medium", medium);
      if (reference) fd.append("reference", reference);
      fd.append("notes", notes);
      if (proof) fd.append("payment_proof", proof);
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments/${part.id}/payment`, { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not record this payment"); return; }
      toast.success(json.data?.complete ? "Part recorded — the deposit is now fully paid" : "Part recorded");
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!part} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record bank transfer — Part {part?.seq}</DialogTitle>
          <DialogDescription>
            Amount {formatCurrency(Number(part?.amount ?? 0))}. This must match the request; if the customer paid a different amount, cancel this request and ask for the right one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rp-medium">Payment mode</Label>
              <select id="rp-medium" value={medium} onChange={(e) => setMedium(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm">
                <option value="">Select mode</option>
                {MEDIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rp-ref">Reference / UTR</Label>
              <Input id="rp-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-notes">Internal note (min 10 characters)</Label>
            <Textarea id="rp-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rp-proof">Payment proof (optional)</Label>
            <Input id="rp-proof" type="file" accept="image/*,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={submit} disabled={saving || notes.trim().length < 10}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelPartDialog({ part, proposalId, onClose, onDone }: {
  part: DepositInstalment | null; proposalId: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (part) setReason(""); }, [part]);

  async function submit() {
    if (!part) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments/${part.id}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not cancel this request"); return; }
      toast.success("Request cancelled");
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!part} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Cancel Part {part?.seq}?</DialogTitle>
          <DialogDescription>
            The payment link is withdrawn and {formatCurrency(Number(part?.amount ?? 0))} goes back to &ldquo;not yet asked&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cp-reason">Reason (min 10 characters)</Label>
          <Textarea id="cp-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Keep it</Button>
          <Button variant="destructive" onClick={submit} disabled={saving || reason.trim().length < 10}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Cancel request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendPartDialog({ part, proposalId, onClose, onDone }: {
  part: DepositInstalment | null; proposalId: string; onClose: () => void; onDone: () => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!part) return;
    setHtml(null);
    setLoading(true);
    fetch(`/api/proposals/${proposalId}/deposit-instalments/${part.id}/send`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true }),
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) { toast.error(json.error || "Could not build the email"); onClose(); return; }
        setHtml(json.html); setSubject(json.subject); setTo(json.to || []);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when a different part is opened
  }, [part?.id, proposalId]);

  async function send() {
    if (!part) return;
    setSending(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/deposit-instalments/${part.id}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not send the email"); return; }
      toast.success(`Request emailed to ${json.data?.sent_to}`);
      onDone();
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={!!part} onOpenChange={(o) => { if (!o && !sending) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Email Part {part?.seq} to the customer</DialogTitle>
          <DialogDescription>
            {to.length > 0 ? <>To <b>{to.join(", ")}</b>. </> : "No customer email on the lead. "}
            The email shows the total deposit, what is paid, this part and the balance after it.
          </DialogDescription>
        </DialogHeader>
        {loading && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>}
        {html && (
          <div className="space-y-1.5">
            <p className="text-xs"><span className="text-muted-foreground">Subject:</span> {subject}</p>
            <iframe title="Email preview" srcDoc={html} sandbox="" className="h-[360px] w-full rounded-md border bg-white" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>Close</Button>
          <Button onClick={send} disabled={sending || !html || to.length === 0}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
