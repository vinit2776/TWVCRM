"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCurrentUser } from "@/providers/current-user-provider";
import { SETTLEMENT_APPROVE_ROLES, SETTLEMENT_PAY_ROLES, SETTLEMENT_STATUS_LABELS, maskAccount } from "@/lib/exit-settlement";
import { EXIT_CHARGE_TYPE_LABELS, type ExitChargeType } from "@/lib/contract-exit";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { SettlementRow } from "@/lib/exit-settlement-server";

interface Review {
  settlement: SettlementRow & { cleared_by_name: string | null; approved_by_name: string | null; returned_by_name: string | null; paid_by_name: string | null; bank_account_number_masked: string | null };
  exit: { id: string; status: string; notice_received_on: string; last_day: string; reason: string; is_early_exit: boolean; started_by_name: string | null } | null;
  contract: { id: string; contract_number: string; customer: string; location: string | null; seats: number | null; end_date: string | null } | null;
  timeline: Array<{ action: string; changes: Record<string, { old: unknown; new: unknown }>; at: string; by: string | null }>;
  checks: Array<{ ok: boolean; warn?: boolean; label: string }>;
  self_cleared: boolean;
}

const MONEY = (v: unknown) => (typeof v === "number" ? formatCurrency(v) : String(v ?? ""));

function describe(a: Review["timeline"][number]): string {
  const c = a.changes ?? {};
  switch (a.action) {
    case "exit_started": return `Started the exit. Last day ${String(c.last_day?.new ?? "")}. Reason: ${String(c.reason?.new ?? "")}`;
    case "exit_updated": return c.inspection_done ? `Inspection ${c.inspection_done.new ? "marked done" : "reopened"}` : "Edited the notice";
    case "exit_cancelled": return "Cancelled the exit";
    case "exit_completed": return "Completed the exit (access removed, seats released)";
    case "exit_charge_added": return `Added charge ${String(c.charge?.new ?? "")}`;
    case "exit_charge_updated": return `Edited a charge (${Object.keys(c).join(", ")})`;
    case "exit_charge_removed": return `Removed charge ${String(c.charge?.old ?? "")}`;
    case "exit_cleared": return `Sent for approval: refund ${MONEY(c.refund?.new)}, retained ${MONEY(c.retained?.new)}, owed ${MONEY(c.owed?.new)}`;
    case "exit_returned": return `Returned for changes: ${String(c.reason?.new ?? "")}`;
    case "exit_approved": return "Approved";
    case "exit_paid": return `Refund paid, UTR ${String(c.payment_reference?.new ?? "")}`;
    default: return a.action;
  }
}

