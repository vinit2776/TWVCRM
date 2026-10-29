"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DEPOSIT_REFUND_APPROVE_ROLES, DEPOSIT_REFUND_PAY_ROLES,
  DEPOSIT_REFUND_STATUS_COLORS, DEPOSIT_REFUND_STATUS_LABELS, type DepositRefundStatus,
} from "@/lib/deposit-refund";
import { formatCurrency, formatDate } from "@/lib/utils";

interface Row {
  id: string;
  amount: number | string;
  status: DepositRefundStatus;
  reason: string;
  requested_at: string;
  payment_reference?: string | null;
  bank_account_name?: string | null;
  bank_account_number?: string | null;
  bank_ifsc?: string | null;
  proposal: { proposal_number: string; lead: { first_name?: string; last_name?: string; company?: string } | null } | null;
  proposal_id: string;
}

type Action = { kind: "reject" | "pay"; row: Row } | null;

const partyOf = (r: Row) => r.proposal?.lead?.company || `${r.proposal?.lead?.first_name ?? ""} ${r.proposal?.lead?.last_name ?? ""}`.trim() || "Customer";

/**
 * Walk-away deposit refunds in Acc Payables. An admin approves every refund;
 * accounts (or admin) records the bank transfer, which closes the proposal as
 * "Customer withdrew". Hidden when there is nothing to show.
 */
export function DepositRefundsPanel({ role }: { role: string | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/deposit-refunds").then((r) => r.json()).then((j) => setRows(j.data || [])).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const canApprove = !!role && (DEPOSIT_REFUND_APPROVE_ROLES as readonly string[]).includes(role);
  const canPay = !!role && (DEPOSIT_REFUND_PAY_ROLES as readonly string[]).includes(role);

  async function approve(row: Row) {
    setBusy(row.id);
    try {
      const res = await fetch(`/api/deposit-refunds/${row.id}/approve`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not approve"); return; }
      toast.success("Approved — accounts can now pay it");
      load();
    } finally { setBusy(null); }
  }

  const shown = (rows ?? []).filter((r) => r.status === "pending_approval" || r.status === "approved" || r.status === "paid").slice(0, 8);
  if (!rows || shown.length === 0) return null;

  return (
    <Card className="mb-4 p-4" data-testid="deposit-refunds-panel">
      <div className="mb-2 text-sm font-semibold">
        Deposit refunds <span className="font-normal text-muted-foreground">· customers who withdrew after paying part of the deposit</span>
      </div>
      <div className="divide-y text-sm">
        {shown.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <Link href={`/proposals/${r.proposal_id}`} className="truncate font-medium hover:underline">
                {partyOf(r)} <span className="font-mono text-xs text-muted-foreground">{r.proposal?.proposal_number}</span>
              </Link>
              <div className="text-xs text-muted-foreground">
                Requested {formatDate(r.requested_at)}{r.payment_reference ? ` · UTR ${r.payment_reference}` : ""}
                {r.bank_account_number ? ` · ${r.bank_account_name || ""} ${r.bank_account_number} ${r.bank_ifsc || ""}` : ""}
              </div>
              <div className="text-xs italic text-muted-foreground">{r.reason}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-medium">{formatCurrency(Number(r.amount))}</span>
              <Badge variant="secondary" className={DEPOSIT_REFUND_STATUS_COLORS[r.status]}>{DEPOSIT_REFUND_STATUS_LABELS[r.status]}</Badge>
              {r.status === "pending_approval" && canApprove && (
                <>
                  <Button size="sm" className="h-7" onClick={() => approve(r)} disabled={busy === r.id}>
                    {busy === r.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => setAction({ kind: "reject", row: r })}>Reject</Button>
                </>
              )}
              {r.status === "approved" && canPay && (
                <Button size="sm" className="h-7" onClick={() => setAction({ kind: "pay", row: r })}>Record payment</Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => { setAction(null); load(); }} />
    </Card>
  );
}

function ActionDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [utr, setUtr] = useState("");
  const [from, setFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (action) { setReason(""); setUtr(""); setFrom(""); setNotes(""); } }, [action]);
  if (!action) return null;
  const isPay = action.kind === "pay";
  const invalid = isPay ? utr.trim().length < 3 || !from.trim() || !date : reason.trim().length < 10;

  async function submit() {
    if (!action) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/deposit-refunds/${action.row.id}/${action.kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isPay ? { payment_date: date, payment_reference: utr, paid_from_account: from, payment_notes: notes } : { reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error || "Could not complete this step"); return; }
      toast.success(isPay ? "Refund recorded — proposal closed as Customer withdrew" : "Refund rejected");
      onDone();
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isPay ? "Record the refund payment" : "Reject this refund"}</DialogTitle>
          <DialogDescription>
            {isPay
              ? `${formatCurrency(Number(action.row.amount))} to ${partyOf(action.row)}. Recording it closes the proposal as “Customer withdrew”.`
              : "The request is closed and the proposal is left as it is."}
          </DialogDescription>
        </DialogHeader>
        {isPay ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5"><Label htmlFor="dr-d">Payment date</Label><Input id="dr-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="dr-u">Bank UTR</Label><Input id="dr-u" value={utr} onChange={(e) => setUtr(e.target.value)} /></div>
            <div className="col-span-2 space-y-1.5"><Label htmlFor="dr-f">Paid from account</Label><Input id="dr-f" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="col-span-2 space-y-1.5"><Label htmlFor="dr-n">Notes (optional)</Label><Input id="dr-n" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
        ) : (
          <div className="space-y-1.5"><Label htmlFor="dr-r">Reason (min 10 characters)</Label><Textarea id="dr-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
          <Button onClick={submit} disabled={saving || invalid} variant={isPay ? "default" : "destructive"}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {isPay ? "Record payment" : "Reject refund"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
