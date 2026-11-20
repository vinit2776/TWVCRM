"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, AlertCircle, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/providers/current-user-provider";
import { AttachmentDialog } from "@/components/petty-cash/attachments";
import { needsReceiptNudge, PC_RECEIPT_NUDGE_DEFAULT } from "@/lib/petty-cash-attachments";
import { useFetch } from "@/hooks/use-fetch";
import {
  PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS,
  PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS,
  PC_ISSUANCE_METHOD_LABELS,
} from "@/lib/constants";
import type { PettyCashRequest, PettyCashEntry, PaginatedResponse } from "@/types";

type PendingItem = { kind: "entry_approval"; data: PettyCashEntry };

export function PettyCashIssuance() {
  const { user } = useCurrentUser();
  const [pendingAdminEntries, setPendingAdminEntries] = useState<PettyCashEntry[]>([]);
  const [recentlyIssued, setRecentlyIssued] = useState<PettyCashRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: policy } = useFetch<{ nudgeAmount: number }>("/api/petty-cash/receipt-policy", {
    initialData: { nudgeAmount: PC_RECEIPT_NUDGE_DEFAULT },
    // The route returns the policy itself, not {data: …}.
    select: (json) => json as unknown as { nudgeAmount: number },
  });
  const nudgeAmount = policy.nudgeAmount;
  const [billsFor, setBillsFor] = useState<{ kind: "entry" | "request"; id: string; label: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [adminEntriesRes, issuedRes] = await Promise.all([
        fetch("/api/petty-cash/entries?status=pending_admin&limit=50"),
        fetch("/api/petty-cash/requests?status=issued&limit=10"),
      ]);
      const adminEntriesJson: PaginatedResponse<PettyCashEntry> = await adminEntriesRes.json();
      const issuedJson: PaginatedResponse<PettyCashRequest> = await issuedRes.json();
      setPendingAdminEntries(adminEntriesJson.data || []);
      setRecentlyIssued(issuedJson.data || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Build unified pending list
  const pendingItems: PendingItem[] = [
    ...pendingAdminEntries.map((e) => ({ kind: "entry_approval" as const, data: e })),
  ];

  // Entry approval dialog
  const [entryAction, setEntryAction] = useState<{ entry: PettyCashEntry; action: "approve" | "reject" } | null>(null);
  const [actionNote, setActionNote] = useState("");

  const [acting, setActing] = useState(false);

  const handleEntryAction = async () => {
    if (!entryAction) return;
    setActing(true);
    try {
      const res = await fetch(`/api/petty-cash/entries/${entryAction.entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: entryAction.action, note: actionNote || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      toast.success(`Expense ${entryAction.action === "approve" ? "approved" : "rejected"}`);
      setEntryAction(null);
      setActionNote("");
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setActing(false);
    }
  };

  function getRequestOwner(r: PettyCashRequest): string {
    const book = r.book as { owner?: { full_name: string } } | undefined;
    return book?.owner?.full_name || r.requester?.full_name || "Unknown";
  }

  function getEntryOwner(e: PettyCashEntry): string {
    const book = e.book as { owner?: { full_name: string } } | undefined;
    return book?.owner?.full_name || e.submitter?.full_name || "Unknown";
  }

  if (loading) {
    return <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded bg-muted" />)}</div>;
  }

  return (
    <div className="space-y-6">
      <p className="rounded-md bg-blue-50 text-blue-800 text-sm px-3 py-2">
        Approved petty cash <strong>fund requests</strong> are now paid from <a className="underline font-medium" href="/accounting?tab=vendor-payments">Vendor Payments</a> (top of the page, &quot;Petty cash fund requests&quot;). This tab is for second approvals of large expenses and for recent payments.
      </p>
      {/* Unified Pending Items */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-orange-500" />
            Action Required ({pendingItems.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pendingItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">All caught up — no pending items</p>
          ) : (
            <div className="space-y-3">
              {pendingItems.map((item) => {
                {
                  const e = item.data;
                  const cat = (e.category as { name: string } | null)?.name;
                  return (
                    <div key={`ent-${e.id}`} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">Approve Expense</Badge>
                          <p className="font-medium">{e.entry_number} — {getEntryOwner(e)}</p>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">{e.description}</p>
                        <div className="flex gap-2 mt-1">
                          {cat && <Badge variant="outline" className="text-xs">{cat}</Badge>}
                          <Badge variant="secondary" className={`text-xs ${PC_ENTRY_STATUS_COLORS[e.status]}`}>
                            {PC_ENTRY_STATUS_LABELS[e.status]}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="font-bold mr-1">₹{Number(e.amount).toLocaleString("en-IN")}</p>
                        <Button size="sm" variant="outline"
                          className={needsReceiptNudge(Number(e.amount), e.attachments?.length ?? 0, nudgeAmount) ? "border-amber-300 text-amber-800 bg-amber-50" : ""}
                          onClick={() => setBillsFor({ kind: "entry", id: e.id, label: e.entry_number })}>
                          <Paperclip className="h-3.5 w-3.5 mr-1" />{(e.attachments?.length ?? 0) > 0 ? `View bills (${e.attachments?.length})` : "No bill attached"}
                        </Button>
                        {user?.id && e.submitted_by === user.id ? (
                          <p className="text-xs text-muted-foreground max-w-[200px] text-right">You logged this expense, so someone else must approve or reject it.</p>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" className="text-green-700 border-green-300" onClick={() => setEntryAction({ entry: e, action: "approve" })}>
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" className="text-red-600 border-red-300" onClick={() => setEntryAction({ entry: e, action: "reject" })}>
                              Reject
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                }
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recently Issued */}
      {recentlyIssued.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Recently Issued ({recentlyIssued.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Request #</th>
                    <th className="pb-2 font-medium text-muted-foreground">Person</th>
                    <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Method</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Issued By</th>
                    <th className="pb-2 font-medium text-muted-foreground">Status</th>
                    <th className="pb-2 font-medium text-muted-foreground">Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {recentlyIssued.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 font-medium">{r.request_number}</td>
                      <td className="py-2">{getRequestOwner(r)}</td>
                      <td className="py-2">₹{Number(r.amount_requested).toLocaleString("en-IN")}</td>
                      <td className="py-2 hidden md:table-cell text-muted-foreground capitalize">
                        {r.issuance_method ? PC_ISSUANCE_METHOD_LABELS[r.issuance_method] || r.issuance_method : "—"}
                      </td>
                      <td className="py-2 hidden md:table-cell text-muted-foreground">
                        {r.issuer?.full_name || "—"}
                      </td>
                      <td className="py-2">
                        <Badge variant="secondary" className={`text-xs ${PC_REQUEST_STATUS_COLORS[r.status]}`}>
                          {PC_REQUEST_STATUS_LABELS[r.status]}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <Button size="sm" variant="outline" className="text-xs h-7"
                          onClick={() => setBillsFor({ kind: "request", id: r.id, label: r.request_number })}>
                          <Paperclip className="h-3 w-3 mr-1" />View / add proof
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Entry Approval Dialog */}
      <Dialog open={!!entryAction} onOpenChange={(open) => !open && setEntryAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {entryAction?.action === "approve" ? "Approve Expense" : "Reject Expense"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
            {entryAction?.action === "approve"
              ? "What happens next: this is the final approval. The amount is deducted from the person's balance."
              : "What happens next: the expense goes back to the person with your note. Nothing is deducted."}
          </p>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Textarea
                placeholder={entryAction?.action === "reject" ? "Reason for rejection..." : "Any comments..."}
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
              />
            </div>
            <Button onClick={handleEntryAction} disabled={acting} className="w-full">
              {acting ? "Processing..." : entryAction?.action === "approve" ? "Approve expense" : "Reject expense"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {billsFor && (
        <AttachmentDialog
          open
          onOpenChange={(o) => { if (!o) { setBillsFor(null); fetchData(); } }}
          title={billsFor.kind === "entry" ? `Bills for ${billsFor.label}` : `Proof of payment for ${billsFor.label}`}
          description={billsFor.kind === "entry"
            ? "What the person attached as proof of this expense."
            : "Screenshots or vouchers showing the cash was handed over."}
          target={billsFor.kind === "entry" ? { entryId: billsFor.id } : { requestId: billsFor.id }}
          kind={billsFor.kind === "entry" ? "receipt" : "payment_proof"}
          canAdd
          canRemove={() => true}
          addLabel={billsFor.kind === "entry" ? "Add a bill (photo or PDF)" : "Add proof (photo or PDF)"}
          emptyText={billsFor.kind === "entry" ? "No bill was attached to this expense." : "No proof of payment has been attached yet."}
        />
      )}
    </div>
  );
}
