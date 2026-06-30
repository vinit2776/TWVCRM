"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { PauseCircle, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/utils";
import type { ContractBillingMoratorium, Contract } from "@/types";

interface Props {
  contract: Contract;
  currentUserRole: string;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending:  <Clock className="h-3.5 w-3.5" />,
  approved: <CheckCircle2 className="h-3.5 w-3.5" />,
  rejected: <XCircle className="h-3.5 w-3.5" />,
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending:  "secondary",
  approved: "default",
  rejected: "destructive",
};

function monthLabel(isoDate: string) {
  // "2025-07-01" → "July 2025"
  const [year, month] = isoDate.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

// Build list of selectable months: between contract start+1 and contract end-1
function selectableMonths(contract: Contract): string[] {
  const start = new Date(contract.start_date + "T00:00:00Z");
  const end   = new Date(contract.end_date   + "T00:00:00Z");

  // Advance start by 1 month (can't waive first month)
  const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  // Retreat end by 1 month (can't waive last month)
  const to   = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));

  const months: string[] = [];
  const cursor = new Date(from);
  while (cursor <= to) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}-01`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function ContractMoratoriumSection({ contract, currentUserRole }: Props) {
  const [moratoriums, setMoratoriums] = useState<ContractBillingMoratorium[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestOpen, setRequestOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState<ContractBillingMoratorium | null>(null);
  const [rejectOpen, setRejectOpen] = useState<ContractBillingMoratorium | null>(null);

  const [selectedMonth, setSelectedMonth] = useState("");
  const [reason, setReason] = useState("");
  const [authNote, setAuthNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canAuthorize = ["admin", "manager"].includes(currentUserRole);
  const available = selectableMonths(contract);
  const approvedCount = moratoriums.filter((m) => m.status === "approved").length;
  const maxReached = approvedCount >= 1;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/moratoriums`);
      if (res.ok) setMoratoriums(await res.json());
    } finally {
      setLoading(false);
    }
  }, [contract.id]);

  useEffect(() => { load(); }, [load]);

  async function handleRequest() {
    if (!selectedMonth || reason.trim().length < 10) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contract.id}/moratoriums`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moratorium_month: selectedMonth, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to submit request");
        return;
      }
      toast.success("Moratorium request submitted — pending approval");
      setRequestOpen(false);
      setSelectedMonth("");
      setReason("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(moratorium: ContractBillingMoratorium, action: "approve" | "reject") {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/contracts/${contract.id}/moratoriums/${moratorium.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, authorization_note: authNote.trim() || undefined }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to update moratorium");
        return;
      }
      toast.success(`Moratorium ${action === "approve" ? "approved" : "rejected"}`);
      setApproveOpen(null);
      setRejectOpen(null);
      setAuthNote("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  if (!["active", "renewal_in_progress"].includes(contract.status)) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PauseCircle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Billing Moratoriums</span>
          {moratoriums.some((m) => m.status === "pending") && (
            <Badge variant="secondary" className="text-xs">
              {moratoriums.filter((m) => m.status === "pending").length} pending
            </Badge>
          )}
        </div>
        {!maxReached && available.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRequestOpen(true)}
            className="h-7 text-xs"
          >
            Request Moratorium
          </Button>
        )}
        {maxReached && (
          <span className="text-xs text-muted-foreground">Max 1 moratorium used</span>
        )}
      </div>

      {loading && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}

      {!loading && moratoriums.length === 0 && (
        <p className="text-xs text-muted-foreground">No moratoriums on this contract.</p>
      )}

      {!loading && moratoriums.length > 0 && (
        <div className="space-y-2">
          {moratoriums.map((m) => (
            <div
              key={m.id}
              className="rounded-md border px-3 py-2.5 text-sm flex items-start justify-between gap-3"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={STATUS_VARIANT[m.status]}
                    className="text-xs gap-1 capitalize"
                  >
                    {STATUS_ICON[m.status]}
                    {m.status}
                  </Badge>
                  <span className="font-medium">{monthLabel(m.moratorium_month)}</span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{m.reason}</p>
                <p className="text-xs text-muted-foreground">
                  Requested by {m.requested_by_user?.full_name ?? "—"} on{" "}
                  {formatDate(m.requested_at)}
                  {m.authorized_by_user && (
                    <> · {m.status === "approved" ? "Approved" : "Rejected"} by{" "}
                    {m.authorized_by_user.full_name} on {formatDate(m.authorized_at!)}</>
                  )}
                </p>
                {m.authorization_note && (
                  <p className="text-xs italic text-muted-foreground">
                    Note: {m.authorization_note}
                  </p>
                )}
                {m.overridden_at && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Overridden — billing was generated anyway on {formatDate(m.overridden_at)}
                  </p>
                )}
              </div>

              {m.status === "pending" && canAuthorize && (
                <div className="flex gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setApproveOpen(m)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setRejectOpen(m)}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Request dialog */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request Billing Moratorium</DialogTitle>
            <DialogDescription>
              This waives rent for the selected month entirely. Charges are not
              deferred — they are forgiven. Requires admin or manager approval.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Month to waive</Label>
              <select
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              >
                <option value="">Select a month…</option>
                {available.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Reason for moratorium</Label>
              <Textarea
                placeholder="Explain the business reason (e.g. relocation delay, renovation works, management agreement)…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">Min. 10 characters</p>
            </div>
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              This is a true waiver — billing for this month is permanently skipped.
              The contract end date does not change and no settlement is created.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRequest}
              disabled={!selectedMonth || reason.trim().length < 10 || submitting}
            >
              {submitting ? "Submitting…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve dialog */}
      <Dialog open={!!approveOpen} onOpenChange={() => setApproveOpen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Approve Billing Moratorium</DialogTitle>
            <DialogDescription>
              Approving waives rent for{" "}
              <strong>{approveOpen ? monthLabel(approveOpen.moratorium_month) : ""}</strong>{" "}
              permanently. The billing cron will skip this month automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {approveOpen && (
              <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                <strong>Reason:</strong> {approveOpen.reason}
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Authorization note (optional)</Label>
              <Textarea
                placeholder="Any internal note for the record…"
                value={authNote}
                onChange={(e) => setAuthNote(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => approveOpen && handleAction(approveOpen, "approve")}
              disabled={submitting}
            >
              {submitting ? "Approving…" : "Approve & Waive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={!!rejectOpen} onOpenChange={() => setRejectOpen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Moratorium Request</DialogTitle>
            <DialogDescription>
              Billing will proceed normally for{" "}
              <strong>{rejectOpen ? monthLabel(rejectOpen.moratorium_month) : ""}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Reason for rejection (optional)</Label>
              <Textarea
                placeholder="Let the requester know why…"
                value={authNote}
                onChange={(e) => setAuthNote(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejectOpen && handleAction(rejectOpen, "reject")}
              disabled={submitting}
            >
              {submitting ? "Rejecting…" : "Reject Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