export default function ExitSettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useCurrentUser();
  const role = user?.role ?? "";
  const [data, setData] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [utr, setUtr] = useState("");
  const [fromAcc, setFromAcc] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [invRef, setInvRef] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/exit-settlements/${id}`, { cache: "no-store" });
    setData(res.ok ? (await res.json()).data : null);
    setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const post = async (path: string, body: unknown, ok: string) => {
    setBusy(true);
    const res = await fetch(`/api/exit-settlements/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    setBusy(false);
    if (res.ok) { toast.success(ok); load(); return true; }
    const err = await res.json().catch(() => null);
    toast.error(err?.error || "That didn't work");
    return false;
  };

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!data) return <div className="p-6 text-sm">This settlement was not found, or you don&apos;t have access.</div>;

  const { settlement: s, exit, contract, timeline, checks } = data;
  const isAdmin = (SETTLEMENT_APPROVE_ROLES as readonly string[]).includes(role);
  const canPay = (SETTLEMENT_PAY_ROLES as readonly string[]).includes(role);
  const charges = s.snapshot.charges ?? [];

  return (
    <div className="space-y-6">
      <PageBreadcrumb current={{ label: "Exit settlement" }} fallbackParent={{ href: "/accounting", label: "Acc Payables" }} />
      <div className="flex items-start gap-3">
        <Button asChild variant="ghost" size="icon"><Link href="/accounting"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div>
          <h1 className="text-2xl font-bold">
            {s.outcome === "owed" ? "Exit balance owed" : s.outcome === "nil" ? "Exit settlement" : "Deposit refund"} · {contract?.contract_number}
          </h1>
          <p className="text-sm text-muted-foreground">{contract?.customer}{contract?.location ? ` · ${contract.location}` : ""}</p>
        </div>
        <Badge variant="secondary" className="ml-auto">{SETTLEMENT_STATUS_LABELS[s.status]}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{s.refund_amount > 0 ? "Refund" : "Settlement"}</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Deposit held</span><span>{formatCurrency(s.deposit_amount)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Inspection charges</span><span>− {formatCurrency(s.charges_total)}</span></div>
              <div className="flex justify-between border-t pt-2 font-medium">
                <span>{s.owed_amount > 0 ? "Customer owes after the deposit" : "Refund to customer"}</span>
                <span>{formatCurrency(s.owed_amount > 0 ? s.owed_amount : s.refund_amount)}</span>
              </div>
              {s.refund_amount > 0 && (
                <div className="space-y-1 pt-2">
                  <div className="flex justify-between"><span className="text-muted-foreground">Pay to</span><span>{s.bank_account_name}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Account / IFSC</span><span>{maskAccount(s.bank_account_number)} / {s.bank_ifsc}</span></div>
                </div>
              )}
              <div className="flex justify-between pt-2"><span className="text-muted-foreground">Sent for approval by</span><span>{s.cleared_by_name ?? "—"}, {formatDate(s.cleared_at)}</span></div>
              {s.approved_at && <div className="flex justify-between"><span className="text-muted-foreground">Approved by</span><span>{s.approved_by_name ?? "—"}, {formatDate(s.approved_at)}</span></div>}
              {data.self_cleared && <p className="pt-1 text-xs text-amber-700">Cleared and approved by the same person.</p>}
              {s.return_reason && <p className="pt-1 text-xs text-red-700">Returned: {s.return_reason}</p>}

              {s.status === "pending_approval" && isAdmin && (
                <div className="flex gap-2 pt-3">
                  <Button disabled={busy} onClick={() => post("approve", {}, "Approved")}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Approve</Button>
                  <Button variant="outline" disabled={busy} onClick={() => setReturnOpen(true)}>Return for changes</Button>
                </div>
              )}
              {s.status === "pending_approval" && !isAdmin && (
                <p className="pt-3 text-xs text-muted-foreground">Waiting for the admin to approve. Payment opens after that.</p>
              )}
            </CardContent>
          </Card>

          {s.status === "approved" && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Record payment</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {canPay ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5"><Label>Paid on</Label><Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></div>
                      <div className="space-y-1.5"><Label>Bank UTR / reference</Label><Input value={utr} onChange={(e) => setUtr(e.target.value)} /></div>
                    </div>
                    <div className="space-y-1.5"><Label>Paid from account</Label><Input placeholder="HDFC current" value={fromAcc} onChange={(e) => setFromAcc(e.target.value)} /></div>
                    <div className="space-y-1.5"><Label>Notes (optional)</Label><Input value={payNotes} onChange={(e) => setPayNotes(e.target.value)} /></div>
                    <Button disabled={busy} onClick={() => post("pay", { payment_date: payDate, payment_reference: utr, paid_from_account: fromAcc, payment_notes: payNotes }, "Marked paid")}>
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Mark paid
                    </Button>
                  </>
                ) : <p className="text-muted-foreground">Accounts records the bank transfer here.</p>}
              </CardContent>
            </Card>
          )}

          {s.status === "paid" && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4 text-green-600" />Paid</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span>{formatCurrency(s.refund_amount)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Paid on</span><span>{s.payment_date ? formatDate(s.payment_date) : "—"}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Bank UTR</span><span>{s.payment_reference}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Paid from</span><span>{s.paid_from_account}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Recorded by</span><span>{s.paid_by_name ?? "—"}</span></div>
              </CardContent>
            </Card>
          )}

          {s.status === "closed" && s.owed_amount > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Amount owed by the customer</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">The deposit is used up. {formatCurrency(s.owed_amount)} of exit charges is still owed. Accounts raises the invoice through normal Billing; nothing was sent to the customer.</p>
                {s.owed_invoice_reference ? (
                  <p>Invoice noted: <span className="font-medium">{s.owed_invoice_reference}</span></p>
                ) : canPay ? (
                  <div className="flex gap-2">
                    <Input placeholder="Invoice reference" value={invRef} onChange={(e) => setInvRef(e.target.value)} />
                    <Button disabled={busy || !invRef.trim()} onClick={() => post("owed-handled", { reference: invRef }, "Noted")}>Mark invoice raised</Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Checks</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {checks.map((c) => (
                <div key={c.label} className="flex items-start gap-2">
                  {c.warn ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                  <span>{c.label}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Exit review</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {exit && (
                <div className="space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Notice received</span><span>{formatDate(exit.notice_received_on)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Last day</span><span>{formatDate(exit.last_day)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span className="text-right">{exit.reason}</span></div>
                </div>
              )}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead><tr className="border-b bg-muted/50 text-left"><th className="px-3 py-1.5 font-medium">Charge</th><th className="px-3 py-1.5 font-medium">By</th><th className="px-3 py-1.5 text-right font-medium">Amount</th></tr></thead>
                  <tbody>
                    {charges.length === 0 && <tr><td className="px-3 py-2 text-muted-foreground" colSpan={3}>No charges.</td></tr>}
                    {charges.map((c, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{EXIT_CHARGE_TYPE_LABELS[c.charge_type as ExitChargeType] ?? c.charge_type}: {c.description}{c.edited_after_add && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">edited</span>}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{c.added_by_name ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right">{formatCurrency(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Timeline</p>
                <ul className="space-y-1.5">
                  {timeline.map((t, i) => (
                    <li key={i} className="flex gap-3 text-xs">
                      <span className="w-20 shrink-0 text-muted-foreground">{formatDate(t.at)}</span>
                      <span>{t.by ? `${t.by}: ` : ""}{describe(t)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {contract && <Button asChild variant="outline" size="sm"><Link href={`/contracts/${contract.id}/exit`}>Open full exit page</Link></Button>}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Return for changes</DialogTitle>
            <DialogDescription>The charges unlock and the person who sent it is notified.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5"><Label>Reason</Label><Textarea rows={3} value={returnReason} onChange={(e) => setReturnReason(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturnOpen(false)}>Cancel</Button>
            <Button disabled={busy || !returnReason.trim()} onClick={async () => { if (await post("return", { reason: returnReason.trim() }, "Returned for changes")) setReturnOpen(false); }}>Return</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
