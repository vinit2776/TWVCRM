"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Banknote, CheckCircle2, AlertCircle, Check, X } from "lucide-react";
import { toast } from "sonner";
import {
  PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS,
  PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS,
  PC_ISSUANCE_METHOD_LABELS,
} from "@/lib/constants";
import type { PettyCashRequest, PettyCashEntry, PaginatedResponse } from "@/types";

type PendingItem =
  | { kind: "request_issuance"; data: PettyCashRequest }
  | { kind: "entry_approval"; data: PettyCashEntry };

export function PettyCashIssuance() {
  const [awaitingIssuance, setAwaitingIssuance] = useState<PettyCashRequest[]>([]);
  const [pendingAdminEntries, setPendingAdminEntries] = useState<PettyCashEntry[]>([]);
  const [recentlyIssued, setRecentlyIssued] = useState<PettyCashRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [awaitingRes, adminEntriesRes, issuedRes] = await Promise.all([
        fetch("/api/petty-cash/requests?status=approved&limit=50"),
        fetch("/api/petty-cash/entries?status=pending_admin&limit=50"),
        fetch("/api/petty-cash/requests?status=issued&limit=10"),
      ]);
      const awaitingJson: PaginatedResponse<PettyCashRequest> = await awaitingRes.json();
      const adminEntriesJson: PaginatedResponse<PettyCashEntry> = await adminEntriesRes.json();
      const issuedJson: PaginatedResponse<PettyCashRequest> = await issuedRes.json();
      setAwaitingIssuance(awaitingJson.data || []);
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
    ...awaitingIssuance.map((r) => ({ kind: "request_issuance" as const, data: r })),
    ...pendingAdminEntries.map((e) => ({ kind: "entry_approval" as const, data: e })),
  ];

  // Issue dialog
  const [issueTarget, setIssueTarget] = useState<PettyCashRequest | null>(null);
  const [issuanceMethod, setIssuanceMethod] = useState("");
  const [issuanceRef, setIssuanceRef] = useState("");

  // Entry approval dialog
  const [entryAction, setEntryAction] = useState<{ entry: PettyCashEntry; action: "approve" | "reject" } | null>(null);
  const [actionNote, setActionNote] = useState("");

  const [acting, setActing] = useState(false);

  const handleIssue = async () => {
    if (!issueTarget || !issuanceMethod) {
      toast.error("Select an issuance method");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/petty-cash/requests/${issueTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "issue",
          issuance_method: issuanceMethod,
          issuance_reference: issuanceRef || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to issue");
      }
      toast.success(`Cash issued to ${getRequestOwner(issueTarget)}`);
      setIssueTarget(null);
      setIssuanceMethod("");
      setIssuanceRef("");
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue");
    } finally {
      setActing(false);
    }
  };

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

  function getRequestBalance(r: PettyCashRequest): number {
    const book = r.book as { current_balance?: number } | undefined;
    return Number(book?.current_balance || 0);
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
                if (item.kind === "request_issuance") {
                  const r = item.data;
                  return (
                    <div key={`req-${r.id}`} className="flex items-center justify-between border rounded-lg p-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">Issue Cash</Badge>
                          <p className="font-medium">{r.request_number} — {getRequestOwner(r)}</p>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">{r.purpose}</p>
                        <p className="text-xs text-muted-foreground">Balance: ₹{getRequestBalance(r).toLocaleString("en-IN")} · Requested: {new Date(r.created_at).toLocaleDateString("en-IN")}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <p className="text-lg font-bold">₹{Number(r.amount_requested).toLocaleString("en-IN")}</p>
                        <Button size="sm" onClick={() => setIssueTarget(r)}>Issue</Button>
                      </div>
                    </div>
                  );
                } else {
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
                        <Button size="sm" variant="outline" className="text-green-600" onClick={() => setEntryAction({ entry: e, action: "approve" })}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600" onClick={() => setEntryAction({ entry: e, action: "reject" })}>
                          <X className="h-4 w-4" />
                        </Button>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Issue Cash Dialog */}
      <Dialog open={!!issueTarget} onOpenChange={(open) => !open && setIssueTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue Cash — {issueTarget?.request_number}</DialogTitle>
          </DialogHeader>
          {issueTarget && (
            <div className="space-y-4 mt-2">
              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <p><strong>Person:</strong> {getRequestOwner(issueTarget)}</p>
                <p><strong>Amount:</strong> ₹{Number(issueTarget.amount_requested).toLocaleString("en-IN")}</p>
                <p><strong>Purpose:</strong> {issueTarget.purpose}</p>
              </div>
              <div className="space-y-2">
                <Label>Issuance Method</Label>
                <Select value={issuanceMethod} onValueChange={setIssuanceMethod}>
                  <SelectTrigger><SelectValue placeholder="Select method" /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(PC_ISSUANCE_METHOD_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Reference (optional)</Label>
                <Input
                  placeholder="Transaction ID, cheque number, etc."
                  value={issuanceRef}
                  onChange={(e) => setIssuanceRef(e.target.value)}
                />
              </div>
              <Button onClick={handleIssue} disabled={acting || !issuanceMethod} className="w-full">
                {acting ? "Processing..." : "Confirm Issuance"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Entry Approval Dialog */}
      <Dialog open={!!entryAction} onOpenChange={(open) => !open && setEntryAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {entryAction?.action === "approve" ? "Approve Expense" : "Reject Expense"}
            </DialogTitle>
          </DialogHeader>
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
              {acting ? "Processing..." : "Confirm"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
