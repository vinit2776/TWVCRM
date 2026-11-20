"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AttachmentList } from "@/components/petty-cash/attachments";
import { useFetch } from "@/hooks/use-fetch";
import { usePettyCashRequests } from "@/hooks/use-petty-cash";
import { PC_REJECT_REASONS, PC_BULK_APPROVE_MAX_AMOUNT, buildRejectNote, canDecideRequest } from "@/lib/petty-cash-approval";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { InboxItem } from "@/app/api/petty-cash/inbox/route";
import type { PettyCashRequest } from "@/types";

interface InboxResponse {
  data: InboxItem[];
  viewer: { id: string; role: string };
  policy: { nudgeAmount: number; secondApprovalAmount: number };
}

async function decideEntry(id: string, action: "approve" | "reject", note?: string) {
  const res = await fetch(`/api/petty-cash/entries/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, note: note || undefined }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Action failed");
  return json as { status: string };
}

export function ApprovalsTab({ userRole }: { userRole: string }) {
  const [tab, setTab] = useState<"entries" | "requests">("entries");
  const inbox = useFetch<InboxResponse | null>("/api/petty-cash/inbox", { initialData: null, select: (j) => j as unknown as InboxResponse });
  const requests = usePettyCashRequests({ status: "pending" });
  const items = inbox.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={tab === "entries" ? "default" : "outline"} onClick={() => setTab("entries")}>
          Expenses to approve {items.length > 0 && `(${items.length})`}
        </Button>
        <Button size="sm" variant={tab === "requests" ? "default" : "outline"} onClick={() => setTab("requests")}>
          Fund requests {requests.data.length > 0 && `(${requests.data.length})`}
        </Button>
      </div>

      {tab === "entries" ? (
        <ExpenseInbox inbox={inbox.data} loading={inbox.loading} refetch={inbox.refetch} userRole={userRole} />
      ) : (
        <FundRequests requests={requests.data} loading={requests.loading} refetch={requests.refetch} userRole={userRole} viewerId={inbox.data?.viewer.id ?? null} />
      )}
    </div>
  );
}

/* ─────────────── Expenses ─────────────── */

function ExpenseInbox({
  inbox, loading, refetch, userRole,
}: { inbox: InboxResponse | null; loading: boolean; refetch: () => void; userRole: string }) {
  const items = useMemo(() => inbox?.data ?? [], [inbox]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [acting, setActing] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Keep a valid selection as items are decided and drop out of the queue.
  useEffect(() => {
    if (!items.length) { setSelectedId(null); return; }
    if (!items.some((i) => i.id === selectedId)) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const clean = items.filter((i) => i.clean);
  const second = inbox?.policy.secondApprovalAmount ?? 5000;
  const canAddBills = userRole === "admin" || userRole === "accounts";

  const resetReject = () => { setRejecting(false); setReasons([]); setDetail(""); };

  const approve = async (item: InboxItem) => {
    setActing(true);
    try {
      const { status } = await decideEntry(item.id, "approve");
      toast.success(status === "pending_admin"
        ? `Approved. ${item.entry_number} now waits for Admin/Accounts (amounts of ${formatCurrency(second)} or more need a second approval).`
        : `Approved. ${formatCurrency(item.amount)} was deducted from ${item.person.name}'s balance.`);
      resetReject();
      refetch();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(false); }
  };

  const reject = async (item: InboxItem) => {
    const note = buildRejectNote(reasons, detail);
    if (!note) { toast.error("Pick a reason or write one, so they know what to fix."); return; }
    setActing(true);
    try {
      await decideEntry(item.id, "reject", note);
      toast.success(`Sent back to ${item.person.name} with your reason. Nothing was deducted.`);
      resetReject();
      refetch();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(false); }
  };

  const approveAllClean = async () => {
    setActing(true);
    let ok = 0;
    const failed: string[] = [];
    for (const i of clean) {
      try { await decideEntry(i.id, "approve"); ok++; } catch { failed.push(i.entry_number); }
    }
    setActing(false);
    setBulkOpen(false);
    if (failed.length) toast.warning(`${ok} approved. ${failed.length} could not be approved (${failed.join(", ")}) — they are still in your list.`);
    else toast.success(`${ok} expense${ok === 1 ? "" : "s"} approved.`);
    refetch();
  };

  if (loading && !inbox) return <div className="animate-pulse space-y-3"><div className="h-12 rounded bg-muted" /><div className="h-48 rounded bg-muted" /></div>;

  if (!items.length) {
    return (
      <Card><CardContent className="py-10 text-center space-y-1">
        <p className="font-medium">Nothing is waiting for you.</p>
        <p className="text-sm text-muted-foreground">New expenses appear here as soon as someone logs them. You will also get a notification.</p>
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
        <p><strong>How this works:</strong> pick an expense on the left, check the bill and the warnings, then press <strong>Approve</strong> or <strong>Reject</strong>.</p>
        <p>Approve takes the amount off that person&apos;s petty cash balance. Reject sends it back to them with your reason and takes nothing off.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{items.length} waiting for you</p>
        <div className="text-right">
          <Button size="sm" disabled={!clean.length || acting} onClick={() => setBulkOpen(true)}>
            Approve {clean.length} simple expense{clean.length === 1 ? "" : "s"}…
          </Button>
          <p className="text-xs text-muted-foreground mt-1">Simple = bill attached, {formatCurrency(PC_BULK_APPROVE_MAX_AMOUNT)} or less, no warnings. You will see the list before anything is approved.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[300px_1fr]">
        <div className="space-y-2">
          {items.map((i) => (
            <button key={i.id} type="button" onClick={() => { setSelectedId(i.id); resetReject(); }}
              className={`w-full text-left rounded-lg border p-3 bg-background hover:bg-muted/40 ${i.id === selectedId ? "border-foreground ring-1 ring-foreground" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{i.person.name}</span>
                <span className="font-semibold">{formatCurrency(i.amount)}</span>
              </div>
              <p className="text-sm text-muted-foreground truncate">{i.description}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {i.attachment_count > 0
                  ? <Badge variant="secondary" className="bg-green-100 text-green-800 text-xs">Bill attached</Badge>
                  : <Badge variant="secondary" className="bg-red-100 text-red-700 text-xs">No bill</Badge>}
                {i.flags.length > 0 && <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs">{i.flags.length} warning{i.flags.length > 1 ? "s" : ""}</Badge>}
                {i.own && <Badge variant="secondary" className="bg-blue-100 text-blue-800 text-xs">Yours</Badge>}
                {i.stage === "pending_admin" && <Badge variant="secondary" className="bg-orange-100 text-orange-800 text-xs">Second approval</Badge>}
              </div>
            </button>
          ))}
        </div>

        {selected && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{selected.description}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {selected.entry_number} · {selected.person.name} · {selected.category?.name ?? "No category"} · {formatDate(selected.date)}
                  </p>
                </div>
                <p className="text-2xl font-bold shrink-0">{formatCurrency(selected.amount)}</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="text-sm font-medium mb-2">Bill or proof</p>
                  <AttachmentList
                    key={selected.id}
                    target={{ entryId: selected.id }}
                    canAdd={canAddBills}
                    canRemove={() => canAddBills}
                    addLabel="Add a bill (photo or PDF)"
                    emptyText={selected.amount >= (inbox?.policy.nudgeAmount ?? 1000)
                      ? "No bill was attached. Reject and ask for one, or approve if you know the expense is genuine."
                      : "No bill attached. For a small amount this is normally fine."}
                    onChanged={refetch}
                  />
                </div>
                <div className="space-y-3 text-sm">
                  <div>
                    <p className="font-medium">Their petty cash balance</p>
                    <p className="text-muted-foreground">
                      {formatCurrency(selected.balance)} now → <strong className="text-foreground">{formatCurrency(selected.balance - selected.amount)}</strong> after this is approved
                      {selected.balance - selected.amount < 0 && <span className="block text-amber-700">This is more than they hold. Consider topping up their book.</span>}
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Approval steps</p>
                    <p className="text-muted-foreground">
                      {selected.stage === "pending_admin"
                        ? "This already has a manager's approval. Your decision here is final."
                        : selected.needs_second_approval
                          ? userRole === "admin"
                            ? `Over ${formatCurrency(second)}, but as Admin your approval alone is enough.`
                            : `Over ${formatCurrency(second)}: after you approve, Admin/Accounts gives a second approval.`
                          : "Your approval is the only one needed."}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {selected.flags.length === 0
                      ? <p className="rounded-md bg-green-50 text-green-800 px-3 py-2">No warnings.</p>
                      : selected.flags.map((f) => <p key={f.code} className="rounded-md bg-amber-50 text-amber-800 px-3 py-2">{f.message}</p>)}
                  </div>
                </div>
              </div>

              <div className="border-t pt-4 space-y-3">
                {selected.own ? (
                  <p className="rounded-md bg-blue-50 text-blue-800 text-sm px-3 py-2">
                    You logged this expense, so you cannot approve or reject it. Another approver will decide it.
                  </p>
                ) : rejecting ? (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Why are you sending it back? <span className="font-normal text-muted-foreground">{selected.person.name} will read this.</span></p>
                    <div className="flex flex-wrap gap-2">
                      {PC_REJECT_REASONS.map((r) => {
                        const on = reasons.includes(r);
                        return (
                          <button key={r} type="button" onClick={() => setReasons(on ? reasons.filter((x) => x !== r) : [...reasons, r])}
                            className={`rounded-full border px-3 py-1 text-sm ${on ? "bg-foreground text-background" : "bg-background hover:bg-muted"}`}>{r}</button>
                        );
                      })}
                    </div>
                    <Textarea placeholder="Add more detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="destructive" disabled={acting} onClick={() => reject(selected)}>{acting ? "Sending…" : "Reject and send back"}</Button>
                      <Button variant="outline" disabled={acting} onClick={resetReject}>Cancel</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Nothing is deducted. They can fix the expense and submit it again.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button className="bg-green-700 hover:bg-green-800 text-white" disabled={acting} onClick={() => approve(selected)}>
                      {acting ? "Approving…" : selected.stage === "pending_manager" && selected.needs_second_approval && userRole !== "admin"
                        ? "Approve and pass to Admin/Accounts" : "Approve"}
                    </Button>
                    <Button variant="outline" className="text-red-600 border-red-300" disabled={acting} onClick={() => setRejecting(true)}>Reject…</Button>
                    <span className="text-xs text-muted-foreground">The next expense opens automatically.</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve {clean.length} simple expense{clean.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              Each has a bill, is {formatCurrency(PC_BULK_APPROVE_MAX_AMOUNT)} or less and has no warnings. The amounts will be deducted from each person&apos;s balance straight away.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-60 overflow-y-auto divide-y text-sm">
            {clean.map((c) => (
              <li key={c.id} className="flex justify-between gap-2 py-1.5">
                <span className="truncate">{c.person.name} — {c.description}</span>
                <span className="font-medium shrink-0">{formatCurrency(c.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm font-medium text-right">Total {formatCurrency(clean.reduce((s, c) => s + c.amount, 0))}</p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={acting}>Cancel</Button>
            <Button className="bg-green-700 hover:bg-green-800 text-white" onClick={approveAllClean} disabled={acting}>
              {acting ? "Approving…" : `Approve all ${clean.length}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─────────────── Fund requests ─────────────── */

function FundRequests({
  requests, loading, refetch, userRole, viewerId,
}: { requests: PettyCashRequest[]; loading: boolean; refetch: () => void; userRole: string; viewerId: string | null }) {
  const [dialog, setDialog] = useState<{ type: "approve" | "reject"; item: PettyCashRequest } | null>(null);
  const [note, setNote] = useState("");
  const [acting, setActing] = useState(false);

  const submit = async () => {
    if (!dialog) return;
    if (dialog.type === "reject" && !note.trim()) { toast.error("Write a reason so they know why."); return; }
    setActing(true);
    try {
      const res = await fetch(`/api/petty-cash/requests/${dialog.item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: dialog.type, note: note || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Action failed");
      toast.success(dialog.type === "approve" ? "Approved. It now appears in Acc Payables for Accounts to pay." : "Request rejected.");
      setDialog(null); setNote(""); refetch();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(false); }
  };

  const canDecideRole = userRole === "admin";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fund requests waiting for a decision ({requests.length})</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Someone is asking for cash to be added to their petty cash book. <strong>Approve</strong> sends it to Acc Payables, where Accounts pay the money, enter the payment reference and add it to the balance. <strong>Reject</strong> closes it with your reason.
          {!canDecideRole && " Only an admin approves these. After approval, Accounts pays it from Acc Payables."}
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="animate-pulse space-y-3">{[1, 2].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No fund requests are waiting.</p>
        ) : (
          <div className="space-y-3">
            {requests.map((r) => {
              const owner = (r.book as { owner?: { full_name: string } })?.owner;
              const balance = Number((r.book as { current_balance: number })?.current_balance || 0);
              const decision = viewerId ? canDecideRequest(userRole, viewerId, { created_by: r.created_by, status: r.status }) : { ok: false as const, reason: "" };
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border rounded-lg p-3">
                  <div>
                    <p className="font-medium">{r.request_number} — {owner?.full_name || "Unknown"}</p>
                    <p className="text-sm text-muted-foreground">{r.purpose}</p>
                    <p className="text-xs text-muted-foreground">Balance now: {formatCurrency(balance)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold mr-2">{formatCurrency(Number(r.amount_requested))}</p>
                    {decision.ok ? (
                      <>
                        <Button size="sm" variant="outline" className="text-green-700 border-green-300" onClick={() => { setNote(""); setDialog({ type: "approve", item: r }); }}>Approve</Button>
                        <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => { setNote(""); setDialog({ type: "reject", item: r }); }}>Reject</Button>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground max-w-[220px] text-right">{decision.reason}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.type === "approve" ? "Approve fund request" : "Reject fund request"}</DialogTitle>
            <DialogDescription>
              {dialog?.type === "approve"
                ? "What happens next: the request appears in Acc Payables (Petty cash fund requests). Accounts pay it and enter the payment reference. The person's balance goes up only when they confirm the payment."
                : "What happens next: the request is closed and the person sees your reason. They can raise a new one."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{dialog?.type === "reject" ? "Reason (they will read this)" : "Note (optional)"}</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button onClick={submit} disabled={acting} variant={dialog?.type === "reject" ? "destructive" : "default"} className="w-full">
            {acting ? "Processing…" : dialog?.type === "approve" ? "Approve request" : "Reject request"}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
