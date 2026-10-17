"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useExit } from "@/components/contracts/exit/use-exit";
import { ChargeDialog } from "@/components/contracts/exit/charge-dialog";
import { SettlementCard } from "@/components/contracts/exit/settlement-card";
import {
  EXIT_CHARGE_ROLES, EXIT_CHARGE_TYPE_LABELS, EXIT_COMPLETE_ROLES, EXIT_START_ROLES, canCompleteOn, daysBetween, type ExitChargeType,
} from "@/lib/contract-exit";
import type { ExitChargeRow } from "@/lib/contract-exit-server";
import { formatCurrency, formatDate } from "@/lib/utils";

interface ContractLite {
  id: string;
  contract_number: string;
  status: string;
  end_date: string | null;
  seats: number | null;
  lead?: { first_name: string | null; last_name: string | null; company: string | null } | null;
  location?: { name: string } | null;
}

function Step({ n, label, state }: { n: number; label: string; state: "done" | "current" | "later" }) {
  const cls = state === "done" ? "bg-green-100 text-green-800" : state === "current" ? "bg-blue-100 text-blue-800 border border-blue-300" : "bg-muted text-muted-foreground";
  return <div className={`rounded-md px-3 py-1 text-xs font-medium ${cls}`}>{n} {label}</div>;
}

