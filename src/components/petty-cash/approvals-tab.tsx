"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
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
                        <Button size="sm" variant="outline" className="text-green-600" onClick={() => setActionDialog({ type: "approve_request", item: r })}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600" onClick={() => setActionDialog({ type: "reject_request", item: r })}>
                          <X className="h-4 w-4" />
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
                        <Button size="sm" variant="outline" className="text-green-600" onClick={() => setActionDialog({ type: "approve_entry", item: e })}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600" onClick={() => setActionDialog({ type: "reject_entry", item: e })}>
                          <X className="h-4 w-4" />
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
                placeholder={actionDialog?.type?.includes("reject") ? "Reason for rejection..." : "Any comments..."}
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
              />
            </div>
            {actionDialog?.type === "approve_request" && (
              <p className="text-xs text-muted-foreground">
                Once approved, this request will move to the Accounting menu for the accounts team to process the payment.
              </p>
            )}
            <Button onClick={handleAction} disabled={acting} className="w-full">
              {acting ? "Processing..." : "Confirm"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
