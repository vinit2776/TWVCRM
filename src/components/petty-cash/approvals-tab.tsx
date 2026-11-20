"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Paperclip } from "lucide-react";
import { toast } from "sonner";
import { AttachmentDialog } from "@/components/petty-cash/attachments";
import { needsReceiptNudge, PC_RECEIPT_NUDGE_DEFAULT } from "@/lib/petty-cash-attachments";
import { useFetch } from "@/hooks/use-fetch";
import { usePettyCashRequests, usePettyCashEntries } from "@/hooks/use-petty-cash";
import {
  PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS,
  PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS,
} from "@/lib/constants";
import type { PettyCashRequest, PettyCashEntry } from "@/types";

interface Props {
  userRole: string;
}

export function ApprovalsTab({ userRole }: Props) {
  const [tab, setTab] = useState<"requests" | "entries">("requests");

  // Pending requests (for manager/admin approval)
  const { data: pendingRequests, loading: reqLoading, refetch: refetchReqs } = usePettyCashRequests({ status: "pending" });

  // Pending entries — manager sees pending_manager, admin sees pending_admin
  const managerEntryStatus = userRole === "admin" || userRole === "accounts" ? undefined : "pending_manager";
  const { data: pendingEntries, loading: entLoading, refetch: refetchEntries } = usePettyCashEntries({
    status: managerEntryStatus,
  });
  // For admin/accounts, also fetch pending_admin
  const { data: pendingAdminEntries, loading: adminEntLoading, refetch: refetchAdminEntries } = usePettyCashEntries({
    status: "pending_admin",
  });

  const allPendingEntries = [...(pendingEntries || []), ...(userRole === "admin" || userRole === "accounts" ? pendingAdminEntries || [] : [])];

  // Action dialogs
  const [actionDialog, setActionDialog] = useState<{
    type: "approve_request" | "reject_request" | "approve_entry" | "reject_entry";
    item: PettyCashRequest | PettyCashEntry;
  } | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [acting, setActing] = useState(false);
  const [billsFor, setBillsFor] = useState<{ id: string; entry_number: string } | null>(null);
  const { data: nudgeAmount } = useFetch<number>("/api/petty-cash/receipt-policy", {
    initialData: PC_RECEIPT_NUDGE_DEFAULT,
    select: (json) => Number(json.nudgeAmount) || PC_RECEIPT_NUDGE_DEFAULT,
  });
  const canAddBills = userRole === "admin" || userRole === "accounts";

  const handleAction = async () => {
    if (!actionDialog) return;
    setActing(true);
    try {
      const { type, item } = actionDialog;
      let url: string;
      let body: Record<string, unknown>;

      if (type === "approve_request" || type === "reject_request") {
        url = `/api/petty-cash/requests/${item.id}`;
        body = { action: type === "approve_request" ? "approve" : "reject", note: actionNote || undefined };
      } else {
        url = `/api/petty-cash/entries/${item.id}`;
        body = { action: type === "approve_entry" ? "approve" : "reject", note: actionNote || undefined };
      }

      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      const statusLabel = type.includes("approve") ? "approved" : "rejected";
      toast.success(`Successfully ${statusLabel}${type.includes("request") ? " — awaiting issuance from Accounts" : ""}`);
      setActionDialog(null);
      setActionNote("");
      refetchReqs();
      refetchEntries();
      refetchAdminEntries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  const loading = reqLoading || entLoading || adminEntLoading;

  return (
    <div className="space-y-6">
      {/* Tab switcher */}
      <div className="flex gap-2">
        <Button size="sm" variant={tab === "requests" ? "default" : "outline"} onClick={() => setTab("requests")}>
          Fund Requests {pendingRequests.length > 0 && `(${pendingRequests.length})`}
        </Button>
        <Button size="sm" variant={tab === "entries" ? "default" : "outline"} onClick={() => setTab("entries")}>
          Expense Approvals {allPendingEntries.length > 0 && `(${allPendingEntries.length})`}
        </Button>
      </div>

      {tab === "requests" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pending Approval ({pendingRequests.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="animate-pulse space-y-3">{[1, 2].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
            ) : pendingRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No pending requests</p>
            ) : (
              <div className="space-y-3">
                {pendingRequests.map((r) => {
                  const owner = (r.book as { owner?: { full_name: string } })?.owner;
                  const balance = (r.book as { current_balance: number })?.current_balance;
                  return (
                    <div key={r.id} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <p className="font-medium">{r.request_number} — {owner?.full_name || "Unknown"}</p>
                        <p className="text-sm text-muted-foreground">{r.purpose}</p>
                        <p className="text-xs text-muted-foreground">Current balance: ₹{Number(balance || 0).toLocaleString("en-IN")}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold mr-2">₹{Number(r.amount_requested).toLocaleString("en-IN")}</p>
                        <Button size="sm" variant="outline" className="text-green-700 border-green-300" onClick={() => setActionDialog({ type: "approve_request", item: r })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => setActionDialog({ type: "reject_request", item: r })}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-4">
              Approved requests will appear in the Accounting → Petty Cash tab for the accounts team to issue payment.
            </p>
          </CardContent>
        </Card>
      )}

      {tab === "entries" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pending Expense Approvals ({allPendingEntries.length})</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Open &quot;View bills&quot; to see the receipt before you decide. <strong>Approve</strong> deducts the amount from the person&apos;s petty cash balance (₹5,000 or more then goes to Admin/Accounts). <strong>Reject</strong> sends it back to them with your reason.
            </p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="animate-pulse space-y-3">{[1, 2].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}</div>
            ) : allPendingEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No pending expense approvals</p>
            ) : (
              <div className="space-y-3">
                {allPendingEntries.map((e) => {
                  const owner = (e.book as { owner?: { full_name: string } })?.owner;
                  const cat = (e.category as { name: string } | null)?.name;
                  const nBills = e.attachments?.length ?? 0;
                  const missing = needsReceiptNudge(Number(e.amount), nBills, nudgeAmount);
                  return (
                    <div key={e.id} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <p className="font-medium">{e.entry_number} — {owner?.full_name || e.submitter?.full_name || "Unknown"}</p>
                        <p className="text-sm text-muted-foreground">{e.description}</p>
                        <div className="flex gap-2 mt-1">
                          {cat && <Badge variant="outline" className="text-xs">{cat}</Badge>}
                          <Badge variant="secondary" className={`text-xs ${PC_ENTRY_STATUS_COLORS[e.status]}`}>
                            {PC_ENTRY_STATUS_LABELS[e.status]}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold mr-2">₹{Number(e.amount).toLocaleString("en-IN")}</p>
                        <Button size="sm" variant="outline" className={missing ? "border-amber-300 text-amber-800 bg-amber-50" : ""}
                          onClick={() => setBillsFor({ id: e.id, entry_number: e.entry_number })}>
                          <Paperclip className="h-3.5 w-3.5 mr-1" />{nBills > 0 ? `View bills (${nBills})` : missing ? "No bill attached" : "No bill"}
                        </Button>
                        <Button size="sm" variant="outline" className="text-green-700 border-green-300" onClick={() => setActionDialog({ type: "approve_entry", item: e })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => setActionDialog({ type: "reject_entry", item: e })}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Action Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={(open) => !open && setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.type === "approve_request" && "Approve Funding Request"}
              {actionDialog?.type === "reject_request" && "Reject Funding Request"}
              {actionDialog?.type === "approve_entry" && "Approve Expense"}
              {actionDialog?.type === "reject_entry" && "Reject Expense"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Textarea
                placeholder={actionDialog?.type?.includes("reject") ? "Tell them why — they will see this" : "Any comments..."}
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
              {actionDialog?.type === "approve_request" && "What happens next: the request moves to Accounting, where the accounts team hands over the cash. The balance goes up only when they do."}
              {actionDialog?.type === "reject_request" && "What happens next: the request is closed and the person sees your note. They can raise a new request."}
              {actionDialog?.type === "approve_entry" && "What happens next: the amount is deducted from the person's balance. If it is ₹5,000 or more it first goes to Admin/Accounts for a second approval."}
              {actionDialog?.type === "reject_entry" && "What happens next: the expense goes back to the person with your note, and they can fix it and resubmit. Nothing is deducted."}
            </p>
            <Button onClick={handleAction} disabled={acting} variant={actionDialog?.type?.includes("reject") ? "destructive" : "default"} className="w-full">
              {acting ? "Processing..." : actionDialog?.type === "approve_request" ? "Approve request"
                : actionDialog?.type === "reject_request" ? "Reject request"
                : actionDialog?.type === "approve_entry" ? "Approve expense" : "Reject expense"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {billsFor && (
        <AttachmentDialog
          open
          onOpenChange={(o) => { if (!o) { setBillsFor(null); refetchEntries(); refetchAdminEntries(); } }}
          title={`Bills for ${billsFor.entry_number}`}
          description="What the person attached as proof of this expense. Check the amount and what was bought before approving."
          target={{ entryId: billsFor.id }}
          canAdd={canAddBills}
          canRemove={() => canAddBills}
          addLabel="Add a bill (photo or PDF)"
          emptyText="No bill was attached. You can still approve if you know the expense is genuine, or reject and ask for a bill."
        />
      )}
    </div>
  );
}