export default function ExitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useCurrentUser();
  const role = user?.role ?? "";
  const { view, loading, reload } = useExit(id);
  const [contract, setContract] = useState<ContractLite | null>(null);

  const [chargeOpen, setChargeOpen] = useState(false);
  const [editing, setEditing] = useState<ExitChargeRow | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editReason, setEditReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const loadContract = useCallback(async () => {
    const res = await fetch(`/api/contracts/${id}`, { cache: "no-store" });
    if (res.ok) setContract((await res.json()).data);
  }, [id]);
  useEffect(() => { loadContract(); }, [loadContract]);

  const refresh = () => { reload(); loadContract(); };

  const call = async (method: string, url: string, body?: unknown, okMsg?: string) => {
    setBusy(true);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    setBusy(false);
    if (res.ok) { if (okMsg) toast.success(okMsg); refresh(); return true; }
    const err = await res.json().catch(() => null);
    toast.error(err?.error || "That didn't work");
    return false;
  };

  if (loading || !contract) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const canView = ["admin", "manager", "sales_rep", "floor_manager", "accounts"].includes(role);
  if (!canView) return <div className="p-6 text-sm">You don&apos;t have access to this page.</div>;

  const customer = contract.lead?.company || `${contract.lead?.first_name ?? ""} ${contract.lead?.last_name ?? ""}`.trim() || "Customer";

  if (!view) {
    return (
      <div className="space-y-4">
        <PageBreadcrumb current={{ label: "Exit" }} fallbackParent={{ href: `/contracts/${id}`, label: contract.contract_number }} />
        <p className="text-sm text-muted-foreground">No exit has been started for {contract.contract_number}.</p>
        <Button asChild variant="outline"><Link href={`/contracts/${id}`}>Back to contract</Link></Button>
      </div>
    );
  }

  const { exit, charges, settlement } = view;
  const inNotice = exit.status === "in_notice";
  const record = (view as { settlementRecord?: { status: string } | null }).settlementRecord ?? null;
  // Once sent for approval the charges are locked (the server refuses changes too).
  const chargesLocked = !!record && record.status !== "returned";
  const canEditCharges = (EXIT_CHARGE_ROLES as readonly string[]).includes(role) && !chargesLocked;
  const canStart = (EXIT_START_ROLES as readonly string[]).includes(role);
  const canComplete = (EXIT_COMPLETE_ROLES as readonly string[]).includes(role);
  const lastDayArrived = canCompleteOn(exit.last_day, new Date());
  const noticeDays = daysBetween(exit.notice_received_on, exit.last_day);
  const stage = exit.status === "completed" ? (exit.inspection_done_at ? 3 : 2) : exit.inspection_done_at ? 3 : 2;

  const completeExit = async () => {
    setCompleting(true);
    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "terminated", termination_reason: `Exit: ${exit.reason}` }),
    });
    setCompleting(false);
    if (res.ok) { toast.success("Exit completed"); setCompleteOpen(false); refresh(); }
    else { const err = await res.json().catch(() => null); toast.error(err?.error || "Couldn't complete the exit"); }
  };

  return (
    <div className="space-y-6">
      <PageBreadcrumb current={{ label: "Exit" }} fallbackParent={{ href: `/contracts/${id}`, label: contract.contract_number }} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon"><Link href={`/contracts/${id}`}><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div>
            <h1 className="font-mono text-2xl font-bold">Exit · {contract.contract_number}</h1>
            <p className="text-sm text-muted-foreground">
              {customer}{contract.location ? ` · ${contract.location.name}` : ""}{contract.seats ? ` · ${contract.seats} seat${contract.seats === 1 ? "" : "s"}` : ""}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {inNotice && canComplete && (
            <Button onClick={() => setCompleteOpen(true)} disabled={!lastDayArrived} title={lastDayArrived ? undefined : `Opens on the last day, ${formatDate(exit.last_day)}`}>
              Complete exit
            </Button>
          )}
          {inNotice && canComplete && (
            <Button variant="outline" onClick={() => setCancelOpen(true)}>Cancel exit</Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Step n={1} label="Notice" state="done" />
        <Step n={2} label="Inspection" state={exit.inspection_done_at ? "done" : "current"} />
        <Step n={3} label="Settlement" state={stage === 3 ? "current" : "later"} />
        <Step n={4} label="Approval and refund" state={(view as { settlementRecord?: { status: string } | null }).settlementRecord ? ((view as { settlementRecord?: { status: string } | null }).settlementRecord?.status === "paid" || (view as { settlementRecord?: { status: string } | null }).settlementRecord?.status === "closed" ? "done" : "current") : "later"} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            Notice
            <Badge variant="secondary" className={exit.status === "completed" ? "bg-gray-100 text-gray-700" : "bg-amber-100 text-amber-800"}>
              {exit.status === "completed" ? "Exit completed" : "In notice"}
            </Badge>
            {exit.is_early_exit && <Badge variant="secondary" className="bg-red-100 text-red-700">Early exit</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Notice received</span><span>{formatDate(exit.notice_received_on)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Last day</span><span>{formatDate(exit.last_day)} ({noticeDays} days of notice)</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Contract ends</span><span>{contract.end_date ? formatDate(contract.end_date) : "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span className="text-right">{exit.reason}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Started by</span><span>{exit.started_by_name ?? "—"}, {formatDate(exit.started_at)}</span></div>
          {exit.completed_at && (
            <div className="flex justify-between"><span className="text-muted-foreground">Completed</span><span>{exit.completed_by_name ?? "—"}, {formatDate(exit.completed_at)}</span></div>
          )}
          {inNotice && canStart && (
            <Button size="sm" variant="outline" onClick={() => { setEditNotice(exit.notice_received_on); setEditLast(exit.last_day); setEditReason(exit.reason); setEditOpen(true); }}>
              Edit notice
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            Area inspection
            <Badge variant="secondary" className={exit.inspection_done_at ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
              {exit.inspection_done_at ? `Done ${formatDate(exit.inspection_done_at)}` : "Open"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {charges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No charges added.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-muted/50 text-left">
                  <th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">What</th>
                  <th className="px-3 py-2 font-medium">By</th><th className="px-3 py-2 text-right font-medium">Amount</th><th className="px-3 py-2" />
                </tr></thead>
                <tbody>
                  {charges.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="px-3 py-2">{EXIT_CHARGE_TYPE_LABELS[c.charge_type as ExitChargeType] ?? c.charge_type}</td>
                      <td className="px-3 py-2">{c.description}{c.edited_after_add && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">edited</span>}</td>
                      <td className="px-3 py-2 text-muted-foreground">{c.added_by_name ?? "—"}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(c.amount)}</td>
                      <td className="px-3 py-2 text-right">
                        {canEditCharges && (
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Edit charge" onClick={() => { setEditing(c); setChargeOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label="Remove charge" disabled={busy}
                              onClick={() => { if (window.confirm("Remove this charge?")) call("DELETE", `/api/contracts/${id}/exit/charges/${c.id}`, undefined, "Charge removed"); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-between text-sm font-medium"><span>Total charges</span><span>{formatCurrency(settlement.charges)}</span></div>
          {canEditCharges && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => { setEditing(null); setChargeOpen(true); }}><Plus className="mr-1 h-4 w-4" />Add charge</Button>
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => call("PATCH", `/api/contracts/${id}/exit`, { inspection_done: !exit.inspection_done_at }, exit.inspection_done_at ? "Inspection reopened" : "Inspection marked done")}>
                {exit.inspection_done_at ? "Reopen inspection" : "Mark inspection done"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <SettlementCard contractId={id} view={view as never} role={role} onChanged={refresh} />

      <ChargeDialog contractId={id} charge={editing} open={chargeOpen} onOpenChange={setChargeOpen} onSaved={refresh} />

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Edit notice</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Notice received</Label><Input type="date" value={editNotice} onChange={(e) => setEditNotice(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Last day</Label><Input type="date" value={editLast} onChange={(e) => setEditLast(e.target.value)} /></div>
            </div>
            <div className="space-y-1.5"><Label>Reason</Label><Textarea rows={2} value={editReason} onChange={(e) => setEditReason(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button disabled={busy} onClick={async () => { if (await call("PATCH", `/api/contracts/${id}/exit`, { notice_received_on: editNotice, last_day: editLast, reason: editReason }, "Notice updated")) setEditOpen(false); }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this exit?</DialogTitle>
            <DialogDescription>For a customer who changes their mind. The contract stays active. Charges added so far are kept in the record.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5"><Label>Reason</Label><Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Keep exit</Button>
            <Button variant="destructive" disabled={busy || !cancelReason.trim()}
              onClick={async () => { if (await call("PATCH", `/api/contracts/${id}/exit`, { cancel: true, cancel_reason: cancelReason.trim() }, "Exit cancelled")) { setCancelOpen(false); } }}>
              Cancel exit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Complete exit for {contract.contract_number}</DialogTitle>
            <DialogDescription>This is what Terminate did before, now done on the last day.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Contract status</span><span>Active → Terminated</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Door access</span><span>Blocked for all members</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Seats and spaces</span><span>Released</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">WiFi vouchers</span><span>Revoked, IT emailed</span></div>
            <p className="pt-2 text-xs text-muted-foreground">Charges can still be added after this. The refund does not hold this up. The customer is not contacted; the team gets an exit-completed notice.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteOpen(false)} disabled={completing}>Cancel</Button>
            <Button variant="destructive" onClick={completeExit} disabled={completing}>
              {completing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Complete exit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
