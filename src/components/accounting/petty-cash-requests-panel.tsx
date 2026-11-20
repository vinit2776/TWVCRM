"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AttachmentPicker, uploadAttachments } from "@/components/petty-cash/attachments";
import { PC_ISSUANCE_METHOD_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { PettyCashRequest } from "@/types";

const PAY_ROLES = ["admin", "accounts"];
const referenceHelp: Record<string, string> = {
  cash: "For cash, the voucher number or a short note, e.g. “Cash voucher 112, drawn from main cash”.",
  upi: "The UPI transaction ID (UTR).",
  bank_transfer: "The bank UTR / reference number.",
  cheque: "The cheque number.",
};

const owner = (r: PettyCashRequest) =>
  (r.book as { owner?: { full_name: string } } | undefined)?.owner?.full_name || r.requester?.full_name || "Unknown";
const balanceOf = (r: PettyCashRequest) => Number((r.book as { current_balance?: number } | undefined)?.current_balance || 0);

/**
 * Petty cash fund requests in Acc Payables. An admin approves a request on the Petty Cash page;
 * it then lands here for Accounts to pay (draw the money), enter the payment reference and confirm.
 * Confirming adds the amount to the person's petty cash balance and shows the reference on their request.
 */
export function PettyCashRequestsPanel({ role }: { role: string | null }) {
  const [toPay, setToPay] = useState<PettyCashRequest[] | null>(null);
  const [paid, setPaid] = useState<PettyCashRequest[]>([]);
  const [target, setTarget] = useState<PettyCashRequest | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        fetch("/api/petty-cash/requests?status=approved&limit=50").then((r) => r.json()),
        fetch("/api/petty-cash/requests?status=issued&limit=5").then((r) => r.json()),
      ]);
      setToPay(a.data || []);
      setPaid(b.data || []);
    } catch {
      setToPay([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const canPay = !!role && PAY_ROLES.includes(role);
  if (!toPay || (toPay.length === 0 && paid.length === 0)) return null;

  return (
    <Card className="mb-4 p-4" data-testid="petty-cash-requests-panel">
      <div className="mb-1 text-sm font-semibold">
        Petty cash fund requests <span className="font-normal text-muted-foreground">· approved by Admin, paid here</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {canPay
          ? "Draw or send the money, then press “Pay & confirm” and enter the payment reference. The amount is added to that person’s petty cash balance straight away and they see your reference on their request."
          : "These are waiting for Accounts to pay. You will see the reference here once it is paid."}
      </p>
      <div className="divide-y text-sm">
        {toPay.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="font-medium">{owner(r)} <span className="font-mono text-xs text-muted-foreground">{r.request_number}</span></div>
              <div className="text-xs text-muted-foreground">{r.purpose}</div>
              <div className="text-xs text-muted-foreground">
                Approved{r.approver?.full_name ? ` by ${r.approver.full_name}` : ""} on {formatDate(r.approved_at ?? r.created_at)} · balance now {formatCurrency(balanceOf(r))}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-medium">{formatCurrency(Number(r.amount_requested))}</span>
              <Badge variant="secondary" className="bg-orange-100 text-orange-800">Ready to pay</Badge>
              {canPay && <Button size="sm" className="h-7" onClick={() => setTarget(r)}>Pay &amp; confirm…</Button>}
            </div>
          </div>
        ))}
        {paid.length > 0 && (
          <div className="pt-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Recently paid</p>
            {paid.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-1.5">
                <div className="min-w-0 text-xs">
                  <span className="font-medium">{owner(r)}</span> <span className="font-mono text-muted-foreground">{r.request_number}</span>
                  <div className="text-muted-foreground">
                    Paid {formatDate(r.issued_at ?? r.created_at)}{r.issuer?.full_name ? ` by ${r.issuer.full_name}` : ""}
                    {r.issuance_method ? ` · ${PC_ISSUANCE_METHOD_LABELS[r.issuance_method] ?? r.issuance_method}` : ""}
                    {r.issuance_reference ? ` · ref ${r.issuance_reference}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{formatCurrency(Number(r.amount_requested))}</span>
                  <Badge variant="secondary" className="bg-green-100 text-green-800">Paid</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <PayDialog request={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); load(); }} />
    </Card>
  );
}

function PayDialog({ request, onClose, onDone }: { request: PettyCashRequest | null; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [proof, setProof] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (request) { setMethod(""); setReference(""); setProof([]); } }, [request]);
  if (!request) return null;
  const invalid = !method || reference.trim().length < 3;

  async function submit() {
    if (!request) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/petty-cash/requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "issue", issuance_method: method, issuance_reference: reference.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not confirm the payment"); return; }
      const failed = proof.length ? await uploadAttachments(proof, { requestId: request.id }, "payment_proof") : 0;
      if (failed) toast.warning(`Paid and added to ${owner(request)}'s balance, but ${failed} proof file${failed > 1 ? "s" : ""} did not upload. Add it from the request later.`);
      else toast.success(`Paid. ${formatCurrency(Number(request.amount_requested))} added to ${owner(request)}'s petty cash balance.`);
      onDone();
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pay &amp; confirm — {request.request_number}</DialogTitle>
          <DialogDescription>Only confirm after the money has actually left (cash drawn and handed over, or sent by UPI / bank / cheque).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p><strong>To:</strong> {owner(request)}</p>
            <p><strong>Amount:</strong> {formatCurrency(Number(request.amount_requested))}</p>
            <p><strong>Purpose:</strong> {request.purpose}</p>
          </div>
          <div className="space-y-2">
            <Label>How was it paid?</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue placeholder="Choose cash, UPI, bank transfer or cheque" /></SelectTrigger>
              <SelectContent>
                {Object.entries(PC_ISSUANCE_METHOD_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Payment reference</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Required" />
            <p className="text-xs text-muted-foreground">{referenceHelp[method] ?? "Pick how it was paid, then enter the matching reference. The person sees this on their request."}</p>
          </div>
          <AttachmentPicker files={proof} onChange={setProof} label="Proof of payment"
            help="A UPI or bank screenshot, or a photo of the signed cash voucher. Kept with the request." />
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            What happens when you confirm: {formatCurrency(Number(request.amount_requested))} is added to {owner(request)}&apos;s petty cash balance (now {formatCurrency(balanceOf(request))}) and they can use it for expenses straight away.
          </p>
          <Button className="w-full" disabled={saving || invalid} onClick={submit}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}I have paid this — add to balance
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
