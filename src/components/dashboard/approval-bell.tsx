"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  XCircle,
  ClipboardCheck,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface ApprovalRequest {
  id: string;
  approval_type: string;
  entity_type: string;
  entity_id: string;
  entity_reference: string | null;
  requested_by: string;
  requested_at: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  status: string;
  acted_by: string | null;
  acted_at: string | null;
  rejection_reason: string | null;
  requester?: { id: string; full_name: string; email: string; role: string } | null;
}

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  escalation_reduction: "Escalation Reduction",
  escalation_waiver: "Escalation Waiver",
};

export function ApprovalBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/approval-requests?status=pending&limit=20");
      if (res.ok) {
        const json = await res.json();
        setApprovals(json.data || []);
      }
    } catch {
      // Silent
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {});

    // Poll every 60 seconds
    const interval = setInterval(fetchApprovals, 60_000);
    return () => clearInterval(interval);
  }, [fetchApprovals]);

  const pendingCount = approvals.length;

  const handleAction = async (id: string, action: "approve" | "reject") => {
    setActingOnId(id);
    try {
      const body: Record<string, string> = { action };
      if (action === "reject") {
        if (!rejectionReason.trim()) {
          toast.error("Please provide a rejection reason");
          setActingOnId(null);
          return;
        }
        body.rejection_reason = rejectionReason.trim();
      }

      const res = await fetch(`/api/approval-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        toast.success(json.message || `Request ${action}d`);
        setApprovals(prev => prev.filter(a => a.id !== id));
        setRejectingId(null);
        setRejectionReason("");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to ${action}`);
      }
    } catch {
      toast.error("Network error");
    }
    setActingOnId(null);
  };

  // Don't render the bell for roles that can't approve
  if (userRole && userRole !== "admin") return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Pending Approvals">
          <ClipboardCheck className="h-4 w-4" />
          {pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white ring-2 ring-background">
              {pendingCount > 9 ? "9+" : pendingCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <ClipboardCheck className="h-3.5 w-3.5 text-purple-600" />
            Pending Approvals
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => { setLoading(true); fetchApprovals().finally(() => setLoading(false)); }}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>

        <div className="max-h-[400px] overflow-y-auto">
          {pendingCount === 0 ? (
            <div className="px-4 py-8 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No pending approvals</p>
            </div>
          ) : (
            approvals.map((a) => {
              const meta = a.metadata || {};
              const isRejecting = rejectingId === a.id;

              return (
                <div
                  key={a.id}
                  className="border-b last:border-b-0 px-4 py-3 space-y-2 hover:bg-muted/30 transition-colors"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="bg-purple-100 text-purple-800 text-[10px] px-1.5 py-0">
                          {APPROVAL_TYPE_LABELS[a.approval_type] || a.approval_type}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{timeAgo(a.requested_at)}</span>
                      </div>
                      <button
                        className="text-sm font-medium text-primary hover:underline mt-0.5 text-left"
                        onClick={() => { setOpen(false); router.push(`/contracts/${a.entity_id}`); }}
                      >
                        {a.entity_reference || a.entity_id.slice(0, 8)}
                      </button>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>
                      <span className="font-medium text-foreground">
                        {(a.requester as { full_name?: string } | null)?.full_name || "Unknown"}
                      </span>
                      {" "}requested {a.approval_type === "escalation_waiver" ? "escalation waiver" : "escalation reduction"}
                    </p>
                    {meta.parent_escalation_percentage != null && (
                      <p>
                        Escalation: {String(meta.parent_escalation_percentage)}% → <span className="font-semibold text-foreground">{String(meta.proposed_escalation_percentage)}%</span>
                      </p>
                    )}
                    {meta.parent_subtotal != null && meta.proposed_subtotal != null && (
                      <p>
                        Rate: {formatCurrency(Number(meta.parent_subtotal))}/mo → <span className="font-semibold text-foreground">{formatCurrency(Number(meta.proposed_subtotal))}/mo</span>
                      </p>
                    )}
                    {meta.parent_contract_number ? (
                      <p className="text-[10px]">Renewal of {String(meta.parent_contract_number)}</p>
                    ) : null}
                  </div>

                  {/* Rejection reason input */}
                  {isRejecting && (
                    <Input
                      autoFocus
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      placeholder="Reason for rejection..."
                      className="h-7 text-xs"
                    />
                  )}

                  {/* Action buttons */}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 h-7 text-xs bg-green-600 hover:bg-green-700"
                      disabled={actingOnId === a.id}
                      onClick={() => handleAction(a.id, "approve")}
                    >
                      {actingOnId === a.id ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                      )}
                      Approve
                    </Button>
                    {isRejecting ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 h-7 text-xs"
                        disabled={actingOnId === a.id || !rejectionReason.trim()}
                        onClick={() => handleAction(a.id, "reject")}
                      >
                        {actingOnId === a.id ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <XCircle className="h-3 w-3 mr-1" />
                        )}
                        Confirm Reject
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-7 text-xs text-destructive hover:text-destructive"
                        onClick={() => { setRejectingId(a.id); setRejectionReason(""); }}
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Reject
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
