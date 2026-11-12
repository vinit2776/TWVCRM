"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

export type ChainRef = { billId?: string; poId?: string; prId?: string };

export type ChainStateData = {
  root: { type: "pr" | "po" | "bill"; id: string };
  state: "open" | "closing" | "locked";
  reopened: boolean;
  completeSince: string | null;
  lockAt: string | null;
  /** Complete but finished before the lock cut-off: correctable, never locks. */
  exempt?: boolean;
  conditions: Array<{ key: string; label: string; done: boolean; detail: string }>;
  lastReopen: { reopened_at: string; reason: string; reopener: { full_name: string } | null } | null;
};

const MIN_REASON = 10;

/**
 * Whether the procurement cycle a bill / PO / MR belongs to is open, closing or
 * locked. `locked` is what pages use to disable correction controls; the server
 * enforces the same rule regardless (src/lib/procurement/chain-lock.ts).
 */
export function useChainState(ref: ChainRef) {
  const [data, setData] = useState<ChainStateData | null>(null);
  const { billId, poId, prId } = ref;

  const reload = useCallback(async () => {
    const qs = new URLSearchParams();
    if (billId) qs.set("bill_id", billId);
    else if (poId) qs.set("po_id", poId);
    else if (prId) qs.set("pr_id", prId);
    else return;
    try {
      const res = await fetch(`/api/procurement/chain-state?${qs}`);
      if (res.ok) setData((await res.json()).data);
    } catch {
      // The lock is enforced server-side; a failed read just hides the banner.
    }
  }, [billId, poId, prId]);

  useEffect(() => { reload(); }, [reload]);

  return { chain: data, locked: data?.state === "locked", reload };
}

/** Banner under the page header: locked / locks-soon / reopened. Nothing when plainly open. */
export function ChainLockBanner({
  chain, ref, isAdmin, onChanged,
}: { chain: ChainStateData | null; ref: ChainRef; isAdmin: boolean; onChanged: () => void }) {
  const [reopenOpen, setReopenOpen] = useState(false);
  if (!chain) return null;

  if (chain.state === "locked") {
    return (
      <>
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 text-sm">
            <Lock className="h-5 w-5 text-indigo-700 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-indigo-900">This procurement cycle is closed.</p>
              <p className="text-indigo-800/80">
                Everything in it was received, approved, paid and TDS-deposited
                {chain.completeSince ? ` (completed ${formatDate(chain.completeSince)})` : ""}. Corrections are locked.
              </p>
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" variant="outline" className="border-red-300 text-red-700 hover:bg-red-50 shrink-0" onClick={() => setReopenOpen(true)}>
              Reopen cycle…
            </Button>
          )}
        </div>
        <ReopenChainDialog open={reopenOpen} onOpenChange={setReopenOpen} chain={chain} ref={ref} onDone={onChanged} />
      </>
    );
  }

  if (chain.reopened) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3 text-sm">
        <LockOpen className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium text-amber-900">
            Reopened{chain.lastReopen?.reopener ? ` by ${chain.lastReopen.reopener.full_name}` : ""}
            {chain.lastReopen ? ` on ${formatDate(chain.lastReopen.reopened_at)}` : ""}.
          </p>
          <p className="text-amber-800/80">
            {chain.lastReopen ? `Reason: ${chain.lastReopen.reason}. ` : ""}
            Corrections are open
            {chain.state === "closing" && chain.lockAt ? ` and lock again on ${formatDate(chain.lockAt)}` : "; it closes again automatically once everything is complete"}.
          </p>
        </div>
      </div>
    );
  }

  if (chain.state === "closing" && chain.lockAt) {
    return (
      <div className="rounded-md border bg-muted/40 px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground">
        <Lock className="h-4 w-4 shrink-0" />
        This cycle is complete. Corrections lock on <b className="text-foreground">{formatDate(chain.lockAt)}</b>.
      </div>
    );
  }
  return null;
}

/** MR page card: what is done and what is still outstanding before the cycle closes. */
export function ChainStatusCard({ chain }: { chain: ChainStateData | null }) {
  if (!chain) return null;
  const done = chain.conditions.filter((c) => c.done).length;
  const label =
    chain.state === "locked" ? "Closed"
    : chain.state === "closing" ? "Complete"
    : chain.exempt ? "Complete · not locked"
    : `Open · ${done} of ${chain.conditions.length} done`;
  const tone =
    chain.state === "locked" ? "bg-indigo-100 text-indigo-800"
    : chain.state === "closing" || chain.exempt ? "bg-green-100 text-green-800"
    : "bg-amber-100 text-amber-800";
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Cycle status</CardTitle>
          <Badge variant="secondary" className={tone}>{label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-0">
        {chain.conditions.map((c) => (
          <div key={c.key} className="flex gap-3 py-2 border-b last:border-0 text-sm">
            <span className={`w-5 text-center shrink-0 ${c.done ? "text-green-600" : "text-amber-600"}`}>{c.done ? "✓" : "○"}</span>
            <div>
              <p className={c.done ? "" : "font-medium"}>{c.label}</p>
              {!c.done && c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-2">
          {chain.exempt
            ? "This cycle finished before the closed-cycle lock was switched on, so it stays correctable."
            : "When every step is done the cycle closes after a 7-day correction window, and only an admin can reopen it."}
        </p>
      </CardContent>
    </Card>
  );
}

function ReopenChainDialog({
  open, onOpenChange, chain, ref, onDone,
}: { open: boolean; onOpenChange: (o: boolean) => void; chain: ChainStateData; ref: ChainRef; onDone: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [number, setNumber] = useState<string | null>(null);

  // The number to type is the chain root's own MR / PO / bill number.
  useEffect(() => {
    if (!open) return;
    setConfirm(""); setReason("");
    const table = chain.root.type === "pr" ? "requests" : chain.root.type === "po" ? "orders" : "bills";
    fetch(`/api/procurement/${table}/${chain.root.id}`)
      .then((r) => r.json())
      .then((j) => setNumber(j.data?.pr_number ?? j.data?.po_number ?? j.data?.bill_number ?? null))
      .catch(() => setNumber(null));
  }, [open, chain.root.id, chain.root.type]);

  const ready = !!number && confirm.trim().toLowerCase() === number.toLowerCase() && reason.trim().length >= MIN_REASON;

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/procurement/chain-reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bill_id: ref.billId, po_id: ref.poId, pr_id: ref.prId, confirm: confirm.trim(), reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(typeof json.error === "string" ? json.error : "Could not reopen the cycle"); return; }
      toast.success("Cycle reopened");
      onOpenChange(false);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-md border-2 border-red-300">
        <DialogHeader>
          <DialogTitle>Reopen closed cycle{number ? ` — ${number}` : ""}</DialogTitle>
          <DialogDescription>
            This cycle is locked{chain.completeSince ? ` since it completed on ${formatDate(chain.completeSince)}` : ""}.
            Reopening lets an admin undo steps in it again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium mb-1">Heads-up</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>Accounts and the vendor may already have acted on these figures</li>
              <li>It closes again by itself, 7 days after the cycle is complete again</li>
              <li>Procurement and Accounts are notified that it was reopened</li>
            </ul>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reopen-confirm">Type <b>{number ?? "the number"}</b> to confirm</Label>
            <Input id="reopen-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={number ?? ""} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason">Reason <span className="text-red-500">*</span></Label>
            <Textarea id="reopen-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Saved to the audit trail and sent to Accounts" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={!ready || submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Reopen cycle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
